import fs from "node:fs";
import net, { type Socket } from "node:net";

import type {
  PrototypeAttachment,
  TerminalRestorationPrototype,
} from "./terminalRestorationPrototype";
import {
  clientControlSchema,
  FrameDecoder,
  FrameType,
  LocalWriter,
  LOCAL_PROTOCOL_VERSION,
  type LocalFrame,
} from "./localProtocol";
import {
  LocalRegistry,
  type OwnerRecord,
  type OwnerSpec,
} from "./localRegistry";

export type OwnerSession = {
  stream: TerminalRestorationPrototype;
  stop(): Promise<void>;
};
export type OwnerHandle = {
  record: OwnerRecord;
  finished: Promise<number>;
  stop(code?: number): Promise<void>;
};

/** All process-wide runtime resources are created only after the exclusive claim. */
export async function startSessionOwner(input: {
  registry: LocalRegistry;
  spec: OwnerSpec;
  packageVersion: string;
  createSession(spec: OwnerSpec): Promise<OwnerSession>;
  log?: (event: string) => void;
}): Promise<OwnerHandle> {
  const { registry, spec } = input;
  const record = registry.createRecord(spec, input.packageVersion);
  registry.reserve(record);
  let session: OwnerSession | undefined;
  let creating: Promise<OwnerSession> | undefined;
  let listening: Promise<void> | undefined;
  let ready = false;
  let stopping: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const flushers = new Map<Socket, (final?: boolean) => void>();
  const writers = new Map<Socket, LocalWriter>();
  let resolveFinished!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    resolveFinished = resolve;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = net.createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const decoder = new FrameDecoder();
    const writer = new LocalWriter(socket);
    writers.set(socket, writer);
    let greeted = false;
    let attachment: PrototypeAttachment | undefined;
    let acknowledged = false;
    let closed = false;
    let pendingBytes = 0;
    let pendingFrames = 0;
    let chain = Promise.resolve();
    const endSocket = () => {
      writer.end();
      const deadline = setTimeout(() => socket.destroy(), 250);
      deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
    };
    const fail = (code: string) => {
      if (closed) return;
      attachment?.detach();
      attachment = undefined;
      try {
        writer.control({ type: "error", code });
        endSocket();
      } catch {
        socket.destroy();
      }
      closed = true;
    };
    socket.setTimeout(10000, () => {
      if (!greeted || (attachment && !acknowledged)) fail("HANDSHAKE_TIMEOUT");
    });
    socket.on("error", () => {
      socket.destroy();
    }); // A broken frontend owns no runtime resources.
    socket.on("end", () => {
      try {
        decoder.end();
      } catch {
        fail("TRUNCATED_FRAME");
      }
      socket.end();
    });
    socket.on("close", () => {
      closed = true;
      attachment?.detach();
      sockets.delete(socket);
      flushers.delete(socket);
      writers.delete(socket);
    });

    const handle = async (frame: LocalFrame) => {
      if (closed) return;
      if (frame.type === FrameType.Input) {
        if (!greeted || !acknowledged || !attachment)
          throw new Error("INPUT_NOT_READY");
        attachment.write(frame.payload);
        return;
      }
      if (frame.type !== FrameType.Control)
        throw new Error("INVALID_FRAME_TYPE");
      const parsed = clientControlSchema.safeParse(
        JSON.parse(frame.payload.toString("utf8")),
      );
      if (!parsed.success) throw new Error("INVALID_CONTROL");
      const message = parsed.data;
      if (message.type === "hello") {
        if (greeted) throw new Error("DUPLICATE_HELLO");
        if (message.version !== LOCAL_PROTOCOL_VERSION)
          throw new Error("PROTOCOL_MISMATCH");
        if (
          message.instance !== record.instance ||
          message.clientUuid !== record.clientUuid ||
          message.sessionId !== record.sessionId
        )
          throw new Error("OWNER_MISMATCH");
        if (!ready || !session) throw new Error("NOT_READY");
        greeted = true;
        writer.control({
          type: "ready",
          ...record,
          ptyPid: session.stream.status.pid,
          attached: session.stream.status.attached,
        });
        return;
      }
      if (!greeted || !session || !ready) throw new Error("HELLO_REQUIRED");
      if (message.type === "attach") {
        if (attachment) throw new Error("ALREADY_ATTACHED");
        attachment = await session.stream.attach(message.cols, message.rows);
        if (closed) {
          attachment.detach();
          attachment = undefined;
          return;
        }
        const { ansi, ...snapshot } = attachment.snapshot;
        writer.control({
          type: "snapshot_begin",
          ...snapshot,
          instance: record.instance,
          bytes: Buffer.byteLength(ansi),
        });
        writer.data(FrameType.Snapshot, Buffer.from(ansi));
        writer.control({
          type: "snapshot_end",
          instance: record.instance,
          generation: snapshot.generation,
          sequence: snapshot.sequence,
        });
      } else if (message.type === "ack") {
        if (
          !attachment ||
          message.generation !== attachment.snapshot.generation ||
          message.sequence !== attachment.snapshot.sequence
        )
          throw new Error("SNAPSHOT_ACK_MISMATCH");
        attachment.acknowledge();
        acknowledged = true;
        socket.setTimeout(0);
      } else if (message.type === "resize") {
        if (!acknowledged || !attachment) throw new Error("INPUT_NOT_READY");
        await attachment.resize(message.cols, message.rows);
      } else if (message.type === "detach") {
        attachment?.detach();
        attachment = undefined;
        acknowledged = false;
        writer.control({ type: "detached" });
        endSocket();
      } else if (message.type === "stop") {
        writer.control({ type: "stopping" });
        // Do not join the owner's shutdown from this connection's command queue.
        void stop(0);
      }
    };
    socket.on("data", (data) => {
      if (closed) return;
      try {
        for (const frame of decoder.push(data)) {
          pendingBytes += frame.payload.length;
          pendingFrames++;
          if (pendingBytes > 262144 || pendingFrames > 256)
            throw new Error("INPUT_QUEUE_OVERFLOW");
          chain = chain
            .then(() => handle(frame))
            .catch((error: unknown) => {
              const code =
                error instanceof Error && /^[A-Z_]+$/u.test(error.message)
                  ? error.message
                  : "REQUEST_REJECTED";
              fail(code);
            })
            .finally(() => {
              pendingBytes -= frame.payload.length;
              pendingFrames--;
            });
        }
      } catch {
        fail("INVALID_FRAME");
      }
    });
    flushers.set(socket, (final = false) => {
      if (!attachment || (!acknowledged && !final) || closed) return;
      try {
        if (final && !acknowledged) attachment.acknowledge();
        for (const frame of attachment.drain()) {
          if (frame.resize) {
            const { ansi, ...size } = frame.resize;
            writer.control({
              type: "viewport_begin",
              sequence: frame.sequence,
              instance: record.instance,
              bytes: Buffer.byteLength(ansi),
              ...size,
            });
            writer.data(FrameType.Snapshot, Buffer.from(ansi));
            writer.control({
              type: "viewport_end",
              sequence: frame.sequence,
              instance: record.instance,
            });
          } else writer.output(frame.sequence, Buffer.from(frame.data));
        }
      } catch {
        fail("ATTACHMENT_EXPIRED");
      }
    });
  });
  // A server fd failure is an owner failure; ordinary socket failures are local.
  server.on("error", () => {
    if (ready) void stop(1);
  });
  const ignoreHangup = () => {
    input.log?.("sighup_ignored");
  };
  const onTerm = () => {
    void stop(143);
  };
  const onInt = () => {
    void stop(130);
  };
  const stop = (code = 0): Promise<void> => {
    if (stopping) return stopping;
    ready = false;
    stopping = (async () => {
      if (timer) clearInterval(timer);
      for (const flush of flushers.values()) flush(true);
      for (const socket of sockets) {
        try {
          const writer = writers.get(socket)!;
          writer.control({ type: "exit", exitCode: code });
          writer.end();
        } catch {
          socket.destroy();
        }
      }
      await listening?.catch(() => {});
      const closeServer = new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      });
      // Give final bounded socket writes a short chance; no frontend can hold shutdown open.
      const reaper = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 250);
      reaper.unref();
      try {
        const created = session ?? (await creating);
        await created?.stop();
      } catch {
        code = code || 1;
      }
      await closeServer;
      clearTimeout(reaper);
      registry.release(record);
      process.off("SIGHUP", ignoreHangup);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      input.log?.("owner_stopped");
      resolveFinished(code);
    })();
    // A cleanup error must still resolve the lifecycle and release only this owner's paths.
    void stopping.catch(() => {
      resolveFinished(1);
    });
    return stopping;
  };
  process.on("SIGHUP", ignoreHangup);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(record.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await listening;
    if (stopping) {
      await stopping;
      throw new Error("Owner stopped before startup");
    }
    fs.chmodSync(record.socketPath, 0o600);
    creating = input.createSession(spec);
    session = await creating;
    if (stopping) {
      await stopping;
      throw new Error("Owner stopped during startup");
    }
    if (session.stream.status.exit || session.stream.status.failure)
      throw new Error("PTY failed during startup");
    ready = true;
    registry.publish(record);
    input.log?.("owner_ready");
    timer = setInterval(() => {
      for (const flush of flushers.values()) flush();
      if (session?.stream.status.exit)
        void stop(session.stream.status.exit.exitCode);
      else if (session?.stream.status.failure) void stop(1);
    }, 10);
    return { record, finished, stop };
  } catch (error) {
    await stop(1);
    throw error;
  }
}
