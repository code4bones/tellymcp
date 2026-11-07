import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawn } from "node-pty";
import {
  capturePtyRange,
  ensurePtySession,
  sendPtyText,
  stopAllPtyTargets,
  subscribePtyTarget,
} from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

describe("PTY socket errors during shutdown", () => {
  let socket: EventEmitter;
  let target: string;
  let report: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    socket = new EventEmitter();
    const subscribe = (event: string, listener: (...args: unknown[]) => void) => {
      socket.on(event, listener);
      return { dispose: () => { socket.off(event, listener); } };
    };
    vi.mocked(spawn).mockReturnValue({
      on: socket.on.bind(socket),
      onData: (listener: (...args: unknown[]) => void) => subscribe("data", listener),
      onExit: (listener: (...args: unknown[]) => void) => subscribe("exit", listener),
      kill: vi.fn(),
      write: vi.fn(),
    } as unknown as ReturnType<typeof spawn>);
    report = vi.spyOn(console, "error").mockImplementation(() => {});
    target = ensurePtySession(
      { shell: "/bin/sh", cols: 80, rows: 24, scrollbackLines: 100 },
      { sessionId: "exit-errors" },
    );
  });

  afterEach(() => {
    stopAllPtyTargets();
    vi.restoreAllMocks();
  });

  it.each(["before", "after"])("handles read EIO %s exit without logging or losing the exit status", async (order) => {
    const onExit = vi.fn();
    subscribePtyTarget(target, { onExit });
    const eof = Object.assign(new Error("read EIO"), { code: "EIO", syscall: "read" });
    if (order === "before") socket.emit("error", eof);
    socket.emit("exit", { exitCode: 7, signal: 0 });
    if (order === "after") socket.emit("error", eof);
    expect(await capturePtyRange(target, "-20")).toContain("[pty exited code=7 signal=0]");
    expect(report).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 7, signal: 0 });
    expect(() => sendPtyText(target, "echo still running")).toThrow("unavailable");
  });

  it.each([
    { code: "EBADF", syscall: "read" },
    { code: "EIO", syscall: "write" },
  ])("still reports unexpected fd errors: $code/$syscall", (details) => {
    const error = Object.assign(new Error("fd failure"), details);
    socket.emit("error", error);
    expect(report).toHaveBeenCalledExactlyOnceWith("pty fd error", target, error);
  });
});
