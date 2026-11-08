import { z } from "zod";

export const snapshotBeginSchema = z
  .object({
    type: z.literal("snapshot_begin"),
    instance: z.uuid(),
    generation: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(500),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
  })
  .strict();
export type SnapshotBegin = z.infer<typeof snapshotBeginSchema>;
export const viewportBeginSchema = snapshotBeginSchema
  .omit({ generation: true })
  .extend({ type: z.literal("viewport_begin") });
export type ViewportBegin = z.infer<typeof viewportBeginSchema>;

/** Reassemble before rendering: no UTF-8 decoding at socket or chunk boundaries. */
export class AttachmentOutput {
  private sequence: number;
  private offset = 0;
  private chunks: Buffer[] = [];
  constructor(boundary: number) {
    this.sequence = boundary;
  }
  push(payload: Buffer): Buffer | null {
    if (payload.length < 13) throw new Error("Truncated output frame");
    const sequence = payload.readBigUInt64BE();
    const offset = payload.readUInt32BE(8);
    const final = payload[12];
    if (
      sequence !== BigInt(this.sequence + 1) ||
      offset !== this.offset ||
      (final !== 0 && final !== 1)
    )
      throw new Error(
        "Output sequence/offset mismatch; attach again for a fresh snapshot",
      );
    const data = payload.subarray(13);
    this.offset += data.length;
    if (this.offset > 4 * 1024 * 1024)
      throw new Error("Attachment output limit exceeded");
    this.chunks.push(data);
    if (!final) return null;
    const result = Buffer.concat(this.chunks, this.offset);
    this.chunks = [];
    this.offset = 0;
    this.sequence++;
    return result;
  }
  end(): void {
    if (this.chunks.length) throw new Error("Truncated output sequence");
  }
  advance(sequence: number): void {
    this.end();
    if (sequence !== this.sequence + 1)
      throw new Error("Viewport sequence mismatch");
    this.sequence = sequence;
  }
}
