import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn as spawnPty } from "node-pty";

import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRegistry,
  processStartIdentity,
  type OwnerSpec,
  type OwnerRecord,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import { launchSessionOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/ownerLauncher";
import {
  connectOwner,
  ownerSocketReachable,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localConnection";
import {
  FrameType,
  FrameDecoder,
  LocalWriter,
  type LocalFrame,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localProtocol";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await tick();
  }
}
function context() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telly-owner-"));
  fs.chmodSync(root, 0o700);
  cleanups.push(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd, { mode: 0o700 });
  const envPath = path.join(cwd, "test.env");
  fs.writeFileSync(envPath, "SECRET_DO_NOT_PUBLISH=private\n", { mode: 0o600 });
  const spec: OwnerSpec = {
    cwd,
    envPath,
    packageRoot: process.cwd(),
    clientUuid: randomUUID(),
    sessionId: "test",
    sessionLabel: "test",
  };
  return { root, spec, registry: new LocalRegistry(root) };
}
async function start(ctx: ReturnType<typeof context>) {
  const record = await launchSessionOwner({
    ...ctx,
    entryArgs: [
      "--import",
      require.resolve("tsx"),
      path.resolve("tests/fixtures/sessionOwner.mjs"),
    ],
    timeoutMs: 10000,
  });
  cleanups.push(async () => {
    if (processStartIdentity(record.pid) !== record.processStart) return;
    try {
      const connection = await connectOwner(record);
      connection.writer.control({ type: "stop" });
      connection.socket.end();
    } catch {
      process.kill(record.pid, "SIGTERM");
    }
    await waitFor(
      () => processStartIdentity(record.pid) !== record.processStart,
      "owner cleanup",
    );
  });
  return record;
}
async function attach(record: OwnerRecord) {
  const connection = await connectOwner(record);
  cleanups.push(() => connection.socket.destroy());
  const controls: Array<Record<string, unknown>> = [];
  const snapshots: Buffer[] = [];
  const frames: LocalFrame[] = [];
  connection.socket.on("data", (chunk) => {
    for (const frame of connection.decoder.push(chunk)) {
      if (frame.type === FrameType.Control)
        controls.push(
          JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>,
        );
      else if (frame.type === FrameType.Snapshot) snapshots.push(frame.payload);
      else frames.push(frame);
    }
  });
  connection.writer.control({ type: "attach", cols: 80, rows: 24 });
  await waitFor(
    () =>
      controls.some((v) => v.type === "snapshot_end") ||
      controls.some((v) => v.type === "error"),
    "snapshot",
  );
  const boundary = controls.find((v) => v.type === "snapshot_begin");
  if (boundary)
    connection.writer.control({
      type: "ack",
      generation: boundary.generation,
      sequence: boundary.sequence,
    });
  const text = () =>
    frames
      .filter((f) => f.type === FrameType.Output)
      .map((f) => f.payload.subarray(13).toString("utf8"))
      .join("");
  return { ...connection, controls, snapshots, frames, boundary, text };
}

