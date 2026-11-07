import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  FrameType,
  LocalWriter,
  encodeFrame,
  MAX_FRAME_BYTES,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localProtocol";

describe("private owner framing", () => {
  it("decodes split headers, split UTF8 and coalesced arbitrary VT/binary payloads", () => {
    const data = Buffer.from("Привет 界😀\r\n\x1b[6n\x00");
    const encoded = Buffer.concat([
      encodeFrame(FrameType.Input, data),
      encodeFrame(FrameType.Control, Buffer.from('{"type":"detach"}')),
    ]);
    for (let split = 0; split <= encoded.length; split++) {
      const decoder = new FrameDecoder();
      const frames = [
        ...decoder.push(encoded.subarray(0, split)),
        ...decoder.push(encoded.subarray(split)),
      ];
      expect(frames).toEqual([
        { type: FrameType.Input, payload: data },
        { type: FrameType.Control, payload: Buffer.from('{"type":"detach"}') },
      ]);
      decoder.end();
    }
  });
  it("rejects oversized/unknown headers and EOF halfway through a frame", () => {
    const header = Buffer.alloc(5);
    header[0] = FrameType.Input;
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
    expect(() => new FrameDecoder().push(header)).toThrow("header");
    header[0] = 99;
    header.writeUInt32BE(1, 1);
    expect(() => new FrameDecoder().push(header)).toThrow("header");
    const decoder = new FrameDecoder();
    decoder.push(Buffer.from([1, 0]));
    expect(() => decoder.end()).toThrow("Truncated");
  });
  it("bounds slow-socket writes and drains final control frames in FIFO order", () => {
    const events = new EventEmitter();
    const written: Buffer[] = [];
    let slow = true;
    let ended = false;
    let destroyed = false;
    const socket = Object.assign(events, {
      writableLength: 0,
      writableEnded: false,
      destroyed: false,
      write: (data: Buffer) => {
        written.push(data);
        return !slow;
      },
      end: () => {
        ended = true;
      },
      destroy: () => {
        destroyed = true;
      },
    }) as unknown as Socket;
    const writer = new LocalWriter(socket, 150);
    writer.control({ type: "first" });
    writer.control({ type: "exit" });
    writer.end();
    expect(ended).toBe(false);
    expect(written).toHaveLength(1);
    slow = false;
    events.emit("drain");
    expect(written).toHaveLength(2);
    expect(ended).toBe(true);
    slow = true;
    writer.send(FrameType.Output, Buffer.alloc(50));
    writer.send(FrameType.Output, Buffer.alloc(50));
    expect(() => writer.send(FrameType.Output, Buffer.alloc(101))).toThrow(
      "overflow",
    );
    expect(destroyed).toBe(true);
  });
});
