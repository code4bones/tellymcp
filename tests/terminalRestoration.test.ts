import { EventEmitter } from "node:events";

import type { IPty } from "node-pty";
import * as XtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalRestorationPrototype } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";
import { serializeTerminalState } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalSnapshot";
import {
  isTerminalQuery,
  VtOutput,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/vtOutput";

type Terminal = InstanceType<typeof XtermHeadless.Terminal>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function terminal(cols = 24, rows = 6): Terminal {
  const term = new XtermHeadless.Terminal({
    cols,
    rows,
    scrollback: 50,
    allowProposedApi: true,
  });
  cleanup.push(() => term.dispose());
  return term;
}
const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));
function state(term: Terminal) {
  const buffers = [term.buffer.normal, term.buffer.alternate];
  return {
    active: term.buffer.active.type,
    buffers: buffers.map((buffer) => ({
      cursor: [buffer.cursorX, buffer.cursorY],
      lines: Array.from({ length: buffer.length }, (_, y) => {
        const line = buffer.getLine(y)!;
        return {
          wrapped: line.isWrapped,
          cells: Array.from({ length: line.length }, (_, x) => {
            const cell = line.getCell(x)!;
            return [
              cell.getChars(),
              cell.getWidth(),
              cell.getFgColorMode(),
              cell.getFgColor(),
              cell.getBgColorMode(),
              cell.getBgColor(),
              cell.isBold(),
              cell.isItalic(),
              cell.isUnderline(),
              cell.isInverse(),
              cell.isInvisible(),
              cell.isDim(),
              cell.isStrikethrough(),
            ];
          }),
        };
      }),
    })),
    modes: { ...term.modes },
    cursorStyle: term.options.cursorStyle,
    cursorBlink: term.options.cursorBlink,
  };
}
async function snapshot(source: Terminal): Promise<Terminal> {
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const restored = terminal(source.cols, source.rows);
  // Simulate a terminal left in arbitrary modes by a previous attachment.
  await write(restored, "old screen\x1b[?1003h\x1b[?2004h\x1b[?7l");
  await write(restored, serializeTerminalState(source, addon));
  return restored;
}
function fakePty() {
  const events = new EventEmitter();
  const subscribe = (event: string, listener: (...args: never[]) => void) => {
    events.on(event, listener);
    return {
      dispose: () => {
        events.off(event, listener);
      },
    };
  };
  const pty = {
    pid: 12345,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (listener: (...args: never[]) => void) =>
      subscribe("data", listener),
    onExit: (listener: (...args: never[]) => void) =>
      subscribe("exit", listener),
  } as unknown as IPty;
  return { pty, events };
}
function owner(options: { maxQueueBytes?: number } = {}) {
  const fake = fakePty();
  const model = new TerminalRestorationPrototype(fake.pty, {
    cols: 24,
    rows: 6,
    scrollback: 50,
    ...options,
  });
  cleanup.push(() => model.dispose());
  return { ...fake, model };
}

describe("terminal snapshot fidelity (xterm 5.5 + serialize 0.13)", () => {
  it.each([false, true])(
    "preserves REP across the boundary (insert=%s)",
    async (insert) => {
      const source = terminal();
      await write(
        source,
        "0123456789\x1b[1;3H" + (insert ? "\x1b[4h" : "") + "X",
      );
      const restored = await snapshot(source);
      expect(state(restored)).toEqual(state(source));
      await write(source, "\x1b[3b");
      await write(restored, "\x1b[3b");
      expect(state(restored)).toEqual(state(source));
    },
  );

  it.each([false, true])(
    "restores cells, styles, cursor, buffers and modes (alternate=%s), including subsequent output",
    async (alternate) => {
      const source = terminal();
      await write(
        source,
        "normal\r\n\x1b[1;3;4;38;2;19;83;121;48;5;25mПривет 界 e\u0301 😀\x1b[0m\r\n",
      );
      if (alternate)
        await write(source, "\x1b[?1049h\x1b[Halternate\r\n\x1b[32mgreen");
      await write(
        source,
        "\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[5 q",
      );
      const restored = await snapshot(source);
      expect(state(restored)).toEqual(state(source));
      const replies: string[] = [];
      restored.onData((data) => replies.push(data));
      await write(restored, "\x1b[?1006$p\x1b[?25$p");
      expect(replies).toEqual(["\x1b[?1006;1$y", "\x1b[?25;2$y"]);
      for (const tail of [
        "Z\r\nnext",
        ...(alternate ? ["\x1b[?1049l", "normal again"] : []),
      ]) {
        await write(source, tail);
        await write(restored, tail);
        expect(state(restored)).toEqual(state(source));
      }
    },
  );

  it("preserves normal and alternate scroll regions and origin mode", async () => {
    const source = terminal();
    await write(
      source,
      "normal\x1b[2;5r\x1b[3;4H\x1b[?1049h\x1b[Halt\x1b[2;4r\x1b[?6h\x1b[2;3H",
    );
    const restored = await snapshot(source);
    expect(state(restored)).toEqual(state(source));
    for (const tail of [
      "\r\n1\r\n2\r\n3",
      "\x1b[?6l\x1b[?1049l",
      "\r\n4\r\n5\r\n6",
    ]) {
      await write(source, tail);
      await write(restored, tail);
      expect(state(restored)).toEqual(state(source));
    }
  });

  it("preserves pending wrap and bounded scrollback", async () => {
    const source = terminal(12, 4);
    await write(
      source,
      Array.from({ length: 70 }, (_, i) => `line ${i}\r\n`).join("") +
        "123456789012",
    );
    const restored = await snapshot(source);
    expect(state(restored)).toEqual(state(source));
    await write(source, "界next");
    await write(restored, "界next");
    expect(state(restored)).toEqual(state(source));
  });

  it.each([false, true])(
    "restores saved cursor/attributes, custom tab stops and DEC graphics (alternate=%s)",
    async (alternate) => {
      const source = terminal();
      if (alternate) await write(source, "normal\x1b[?1049h\x1b[H");
      await write(
        source,
        "\x1b[3g\x1b[1;5H\x1bH\x1b[2;7H\x1b[1;35m\x1b(0\x1b7\x1b(B\x1b[0m\x1b[4;2Hnow",
      );
      const restored = await snapshot(source);
      for (const tail of [
        "\x1b8qqq",
        "\x1b(B\x1b[1;1H\tX",
        "\x1b)0\x0eq\x0f",
      ]) {
        await write(source, tail);
        await write(restored, tail);
        expect(state(restored)).toEqual(state(source));
      }
    },
  );

  it("restores an active DEC character set and pending wrap inside a custom scroll region", async () => {
    const source = terminal(12, 6);
    await write(source, "\x1b[2;5r\x1b[3;1H\x1b(0qqqqqqqqqqqq");
    const restored = await snapshot(source);
    expect(state(restored)).toEqual(state(source));
    await write(source, "qq");
    await write(restored, "qq");
    expect(state(restored)).toEqual(state(source));
  });
});

