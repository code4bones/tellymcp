import { describe, expect, it } from "vitest";
import { AttachmentInput } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/attachmentInput";
import { AttachmentOutput } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/attachmentOutput";
import { OuterModeProbe } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/outerTerminal";
import { validateRunOptions } from "../src/cliRuntimeOptions";

function frame(sequence: number, offset: number, last: number, data: Buffer) {
  const header = Buffer.alloc(13);
  header.writeBigUInt64BE(BigInt(sequence));
  header.writeUInt32BE(offset, 8);
  header[12] = last;
  return Buffer.concat([header, data]);
}

describe("native attachment input", () => {
  it("preserves Unicode, control keys, function keys and paste at every byte split", () => {
    const data = Buffer.from(
      "Привет 界😀\x03\x04\x1a\x1b[A\x1bOP\x1b[200~pasted\x1dd\x1d\x1d\x1b[201~\x1dx",
    );
    const expected = data;
    for (let split = 0; split <= data.length; split++) {
      const parser = new AttachmentInput();
      const results = [
        parser.push(data.subarray(0, split)),
        parser.push(data.subarray(split)),
      ];
      expect(Buffer.concat(results.map((r) => r.data))).toEqual(expected);
      expect(results.every((r) => !r.detach)).toBe(true);
    }
  });
  it("detaches on a split prefix+d, escapes doubled prefix and forwards lone Escape immediately", () => {
    const parser = new AttachmentInput();
    expect(parser.push(Buffer.from("\x1b")).data).toEqual(Buffer.from("\x1b"));
    expect(parser.push(Buffer.from("a\x1d\x1db\x1d")).data).toEqual(
      Buffer.from("a\x1db"),
    );
    expect(parser.push(Buffer.from("dtrailing"))).toEqual({
      data: Buffer.alloc(0),
      detach: true,
    });
    expect(parser.push(Buffer.from("never retry"))).toEqual({
      data: Buffer.alloc(0),
      detach: true,
    });
  });
});

describe("ordered output reassembly", () => {
  it("joins split UTF8 before rendering and advances empty query-only sequences", () => {
    const output = new AttachmentOutput(40),
      text = Buffer.from("界😀e\u0301");
    expect(output.push(frame(41, 0, 0, text.subarray(0, 2)))).toBeNull();
    expect(output.push(frame(41, 2, 1, text.subarray(2)))).toEqual(text);
    expect(output.push(frame(42, 0, 1, Buffer.alloc(0)))).toEqual(
      Buffer.alloc(0),
    );
    output.end();
  });
  it("rejects missing/duplicate sequences, wrong offsets and truncated final output", () => {
    expect(() =>
      new AttachmentOutput(1).push(frame(3, 0, 1, Buffer.from("bad"))),
    ).toThrow("mismatch");
    const parser = new AttachmentOutput(1);
    parser.push(frame(2, 0, 0, Buffer.from("x")));
    expect(() => parser.push(frame(2, 2, 1, Buffer.from("bad")))).toThrow(
      "mismatch",
    );
    expect(() => parser.end()).toThrow("Truncated");
    expect(() => new AttachmentOutput(1).push(Buffer.alloc(5))).toThrow(
      "Truncated",
    );
  });
});

describe("outer terminal query ownership", () => {
  it("captures modes and strips only its own split replies, including late replies", () => {
    const probe = new OuterModeProbe();
    const bytes = Buffer.from(
      "early界\x1b[?2004;1$y\x1bP1$r6 q\x1b\\\x1bP1$r0m\x1b\\\x1b[200~\x1b[?25;2$y\x1b[201~",
    );
    for (const byte of bytes) probe.push(Buffer.from([byte]));
    const result = probe.finish();
    expect(result.input).toEqual(
      Buffer.from("early界\x1b[200~\x1b[?25;2$y\x1b[201~"),
    );
    expect(result.restore).toContain("\x1b[?2004h");
    expect(result.restore).toContain("\x1b[6 q");
    expect(probe.filterInput(Buffer.from("\x1b[?25;"))).toEqual(
      Buffer.alloc(0),
    );
    expect(probe.filterInput(Buffer.from("2$yx"))).toEqual(Buffer.from("x"));
    expect(probe.restore).toContain("\x1b[?25l");
    expect(probe.filterInput(Buffer.from("\x1b"))).toEqual(Buffer.alloc(0));
    expect(probe.flushEscape()).toEqual(Buffer.from("\x1b"));
    expect(probe.filterInput(Buffer.from("\x1bP"))).toEqual(Buffer.alloc(0));
    expect(probe.flushEscape()).toEqual(Buffer.from("\x1bP"));
    expect(probe.filterInput(Buffer.from("\x1bPx"))).toEqual(
      Buffer.from("\x1bPx"),
    );
    expect(
      probe.filterInput(Buffer.from("\x1b[200~\x1bP\x1b[201~\x1b[?25;1$y")),
    ).toEqual(Buffer.from("\x1b[200~\x1bP\x1b[201~"));
  });
  it("bounds input during probing", () => {
    expect(() => new OuterModeProbe().push(Buffer.alloc(262145))).toThrow(
      "limit",
    );
  });
});

describe("public run flags", () => {
  it("accepts detached mode and the existing value flags in either form", () => {
    expect(
      validateRunOptions([
        "--detach",
        "--env=x",
        "--ws",
        "9999",
        "-s",
        "test",
        "--agent=codex",
      ]),
    ).toEqual({ detached: true });
    expect(validateRunOptions([])).toEqual({ detached: false });
  });
  it.each([
    ["--remote"],
    ["--detach", "--detach"],
    ["--agent"],
    ["--session=a", "-s", "b"],
    ["--env", "--detach"],
  ])("rejects ambiguous options %j", (...args) => {
    expect(() => validateRunOptions(args)).toThrow();
  });
});
