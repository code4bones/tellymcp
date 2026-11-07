import type { Duplex } from "node:stream";
import { z } from "zod";

export const LOCAL_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 65536;
export const FrameType = {
  Control: 1,
  Input: 2,
  Output: 3,
  Snapshot: 4,
} as const;
export type LocalFrame = { type: number; payload: Buffer };

const dimension = z.number().int().min(2).max(500);
export const clientControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      version: z.number().int(),
      instance: z.uuid(),
      clientUuid: z.uuid(),
      sessionId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({ type: z.literal("attach"), cols: dimension, rows: dimension })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      generation: z.number().int().positive(),
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ type: z.literal("resize"), cols: dimension, rows: dimension })
    .strict(),
  z.object({ type: z.literal("detach") }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
]);
export type ClientControl = z.infer<typeof clientControlSchema>;

export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (![1, 2, 3, 4].includes(type) || payload.length > MAX_FRAME_BYTES)
    throw new Error("Invalid local frame");
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): LocalFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: LocalFrame[] = [];
    let offset = 0;
    while (this.pending.length - offset >= 5) {
      const type = this.pending[offset]!;
      const length = this.pending.readUInt32BE(offset + 1);
      if (![1, 2, 3, 4].includes(type) || length > MAX_FRAME_BYTES)
        throw new Error("Invalid local frame header");
      if (this.pending.length - offset < length + 5) break;
      frames.push({
        type,
        payload: this.pending.subarray(offset + 5, offset + 5 + length),
      });
      offset += length + 5;
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return frames;
  }
  end(): void {
    if (this.pending.length) throw new Error("Truncated local frame");
  }
}

/** All writes pass through one bounded socket queue; no unbounded promises on drain. */
export class LocalWriter {
  private queue: Buffer[] = [];
  private bytes = 0;
  private blocked = false;
  private ending = false;
  constructor(
    private readonly socket: Duplex,
    private readonly limit = 5 * 1024 * 1024,
  ) {
    socket.on("drain", () => {
      this.blocked = false;
      this.flush();
    });
    socket.on("close", () => {
      this.queue = [];
      this.bytes = 0;
    });
  }
  control(value: Record<string, unknown>): void {
    this.send(FrameType.Control, Buffer.from(JSON.stringify(value)));
  }
  send(type: number, payload: Buffer): void {
    const frame = encodeFrame(type, payload);
    if (this.socket.destroyed || this.socket.writableEnded)
      throw new Error("Local socket closed");
    if (
      this.bytes + this.socket.writableLength + frame.length > this.limit ||
      this.queue.length >= 4096
    ) {
      this.socket.destroy();
      throw new Error("Local output queue overflow");
    }
    this.queue.push(frame);
    this.bytes += frame.length;
    this.flush();
  }
  data(type: number, data: Buffer): void {
    for (let offset = 0; offset < data.length; offset += 32768)
      this.send(type, data.subarray(offset, offset + 32768));
  }
  output(sequence: number, data: Buffer): void {
    for (
      let offset = 0;
      offset === 0 || offset < data.length;
      offset += 32768
    ) {
      const chunk = data.subarray(offset, offset + 32768);
      const header = Buffer.alloc(13);
      header.writeBigUInt64BE(BigInt(sequence));
      header.writeUInt32BE(offset, 8);
      header[12] = offset + chunk.length === data.length ? 1 : 0;
      this.send(FrameType.Output, Buffer.concat([header, chunk]));
      if (!data.length) break;
    }
  }
  end(): void {
    this.ending = true;
    this.flush();
  }
  private flush(): void {
    while (!this.blocked && this.queue.length && !this.socket.destroyed) {
      const frame = this.queue.shift()!;
      this.bytes -= frame.length;
      if (!this.socket.write(frame)) this.blocked = true;
    }
    if (
      this.ending &&
      !this.blocked &&
      !this.queue.length &&
      !this.socket.destroyed
    )
      this.socket.end();
  }
}
