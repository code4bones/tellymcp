import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import * as XtermHeadless from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeViewport } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/nativeViewport";
import {
  TerminalRestorationPrototype,
  type PrototypeAttachment,
  type RestorationFrame,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";

type Terminal = InstanceType<typeof XtermHeadless.Terminal>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const write = (terminal: Terminal, data: string | Buffer) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
function terminal(cols: number, rows: number) {
  const t = new XtermHeadless.Terminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
  });
  cleanup.push(() => t.dispose());
  return t;
}
function source() {
  const events = new EventEmitter();
  const pty = {
    pid: 1234,
    write: vi.fn(),
    resize: vi.fn(),
    onData: (fn: (data: string) => void) => {
      events.on("data", fn);
      return { dispose: () => events.off("data", fn) };
    },
    onExit: (fn: () => void) => {
      events.on("exit", fn);
      return { dispose: () => events.off("exit", fn) };
    },
  } as unknown as IPty;
  const model = new TerminalRestorationPrototype(pty, {
    cols: 80,
    rows: 24,
    scrollback: 100,
  });
  cleanup.push(() => model.dispose());
  return { model, pty, events };
}
function cells(t: Terminal, cols: number, rows: number) {
  const b = t.buffer.active;
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => {
      const c = b.getLine(b.baseY + y)?.getCell(x);
      return c
        ? [
            c.getChars() || " ",
            c.getWidth(),
            c.getFgColor(),
            c.getBgColor(),
            c.isBold(),
            c.isInverse(),
          ]
        : null;
    }),
  );
}
function expectView(
  display: Terminal,
  reference: Terminal,
  cols: number,
  rows: number,
) {
  const actual = cells(display, cols, rows),
    expected = cells(reference, cols, rows);
  let difference: unknown;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      if (
        !difference &&
        JSON.stringify(actual[y][x]) !== JSON.stringify(expected[y][x])
      )
        difference = {
          row: y,
          column: x,
          actual: actual[y][x],
          expected: expected[y][x],
        };
    }
  expect(difference).toBeUndefined();
}
async function apply(
  frames: RestorationFrame[],
  viewport: NativeViewport,
  display: Terminal,
  reference?: Terminal,
) {
  for (const frame of frames) {
    if (frame.resize) {
      reference?.resize(frame.resize.cols, frame.resize.rows);
      if (reference) await write(reference, frame.resize.ansi);
      await write(
        display,
        await viewport.restore(
          frame.resize.cols,
          frame.resize.rows,
          frame.resize.ansi,
        ),
      );
    } else {
      if (reference) await write(reference, frame.data);
      await write(display, await viewport.write(frame.data));
    }
  }
}
function viewer(
  attached: PrototypeAttachment,
  physical: { cols: number; rows: number },
) {
  const viewport = new NativeViewport(
    attached.snapshot.cols,
    attached.snapshot.rows,
    () => physical,
  );
  cleanup.push(() => viewport.dispose());
  const display = terminal(physical.cols, physical.rows);
  return { viewport, display, physical };
}