describe("private registry", () => {
  it("discovers and connects to protocol1 owners without treating them as stale", async () => {
    const ctx = context();
    const record = ctx.registry.createRecord(ctx.spec, "0.0.44");
    record.protocol = 1;
    ctx.registry.reserve(record);
    ctx.registry.publish(record);
    let requestedVersion: unknown;
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder(),
        writer = new LocalWriter(socket);
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          const message = JSON.parse(frame.payload.toString());
          requestedVersion = message.version;
          writer.control({
            type: "ready",
            ...record,
            state: "ready",
            ptyPid: 1234,
            attached: true,
          });
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(record.socketPath, resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const connection = await connectOwner({ ...record, state: "ready" });
    connection.socket.destroy();
    expect(requestedVersion).toBe(1);
    expect(ctx.registry.list()).toHaveLength(1);
    expect(ctx.registry.list()[0]?.protocol).toBe(1);
  });
  it("rejects symlink/public registries and stores no env contents", () => {
    const ctx = context();
    const publicDir = path.join(ctx.root, "public");
    fs.mkdirSync(publicDir, { mode: 0o755 });
    expect(() => new LocalRegistry(publicDir)).toThrow("permissions");
    const link = path.join(ctx.root, "link");
    fs.symlinkSync(ctx.root, link);
    expect(() => new LocalRegistry(link)).toThrow("permissions");
    const record = ctx.registry.createRecord(ctx.spec, "test");
    ctx.registry.reserve(record);
    ctx.registry.publish(record);
    expect(ctx.registry.list()).toEqual([record]);
    for (const name of fs
      .readdirSync(ctx.root)
      .filter((v) => v.endsWith(".json"))) {
      const file = path.join(ctx.root, name);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, "utf8")).not.toContain(
        "SECRET_DO_NOT_PUBLISH",
      );
    }
    ctx.registry.release(record);
    expect(ctx.registry.list()).toEqual([]);
  });
  it("recovers a reused PID only after socket probing and rechecks claims under the lock", async () => {
    const ctx = context();
    const record = ctx.registry.createRecord(ctx.spec, "test");
    record.processStart = "old-boot:123";
    ctx.registry.reserve(record);
    expect(await ctx.registry.recover(record, async () => true)).toBe(false);
    expect(await ctx.registry.recover(record, ownerSocketReachable)).toBe(true);
    const fresh = ctx.registry.createRecord(ctx.spec, "test");
    ctx.registry.reserve(fresh);
    expect(await ctx.registry.recover(record, async () => false)).toBe(false);
    expect(ctx.registry.find(ctx.spec)?.instance).toBe(fresh.instance);
    ctx.registry.release(record);
    expect(ctx.registry.find(ctx.spec)?.instance).toBe(fresh.instance);
  });
});

