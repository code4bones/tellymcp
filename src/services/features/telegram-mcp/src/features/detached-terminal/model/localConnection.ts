import net, { type Socket } from "node:net";
import {
  FrameDecoder,
  FrameType,
  LocalWriter,
  LOCAL_PROTOCOL_VERSION,
} from "./localProtocol";
import { ownerRecordSchema, type OwnerRecord } from "./localRegistry";

/** Reachability during stale recovery: any listener is ambiguous ownership. */
export function ownerSocketReachable(record: OwnerRecord): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.socketPath);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
        resolve(false);
      else reject(new Error("Cannot prove stale socket ownership"));
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error("Ambiguous owner socket timeout"));
    });
  });
}

/** Verify identity and readiness without acquiring control or starting services. */
export function connectOwner(
  record: OwnerRecord,
  timeoutMs = 1000,
): Promise<{
  socket: Socket;
  writer: LocalWriter;
  decoder: FrameDecoder;
  attached: boolean | null;
  ptyPid: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.socketPath);
    const writer = new LocalWriter(socket);
    const decoder = new FrameDecoder();
    const timer = setTimeout(
      () => fail(new Error("Owner handshake timeout")),
      timeoutMs,
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    socket.on("error", onError);
    const onClose = () => fail(new Error("Owner closed before ready"));
    socket.once("close", onClose);
    socket.once("connect", () => {
      try {
        writer.control({
          type: "hello",
          version: LOCAL_PROTOCOL_VERSION,
          instance: record.instance,
          clientUuid: record.clientUuid,
          sessionId: record.sessionId,
        });
      } catch {
        fail(new Error("Owner handshake write failed"));
      }
    });
    const onData = (data: Buffer) => {
      try {
        const frames = decoder.push(data);
        if (frames.length !== 1 || frames[0]?.type !== FrameType.Control)
          throw new Error("Unexpected owner handshake");
        const response = JSON.parse(
          frames[0].payload.toString("utf8"),
        ) as Record<string, unknown>;
        if (response.type !== "ready")
          throw new Error(String(response.code || "Owner not ready"));
        const { type: _type, ptyPid, attached, ...fields } = response;
        const verified = ownerRecordSchema.parse(fields);
        if (
          verified.instance !== record.instance ||
          verified.clientUuid !== record.clientUuid ||
          verified.sessionId !== record.sessionId ||
          verified.processStart !== record.processStart ||
          verified.pid !== record.pid
        )
          throw new Error("Owner identity mismatch");
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        // Retain a harmless socket error listener; consumers can add their own.
        socket.off("error", onError);
        socket.on("error", () => {});
        if (
          !Number.isSafeInteger(ptyPid) ||
          (ptyPid as number) <= 0 ||
          (attached !== undefined && typeof attached !== "boolean")
        )
          throw new Error("Invalid owner status");
        resolve({
          socket,
          writer,
          decoder,
          attached: attached === undefined ? null : (attached as boolean),
          ptyPid: ptyPid as number,
        });
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error("Invalid owner handshake"),
        );
      }
    };
    socket.on("data", onData);
  });
}
