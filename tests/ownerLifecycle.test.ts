import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { startSessionOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/sessionOwner";
import {
  LocalRegistry,
  type OwnerSpec,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import type { TerminalRestorationPrototype } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";

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
