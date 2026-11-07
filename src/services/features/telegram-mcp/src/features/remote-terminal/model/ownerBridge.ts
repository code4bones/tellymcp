import type WebSocket from "ws";
import type { Socket } from "node:net";
import {
  LocalRegistry,
  processStartIdentity,
} from "../../detached-terminal/model/localRegistry";
import { connectOwner } from "../../detached-terminal/model/localConnection";
import {
  clientControlSchema,
  encodeFrame,
  FrameDecoder,
  FrameType,
} from "../../detached-terminal/model/localProtocol";
import {
  readTerminalMessage,
  relayBytes,
  RELAY_CHUNK_BYTES,
  sendTerminalMessage,
  type TerminalMessage,
} from "./remoteProtocol";

type Attachment = { socket?: Socket; decoder: FrameDecoder; expires: number };

/** Gateway transport loses control by destroying a local attachment, never its owner. */
export class TerminalOwnerBridge {
  private readonly attachments = new Map<string, Attachment>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  constructor(
    private readonly transport: WebSocket,
    private readonly options: {
      registry?: LocalRegistry;
      ownerPid?: number;
      leaseMs?: number;
    } = {},
  ) {
    this.timer = setInterval(
      () => {
        for (const [id, attachment] of this.attachments)
          if (attachment.expires <= Date.now()) this.end(id);
      },
      Math.min(1000, options.leaseMs ?? 30000),
    );
    this.timer.unref();
  }
  private record(clientUuid: string, sessionId: string) {
    const record = (this.options.registry ?? new LocalRegistry())
      .list()
      .find(
        (value) =>
          value.pid === (this.options.ownerPid ?? process.pid) &&
          value.clientUuid === clientUuid &&
          value.sessionId === sessionId &&
          processStartIdentity(value.pid) === value.processStart,
      );
    if (!record) throw new Error("OWNER_UNAVAILABLE");
    return record;
  }
  private send(message: TerminalMessage) {
    sendTerminalMessage(this.transport, message);
  }
  private end(id: string, notify = true) {
    const attachment = this.attachments.get(id);
    this.attachments.delete(id);
    attachment?.socket?.destroy();
    if (notify && attachment && this.transport.readyState === 1) {
      try {
        this.send({ type: "terminal_end", id });
      } catch {
        /* transport already lost */
      }
    }
  }
  async handle(raw: unknown): Promise<boolean> {
    const message = readTerminalMessage(raw);
    if (!message) return false;
    if (this.closed) return true;
    try {
      if (message.type === "terminal_describe") {
        const record = this.record(message.clientUuid, message.sessionId);
        this.send({
          type: "terminal_described",
          id: message.id,
          instance: record.instance,
        });
      } else if (message.type === "terminal_open") {
        if (this.attachments.has(message.id) || this.attachments.size >= 16)
          throw new Error("ATTACH_LIMIT");
        const record = this.record(message.clientUuid, message.sessionId);
        if (record.instance !== message.instance)
          throw new Error("OWNER_CHANGED");
        const attachment: Attachment = {
          decoder: new FrameDecoder(),
          expires: Date.now() + (this.options.leaseMs ?? 30000),
        };
        this.attachments.set(message.id, attachment);
        const connection = await connectOwner(record);
        if (this.closed || this.attachments.get(message.id) !== attachment) {
          connection.socket.destroy();
          return true;
        }
        attachment.socket = connection.socket;
        const sendData = (data: Buffer) => {
          try {
            for (
              let offset = 0;
              offset < data.length;
              offset += RELAY_CHUNK_BYTES
            )
              this.send({
                type: "terminal_data",
                id: message.id,
                data: data
                  .subarray(offset, offset + RELAY_CHUNK_BYTES)
                  .toString("base64"),
              });
          } catch {
            this.end(message.id);
          }
        };
        connection.socket.on("data", sendData);
        connection.socket.on("error", () => this.end(message.id));
        connection.socket.on("end", () => this.end(message.id));
        connection.socket.on("close", () => this.end(message.id));
        this.send({
          type: "terminal_ready",
          id: message.id,
          instance: record.instance,
        });
      } else if (message.type === "terminal_data") {
        const attachment = this.attachments.get(message.id);
        if (!attachment?.socket || attachment.expires <= Date.now())
          throw new Error("ATTACH_EXPIRED");
        for (const frame of attachment.decoder.push(relayBytes(message.data))) {
          if (frame.type === FrameType.Control) {
            const control = clientControlSchema.parse(
              JSON.parse(frame.payload.toString("utf8")),
            );
            if (control.type === "hello" || control.type === "stop")
              throw new Error("ATTACH_SCOPE_DENIED");
          } else if (frame.type !== FrameType.Input)
            throw new Error("ATTACH_SCOPE_DENIED");
          if (attachment.socket.writableLength > 1024 * 1024)
            throw new Error("ATTACH_BACKPRESSURE");
          attachment.socket.write(encodeFrame(frame.type, frame.payload));
        }
      } else if (message.type === "terminal_keepalive") {
        const attachment = this.attachments.get(message.id);
        if (attachment && attachment.expires > Date.now())
          attachment.expires = Date.now() + (this.options.leaseMs ?? 30000);
        else this.end(message.id);
      } else if (message.type === "terminal_end") this.end(message.id, false);
    } catch {
      this.end(message.id, false);
      try {
        this.send({
          type: "terminal_error",
          id: message.id,
          code: "ATTACH_UNAVAILABLE",
        });
      } catch {
        /* lost gateway */
      }
    }
    return true;
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of this.attachments.keys()) this.end(id, false);
  }
}