describe("shared native viewport", () => {
  it("bounds simultaneous clients and releases just one slot on detach", async () => {
    const { model, pty } = source();
    const peers: PrototypeAttachment[] = [];
    for (let i = 0; i < 8; i++) {
      const peer = await model.attach(80, 24);
      peer.acknowledge();
      peers.push(peer);
    }
    await expect(model.attach(80, 24)).rejects.toThrow("ATTACHMENT_LIMIT");
    peers[0].detach();
    const next = await model.attach(80, 24);
    next.acknowledge();
    next.write("new slot");
    peers[1].write("existing peer");
    expect(pty.write).toHaveBeenCalledWith("new slot");
    expect(pty.write).toHaveBeenCalledWith("existing peer");
    for (const peer of peers) peer.detach();
    next.detach();
  });
  it.each([false, true])(
    "keeps different-size terminals identical through scrolling, Unicode, modes and resize (alt=%s)",
    async (alternate) => {
      const { model, events, pty } = source();
      events.emit(
        "data",
        "history one\r\nhistory two\r\n" +
          (alternate ? "\x1b[?1049h" : "") +
          "\x1b[31mHello 界😀\x1b[0m\r\n" +
          "abcdef".repeat(30),
      );
      await model.settled();
      const a = await model.attach(80, 24);
      a.acknowledge();
      const av = viewer(a, { cols: 80, rows: 24 });
      await write(av.display, await av.viewport.write(a.snapshot.ansi));
      const b = await model.attach(40, 10);
      b.acknowledge();
      const bv = viewer(b, { cols: 40, rows: 10 });
      await write(bv.display, await bv.viewport.write(b.snapshot.ansi));
      const reference = terminal(40, 10);
      await write(reference, b.snapshot.ansi);
      await apply(a.drain(), av.viewport, av.display);
      expectView(av.display, reference, 40, 10);
      expectView(bv.display, reference, 40, 10);
      expect(av.display.buffer.active.type).toBe(reference.buffer.active.type);
      for (let i = 0; i < 12; i++) {
        events.emit(
          "data",
          `\r\n\x1b[1;3${i % 8}mrow-${i} 界😀 ${"long".repeat(14)}\x1b[0m`,
        );
        await model.settled();
        await apply(b.drain(), bv.viewport, bv.display, reference);
        await apply(a.drain(), av.viewport, av.display);
        expectView(av.display, reference, 40, 10);
        expectView(bv.display, reference, 40, 10);
      }
      a.write("from A\r");
      b.write("from B\r");
      expect(pty.write).toHaveBeenCalledWith("from A\r");
      expect(pty.write).toHaveBeenCalledWith("from B\r");
      av.physical.cols = 100;
      av.physical.rows = 30;
      av.display.resize(100, 30);
      await a.resize(100, 30);
      await apply(b.drain(), bv.viewport, bv.display, reference);
      await apply(a.drain(), av.viewport, av.display);
      expect(pty.resize).toHaveBeenLastCalledWith(100, 30);
      expectView(av.display, reference, 100, 30);
      expectView(bv.display, reference, 40, 10);
      // Live participates in the same last-resize-wins policy.
      await model.resize(65, 16);
      await apply(b.drain(), bv.viewport, bv.display, reference);
      await apply(a.drain(), av.viewport, av.display);
      expect(pty.resize).toHaveBeenLastCalledWith(65, 16);
      expectView(av.display, reference, 65, 16);
      expectView(bv.display, reference, 40, 10);
      b.detach();
      await model.settled();
      expect(a.drain()).toEqual([]); // Disconnect never changes the shared size.
      await a.resize(100, 30);
      await apply(a.drain(), av.viewport, av.display, reference);
      expect(pty.resize).toHaveBeenLastCalledWith(100, 30);
      expectView(av.display, reference, 100, 30);
      expect(av.display.buffer.active.cursorY).toBe(
        reference.buffer.active.cursorY,
      );
      expect(av.display.buffer.active.type).toBe(reference.buffer.active.type);
      a.detach();
    },
  );

  it("drops only a lagging client while another continues reading and writing", async () => {
    const events = new EventEmitter();
    const pty = {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      onData: (fn: (data: string) => void) => {
        events.on("data", fn);
        return { dispose: () => events.off("data", fn) };
      },
      onExit: () => ({ dispose() {} }),
    } as unknown as IPty;
    const model = new TerminalRestorationPrototype(pty, {
      cols: 80,
      rows: 24,
      maxQueueBytes: 1024,
    });
    cleanup.push(() => model.dispose());
    const fast = await model.attach(80, 24),
      slow = await model.attach(80, 24);
    fast.acknowledge();
    slow.acknowledge();
    for (let i = 0; i < 3; i++) {
      events.emit("data", "x".repeat(600));
      await model.settled();
      expect(fast.drain().length).toBeGreaterThan(0);
    }
    expect(() => slow.drain()).toThrow("expired");
    fast.write("still running");
    expect(pty.write).toHaveBeenCalledWith("still running");
    expect(model.status.failure).toBeUndefined();
    fast.detach();
  });
});