describe("detached owner process", () => {
  it("survives a separate launching process exiting with its controlling PTY and independent stdio", async () => {
    const ctx = context();
    const request = path.join(ctx.root, "frontend-request.json");
    fs.writeFileSync(request, JSON.stringify(ctx.spec), { mode: 0o600 });
    const frontend = spawnPty(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.resolve("tests/fixtures/sessionLauncher.mjs"),
        request,
      ],
      { cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env } },
    );
    (
      frontend as unknown as {
        on(event: string, fn: (error: NodeJS.ErrnoException) => void): void;
      }
    ).on("error", (error) => {
      if (error.code !== "EIO") throw error;
    });
    let exited = false;
    let frontendCode: number | undefined;
    frontend.onExit((info) => {
      exited = true;
      frontendCode = info.exitCode;
    });
    cleanups.push(() => {
      if (!exited) frontend.kill();
    });
    await waitFor(() => exited, "launcher PTY exit");
    expect(frontendCode).toBe(0);
    const record = JSON.parse(
      fs.readFileSync(path.join(ctx.root, "launcher-result.json"), "utf8"),
    ) as OwnerRecord;
    cleanups.push(async () => {
      if (processStartIdentity(record.pid) !== record.processStart) return;
      const connection = await connectOwner(record);
      connection.writer.control({ type: "stop" });
      connection.socket.end();
      await waitFor(
        () => ctx.registry.list().length === 0,
        "orphan owner cleanup",
      );
    });
    for (const fd of [0, 1, 2])
      expect(fs.readlinkSync(`/proc/${record.pid}/fd/${fd}`)).toBe("/dev/null");
    const connection = await attach(record);
    connection.writer.send(
      FrameType.Input,
      Buffer.from("echo SURVIVED-PARENT\r"),
    );
    await waitFor(
      () => connection.text().includes("SURVIVED-PARENT"),
      "input after launcher exit",
    );
    expect(processStartIdentity(record.pid)).toBe(record.processStart);
  }, 15000);

  it("concurrent launchers create one PTY/runtime; broken frontend/SIGHUP preserve identity; shell exit drains output and cleans discovery", async () => {
    const ctx = context();
    const [firstRecord, secondRecord] = await Promise.all([
      start(ctx),
      start(ctx),
    ]);
    expect(firstRecord.instance).toBe(secondRecord.instance);
    expect(
      fs
        .readFileSync(path.join(ctx.spec.cwd, "owner-starts.txt"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(fs.statSync(firstRecord.socketPath).mode & 0o777).toBe(0o600);
    const first = await attach(firstRecord);
    expect(first.boundary?.instance).toBe(firstRecord.instance);
    first.writer.send(
      FrameType.Input,
      Buffer.from("echo PID=$$; printf 'Привет 界😀\\n'\r"),
    );
    await waitFor(
      () => first.text().includes("PID=") && first.text().includes("Привет"),
      "first input",
    );
    const pidMatch = /PID=(\d+)/u.exec(first.text());
    await waitFor(() => /PID=\d+/u.test(first.text()), "shell identity");
    const shellPid = Number((/PID=(\d+)/u.exec(first.text()) ?? pidMatch)![1]);
    const second = await attach(firstRecord);
    expect(second.boundary?.instance).toBe(firstRecord.instance);
    second.writer.send(FrameType.Input, Buffer.from("echo PARALLEL_PID=$$\r"));
    await waitFor(
      () =>
        first.text().includes("PARALLEL_PID=" + shellPid) &&
        second.text().includes("PARALLEL_PID=" + shellPid),
      "both controllers share shell output",
    );
    first.socket.destroy();
    await tick();
    process.kill(firstRecord.pid, "SIGHUP");
    await tick();
    process.kill(shellPid, 0);
    const restored = await attach(firstRecord);
    expect(Buffer.concat(restored.snapshots).toString("utf8")).toContain(
      `PID=${shellPid}`,
    );
    restored.writer.send(
      FrameType.Input,
      Buffer.from("echo REATTACHED=$$; printf 'FINAL-OWNER\\n'; exit 7\r"),
    );
    await waitFor(
      () => restored.controls.some((v) => v.type === "exit"),
      "shell exit",
    );
    expect(restored.text()).toContain(`REATTACHED=${shellPid}`);
    expect(restored.text()).toContain("FINAL-OWNER");
    expect(restored.controls.find((v) => v.type === "exit")?.exitCode).toBe(7);
    await waitFor(() => ctx.registry.list().length === 0, "discovery cleanup");
    expect(fs.existsSync(firstRecord.socketPath)).toBe(false);
  }, 15000);

  it("rejects wrong identities/protocol and stop shuts down only its own owner", async () => {
    const ctx = context();
    const record = await start(ctx);
    const secondCtx = context();
    const independent = await start(secondCtx);
    await expect(
      connectOwner({ ...record, instance: randomUUID() }),
    ).rejects.toThrow("OWNER_MISMATCH");
    const socket = net.createConnection(record.socketPath);
    const replies: Buffer[] = [];
    cleanups.push(() => socket.destroy());
    const { LocalWriter, FrameDecoder } =
      await import("../src/services/features/telegram-mcp/src/features/detached-terminal/model/localProtocol");
    const writer = new LocalWriter(socket);
    const decoder = new FrameDecoder();
    socket.on("error", () => {});
    socket.on("data", (data) => {
      for (const frame of decoder.push(data)) replies.push(frame.payload);
    });
    writer.control({
      type: "hello",
      version: 999,
      instance: record.instance,
      clientUuid: record.clientUuid,
      sessionId: record.sessionId,
    });
    await waitFor(() => replies.length > 0, "protocol rejection");
    expect(Buffer.concat(replies).toString()).toContain("PROTOCOL_MISMATCH");
    const controller = await connectOwner(record);
    controller.writer.control({ type: "stop" });
    controller.socket.end();
    await waitFor(() => ctx.registry.list().length === 0, "explicit stop");
    expect(processStartIdentity(independent.pid)).toBe(
      independent.processStart,
    );
    expect(secondCtx.registry.list()).toHaveLength(1);
  }, 15000);
});