describe("ordered restoration and query ownership", () => {
  it("matches an uninterrupted reference through a resize and hundreds of writes arriving during attach", async () => {
    const { model, events } = owner();
    const reference = terminal();
    const before = "before\r\n".repeat(20);
    events.emit("data", before);
    await write(reference, before);
    const pending = model.attach(32, 8);
    reference.resize(32, 8);
    const chunks = Array.from(
      { length: 250 },
      (_, i) => `\x1b[${30 + (i % 8)}m${i}:界😀e\u0301\x1b[0m\r\n`,
    );
    for (const chunk of chunks) events.emit("data", chunk);
    const attached = await pending;
    attached.acknowledge();
    await model.settled();
    const display = terminal(32, 8);
    await write(display, attached.snapshot.ansi);
    const frames = attached.drain();
    expect(frames.map((frame) => frame.sequence)).toEqual(
      chunks.map((_, i) => attached.snapshot.sequence + i + 1),
    );
    for (const chunk of chunks) await write(reference, chunk);
    for (const frame of frames) await write(display, frame.data);
    expect(state(display)).toEqual(state(reference));
  });

  it("reserves one controller, orders prior writes/snapshot/live, ACKs input and rejects stale handles", async () => {
    const { model, events, pty } = owner();
    events.emit("data", "before\r\n");
    const pending = model.attach(24, 6);
    await expect(model.attach(24, 6)).rejects.toThrow("already attached");
    events.emit("data", "after\r\n");
    const attached = await pending;
    expect(() => attached.write("premature")).toThrow("acknowledged");
    expect(() => attached.drain()).toThrow("acknowledged");
    await model.settled();
    attached.acknowledge();
    const frames = attached.drain();
    expect(frames).toEqual([
      { sequence: attached.snapshot.sequence + 1, data: "after\r\n" },
    ]);
    expect(attached.drain()).toEqual([]);
    const display = terminal();
    await write(
      display,
      attached.snapshot.ansi + frames.map((f) => f.data).join(""),
    );
    const fresh = await snapshot(display);
    expect(state(fresh)).toEqual(state(display));
    const utf8 = Buffer.from("Привет 😀\r");
    for (const byte of utf8) attached.write(Buffer.from([byte]));
    expect(
      vi
        .mocked(pty.write)
        .mock.calls.map(([data]) => data)
        .join(""),
    ).toBe("Привет 😀\r");
    attached.detach();
    expect(() => attached.write("stale")).toThrow("expired");
    const next = await model.attach(32, 8);
    expect(next.snapshot.generation).toBe(attached.snapshot.generation + 1);
    expect(next.snapshot.instance).toBe(attached.snapshot.instance);
    expect(model.status.pid).toBe(12345);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("retains incomplete VT and Unicode across a snapshot and sends each supported query reply once", async () => {
    const { model, events, pty } = owner();
    events.emit("data", "hello\x1b[38;2;");
    const attached = await model.attach(24, 6);
    const display = terminal();
    const displayReplies = vi.fn();
    display.onData(displayReplies);
    await write(display, attached.snapshot.ansi);
    attached.acknowledge();
    const queries =
      "\x1b[5n\x1b[6n\x1b[?6n\x1b[c\x1b[>c\x1b[?2004$p\x1bP$qr\x1b\\\x1b[18t\x1b]11;?\x07";
    const output = "1;2;3m界 e\u0301 😀\x1b[0m" + queries + "end";
    for (const char of output.split("")) events.emit("data", char);
    await model.settled();
    const frames = attached.drain();
    for (const frame of frames) await write(display, frame.data);
    expect(displayReplies).not.toHaveBeenCalled();
    const replies = vi.mocked(pty.write).mock.calls.map(([data]) => data);
    expect(replies).toHaveLength(9);
    expect(replies.filter((v) => v === "\x1b[0n")).toHaveLength(1);
    expect(replies).toContain("\x1b[8;6;24t");
    expect(replies).toContain("\x1b]11;rgb:0000/0000/0000\x1b\\");
    attached.detach();
    events.emit("data", "\x1b[5n");
    await model.settled();
    const next = await model.attach(24, 6);
    await write(display, next.snapshot.ansi);
    expect(displayReplies).not.toHaveBeenCalled();
    expect(
      vi.mocked(pty.write).mock.calls.filter(([data]) => data === "\x1b[0n"),
    ).toHaveLength(2);
    expect(
      state(display)
        .buffers[0]?.lines.map((line) =>
          line.cells.map((cell) => cell[0]).join(""),
        )
        .join("\n"),
    ).toContain("hello界 e\u0301 😀end");
  });

  it("reports actual SGR and never replays earlier terminal side effects", async () => {
    const { model, events, pty } = owner();
    events.emit(
      "data",
      "\x1b[1;38;2;4;5;6mstyled\x1bP$qm\x1b\\\x1b]52;c;c2VjcmV0\x07\x07",
    );
    await model.settled();
    expect(pty.write).toHaveBeenCalledExactlyOnceWith(
      "\x1bP1$r0;1;38;2;4;5;6m\x1b\\",
    );
    const attached = await model.attach(24, 6);
    expect(attached.snapshot.ansi).not.toContain("\x1b]52");
    expect(attached.snapshot.ansi).not.toContain("\x07");
    expect(attached.snapshot.ansi).not.toContain("\x1bP$q");
  });

  it("drops only a slow attachment and permits a fresh snapshot", async () => {
    const { model, events, pty } = owner({ maxQueueBytes: 1024 });
    const attached = await model.attach(24, 6);
    events.emit("data", "x".repeat(1100));
    await model.settled();
    expect(() => attached.acknowledge()).toThrow("expired");
    const fresh = await model.attach(24, 6);
    fresh.acknowledge();
    fresh.write("still alive");
    expect(pty.write).toHaveBeenCalledWith("still alive");
    expect(model.status.failure).toBeUndefined();
  });

  it("serializes resize, reports actual exit, and never kills the caller's PTY", async () => {
    const { model, events, pty } = owner();
    const attached = await model.attach(24, 6);
    attached.acknowledge();
    await attached.resize(40, 10);
    expect(pty.resize).toHaveBeenLastCalledWith(40, 10);
    events.emit("data", "\x1b[18t");
    await model.settled();
    expect(pty.write).toHaveBeenCalledWith("\x1b[8;10;40t");
    attached.drain();
    events.emit("data", "last output\r\n");
    events.emit("exit", { exitCode: 7, signal: 0 });
    await model.settled();
    expect(
      attached
        .drain()
        .map((frame) => frame.data)
        .join(""),
    ).toBe("last output\r\n");
    expect(model.status.exit).toEqual({ exitCode: 7, signal: 0 });
    expect(() => attached.write("dead")).toThrow("exited: 7");
    await model.dispose();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(events.listenerCount("data")).toBe(0);
  });

  it("fails closed on oversized controls and parser backlog without unhandled rejections", async () => {
    const { model, events } = owner();
    events.emit("data", "\x1b]" + "x".repeat(65537));
    await expect(model.settled()).rejects.toThrow("VT control exceeds");
    const second = owner({ maxQueueBytes: 1024 });
    second.events.emit("data", "x".repeat(5000));
    await expect(second.model.settled()).rejects.toThrow(
      "parser queue overflow",
    );
  });
});

describe("VT query framing", () => {
  it("is invariant to every single split, including C1, OSC/DCS terminators, CAN and surrogate pairs", () => {
    const stream =
      "text😀\x1b[31mred\x1b[6n\x1b]0;title\x07\x1bP$qm\x1b\\\x9b5n\x1b[12\x18X\x1b(0qq\x1b(B\x1b]11;?\x1b\\end";
    const baseline = new VtOutput()
      .push(stream)
      .filter((v) => !isTerminalQuery(v))
      .map((v) => v.data)
      .join("");
    for (let split = 0; split <= stream.length; split++) {
      const parser = new VtOutput();
      const tokens = [
        ...parser.push(stream.slice(0, split)),
        ...parser.push(stream.slice(split)),
      ];
      expect(tokens.map((v) => v.data).join(""), `split=${split}`).toBe(stream);
      expect(
        tokens
          .filter((v) => !isTerminalQuery(v))
          .map((v) => v.data)
          .join(""),
      ).toBe(baseline);
    }
  });
});
