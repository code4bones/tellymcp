import type { ReadStream, WriteStream } from "node:tty";
import { connectOwner } from "./localConnection";
import { FrameType, type LocalFrame } from "./localProtocol";
import type { OwnerRecord } from "./localRegistry";
import { AttachmentInput } from "./attachmentInput";
import {
  AttachmentOutput,
  snapshotBeginSchema,
  type SnapshotBegin,
} from "./attachmentOutput";
import {
  OUTER_MODE_QUERY,
  OuterModeProbe,
  prepareOuterTerminal,
} from "./outerTerminal";

export function requireInteractiveTerminal(
  stdin: Pick<ReadStream, "isTTY"> = process.stdin,
  stdout: Pick<WriteStream, "isTTY"> = process.stdout,
): void {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(
      "Attach requires an interactive TTY. Use run --detach to start in the background.",
    );
}
function dimensions(stdout: WriteStream) {
  const cols = stdout.columns || 80,
    rows = stdout.rows || 24;
  if (![cols, rows].every((v) => Number.isInteger(v) && v >= 2 && v <= 500))
    throw new Error("Terminal dimensions must be between 2 and 500");
  return { cols, rows };
}

/** Thin native frontend: this process owns no shell, broker, provider or bridge. */
export async function attachTerminal(
  record: OwnerRecord,
  io: {
    stdin?: ReadStream & { fd: number };
    stdout?: WriteStream;
    probeMs?: number;
  } = {},
): Promise<{ exitCode: number; detached: boolean }> {
  const stdin = io.stdin ?? process.stdin,
    stdout = io.stdout ?? process.stdout;
  requireInteractiveTerminal(stdin, stdout);
  const requested = dimensions(stdout);
  const { socket, writer, decoder } = await connectOwner(record);
  let finished = false,
    detaching = false,
    peerEnded = false;
  let streaming = false,
    probing = false;
  let outer: ReturnType<typeof prepareOuterTerminal> | undefined;
  const probe = new OuterModeProbe(),
    input = new AttachmentInput();
  let snapshot: SnapshotBegin | undefined,
    bytes = 0,
    chunks: Buffer[] = [];
  let output: AttachmentOutput | undefined;
  let pendingBytes = 0,
    pendingFrames = 0;
  let chain = Promise.resolve();
  let detachDeadline: ReturnType<typeof setTimeout> | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const wasFlowing = stdin.readableFlowing === true;
  let resolveResult!: (value: { exitCode: number; detached: boolean }) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ exitCode: number; detached: boolean }>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  const write = (data: Buffer | string) =>
    new Promise<void>((resolve, reject) => {
      stdout.write(data, (error) => (error ? reject(error) : resolve()));
    });
  const finish = (exitCode: number, detached: boolean, error?: unknown) => {
    if (finished) return;
    finished = true;
    streaming = false;
    if (detachDeadline) clearTimeout(detachDeadline);
    if (escapeTimer) clearTimeout(escapeTimer);
    socket.destroy();
    stdin.off("data", onInput);
    stdin.off("end", onEof);
    stdin.off("error", onInputError);
    stdout.off("resize", onResize);
    process.off("SIGHUP", onHup);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    try {
      outer?.restore();
    } catch (restoreError) {
      error ??= restoreError;
    }
    if (!wasFlowing) stdin.pause();
    // TTY errors from a final restore write are delivered on the next tick.
    setImmediate(() => {
      stdout.off("error", onOutputError);
    });
    if (error)
      rejectResult(error instanceof Error ? error : new Error(String(error)));
    else resolveResult({ exitCode, detached });
  };
  const detach = (code = 0) => {
    if (finished || detaching) return;
    detaching = true;
    streaming = false;
    try {
      writer.control({ type: "detach" });
      writer.end();
    } catch {
      finish(code, true);
      return;
    }
    detachDeadline = setTimeout(() => finish(code, true), 500);
  };
  const sendInput = (data: Buffer) => {
    if (finished || detaching || !streaming) return;
    const parsed = input.push(data);
    for (let offset = 0; offset < parsed.data.length; offset += 16384)
      writer.send(
        FrameType.Input,
        parsed.data.subarray(offset, offset + 16384),
      );
    if (parsed.detach) detach();
  };
  const onInput = (data: Buffer | string) => {
    if (finished) return;
    try {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (probing) probe.push(raw);
      else if (streaming) {
        const filtered = probe.filterInput(raw);
        outer?.restoreModes(probe.restore);
        sendInput(filtered);
        scheduleEscape();
      }
    } catch (error) {
      finish(1, false, error);
    }
  };
  const scheduleEscape = () => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      try {
        sendInput(probe.flushEscape());
      } catch (error) {
        finish(1, false, error);
      }
    }, 50);
  };
  const onEof = () => detach();
  const onInputError = (error: Error) => finish(1, false, error);
  const onOutputError = (error: Error) => finish(1, false, error);
  const onResize = () => {
    if (!streaming || finished || detaching) return;
    try {
      writer.control({ type: "resize", ...dimensions(stdout) });
    } catch (error) {
      finish(1, false, error);
    }
  };
  const onHup = () => finish(129, true);
  const onTerm = () => finish(143, true);
  const onInt = () => finish(130, true);

  const handle = async (frame: LocalFrame) => {
    if (finished || detaching) return;
    if (frame.type === FrameType.Snapshot) {
      if (!snapshot || output) throw new Error("Unexpected snapshot data");
      bytes += frame.payload.length;
      if (bytes > snapshot.bytes) throw new Error("Snapshot size mismatch");
      chunks.push(frame.payload);
      return;
    }
    if (frame.type === FrameType.Output) {
      if (!output) throw new Error("Output before snapshot");
      const data = output.push(frame.payload);
      if (data?.length) await write(data);
      return;
    }
    if (frame.type !== FrameType.Control)
      throw new Error("Unexpected owner frame");
    const message = JSON.parse(frame.payload.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (message.type === "snapshot_begin") {
      if (snapshot) throw new Error("Duplicate snapshot");
      snapshot = snapshotBeginSchema.parse(message);
      if (
        snapshot.instance !== record.instance ||
        snapshot.cols !== requested.cols ||
        snapshot.rows !== requested.rows
      )
        throw new Error("Snapshot owner/dimension mismatch");
    } else if (message.type === "snapshot_end") {
      if (
        !snapshot ||
        output ||
        message.instance !== record.instance ||
        message.generation !== snapshot.generation ||
        message.sequence !== snapshot.sequence ||
        bytes !== snapshot.bytes
      )
        throw new Error("Invalid snapshot boundary");
      outer = prepareOuterTerminal(stdin, stdout);
      probing = true;
      stdin.on("data", onInput);
      stdin.resume();
      await write(OUTER_MODE_QUERY);
      await new Promise((resolve) => setTimeout(resolve, io.probeMs ?? 150));
      if (finished) return;
      const initial = probe.finish();
      outer.restoreModes(initial.restore);
      await write(Buffer.concat(chunks, bytes));
      chunks = [];
      if (finished) return;
      output = new AttachmentOutput(snapshot.sequence);
      probing = false;
      if (!peerEnded && !socket.destroyed && !socket.writableEnded) {
        writer.control({
          type: "ack",
          generation: snapshot.generation,
          sequence: snapshot.sequence,
        });
        streaming = true;
        onResize();
        sendInput(initial.input);
        scheduleEscape();
      }
    } else if (message.type === "exit") {
      if (
        !Number.isSafeInteger(message.exitCode) ||
        (message.exitCode as number) < 0 ||
        (message.exitCode as number) > 255
      )
        throw new Error("Invalid owner exit status");
      output?.end();
      finish(message.exitCode as number, false);
    } else if (message.type === "error") {
      throw new Error(
        message.code === "CONTROLLER_BUSY"
          ? "Session already has an interactive controller; detach it before attaching here."
          : "Attachment rejected: " + String(message.code),
      );
    } else throw new Error("Unexpected owner control");
  };
  stdout.on("error", onOutputError);
  stdout.on("resize", onResize);
  stdin.on("end", onEof);
  stdin.on("error", onInputError);
  process.on("SIGHUP", onHup);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  socket.on("error", (error) => finish(1, false, error));
  socket.on("data", (chunk) => {
    if (finished) return;
    try {
      for (const frame of decoder.push(chunk)) {
        pendingBytes += frame.payload.length;
        pendingFrames++;
        if (pendingBytes > 5 * 1024 * 1024 || pendingFrames > 4096)
          throw new Error("Attachment rendering queue overflow");
        if (pendingBytes > 524288) socket.pause();
        chain = chain
          .then(() => handle(frame))
          .catch((error: unknown) => finish(1, false, error))
          .finally(() => {
            pendingBytes -= frame.payload.length;
            pendingFrames--;
            if (pendingBytes < 262144 && !finished) socket.resume();
          });
      }
    } catch (error) {
      finish(1, false, error);
    }
  });
  socket.on("end", () => {
    peerEnded = true;
    void chain.then(() => {
      if (finished) return;
      try {
        decoder.end();
        output?.end();
      } catch (error) {
        finish(1, false, error);
        return;
      }
      finish(
        detaching ? 0 : 1,
        detaching,
        detaching
          ? undefined
          : new Error(
              "Owner connection closed; session may still be running. Attach again.",
            ),
      );
    });
  });
  socket.on("close", () => {
    if (!peerEnded && !finished)
      void chain.then(() =>
        finish(
          detaching ? 0 : 1,
          detaching,
          detaching
            ? undefined
            : new Error("Owner connection lost; attach again."),
        ),
      );
  });
  try {
    writer.control({ type: "attach", ...requested });
  } catch (error) {
    finish(1, false, error);
  }
  return result;
}
