import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { startSessionOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/sessionOwner";
import {
  LocalRegistry,
  type OwnerSpec,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import type { TerminalRestorationPrototype } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";
import { TerminalRestorationPrototype as Stream } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";
import { connectOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localConnection";
import { FrameType } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localProtocol";

const dirs: string[] = [];
afterEach(() => {
  for (const root of dirs.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telly-life-"));
  dirs.push(root);
  const registry = new LocalRegistry(root);
  const spec: OwnerSpec = {
    cwd: root,
    envPath: path.join(root, "test.env"),
    packageRoot: process.cwd(),
    sessionId: "lifecycle",
    sessionLabel: "lifecycle",
    clientUuid: randomUUID(),
  };
  return { registry, spec, packageVersion: "test" };
}

it("delivers output produced after the snapshot even if the shell exits before the client ACK", async () => {
  const ctx = fixture();
  const owner = await startSessionOwner({
    ...ctx,
    createSession: async () => {
      const pty = spawn(
        "/bin/sh",
        ["-c", "sleep 0.25; printf LAST_BEFORE_ACK; exit 7"],
        { cols: 80, rows: 24, cwd: ctx.spec.cwd, env: { ...process.env } },
      );
      (
        pty as unknown as {
          on(event: string, fn: (error: NodeJS.ErrnoException) => void): void;
        }
      ).on("error", (error) => {
        if (error.code !== "EIO") throw error;
      });
      const stream = new Stream(pty, { cols: 80, rows: 24 });
      return {
        stream,
        stop: async () => {
          await stream.dispose();
        },
      };
    },
  });
  const connection = await connectOwner(owner.record);
  let output = "";
  let exitCode: unknown;
  connection.socket.on("data", (data) => {
    for (const frame of connection.decoder.push(data)) {
      if (frame.type === FrameType.Output)
        output += frame.payload.subarray(13).toString("utf8");
      if (frame.type === FrameType.Control) {
        const message = JSON.parse(frame.payload.toString("utf8")) as Record<
          string,
          unknown
        >;
        if (message.type === "exit") exitCode = message.exitCode;
      }
    }
  });
  try {
    connection.writer.control({ type: "attach", cols: 80, rows: 24 });
    expect(await owner.finished).toBe(7);
    expect(output).toContain("LAST_BEFORE_ACK");
    expect(exitCode).toBe(7);
  } finally {
    connection.socket.destroy();
    await owner.stop();
  }
});

it("releases only its claims/socket and signal listeners after startup failure", async () => {
  const ctx = fixture();
  const before = process.listenerCount("SIGHUP");
  await expect(
    startSessionOwner({
      ...ctx,
      createSession: async () => {
        throw new Error("injected start failure");
      },
    }),
  ).rejects.toThrow("injected start failure");
  expect(ctx.registry.find(ctx.spec)).toBeNull();
  expect(ctx.registry.list()).toEqual([]);
  expect(
    fs.readdirSync(ctx.registry.root).some((name) => name.startsWith("s-")),
  ).toBe(false);
  expect(process.listenerCount("SIGHUP")).toBe(before);
});

it("retains its exclusive startup claim until an in-flight factory has stopped", async () => {
  const ctx = fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.fn(async () => {});
  const pending = startSessionOwner({
    ...ctx,
    createSession: async () => {
      started();
      await ready;
      return {
        stop,
        stream: { status: {} } as unknown as TerminalRestorationPrototype,
      };
    },
  });
  // Observe the eventual rejection before deliberately interrupting startup.
  const rejected = expect(pending).rejects.toThrow("stopped during startup");
  await entered;
  process.emit("SIGTERM");
  expect(ctx.registry.find(ctx.spec)?.state).toBe("starting");
  expect(() =>
    ctx.registry.reserve(ctx.registry.createRecord(ctx.spec, "test")),
  ).toThrow("claimed");
  release();
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  expect(ctx.registry.find(ctx.spec)).toBeNull();
});
