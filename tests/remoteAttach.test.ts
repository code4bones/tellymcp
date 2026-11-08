import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { afterEach, expect, it } from "vitest";
import { GatewayTerminalAttach } from "../src/services/features/telegram-mcp/src/features/remote-terminal/model/gatewayAttach";
import { TerminalOwnerBridge } from "../src/services/features/telegram-mcp/src/features/remote-terminal/model/ownerBridge";
import {
  attachEndpoint,
  connectGatewayTerminal,
} from "../src/services/features/telegram-mcp/src/features/remote-terminal/model/remoteConnection";
import {
  attachCodeHash,
  type AttachCodeStore,
  type AttachGrant,
} from "../src/services/features/telegram-mcp/src/features/remote-terminal/model/attachCodes";
import { startSessionOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/sessionOwner";
import { LocalRegistry } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import { connectOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localConnection";
import { FrameType } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localProtocol";
import {
  enableOwnedPtySessions,
  ensurePtySession,
  getOwnedPtySession,
  sendPtyText,
  stopPtyTarget,
} from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
class MemoryCodes implements AttachCodeStore {
  readonly grants = new Map<string, AttachGrant>();
  readonly counts = new Map<string, number>();
  async put(key: string, grant: AttachGrant) {
    if (this.grants.has(key)) return false;
    this.grants.set(key, grant);
    return true;
  }
  async take(key: string) {
    const grant = this.grants.get(key);
    this.grants.delete(key);
    return grant ?? null;
  }
  async limit(key: string, maximum: number) {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= maximum;
  }
}
async function setup(leaseMs = 30000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telly-remote-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new LocalRegistry(path.join(root, "registry"));
  const ownerCwd = path.join(root, "owner"),
    viewerCwd = path.join(root, "viewer");
  fs.mkdirSync(ownerCwd);
  fs.mkdirSync(viewerCwd);
  const profile = path.join(viewerCwd, "viewer.env");
  fs.writeFileSync(
    profile,
    "TELLYMCP_HTTP_PROXY=\nTELLYMCP_NO_PROXY=127.0.0.1\n",
  );
  enableOwnedPtySessions();
  const target = ensurePtySession(
    { shell: "/bin/sh", cols: 80, rows: 24, scrollbackLines: 100 },
    { sessionId: randomUUID(), cwd: ownerCwd },
  );
  const stream = getOwnedPtySession(target);
  const clientUuid = randomUUID(),
    sessionId = "remote-shell";
  const owner = await startSessionOwner({
    registry,
    packageVersion: "test",
    spec: {
      cwd: ownerCwd,
      envPath: profile,
      packageRoot: process.cwd(),
      clientUuid,
      sessionId,
      sessionLabel: "Remote shell",
    },
    createSession: async () => ({
      stream,
      stop: async () => {
        stopPtyTarget(target);
        await stream.dispose();
      },
    }),
  });
  cleanups.push(() => owner.stop());
  const httpServer = http.createServer();
  const backendServer = new WebSocketServer({ noServer: true });
  const codes = new MemoryCodes();
  let backend: WebSocket | undefined,
    owned = true;
  const gateway = new GatewayTerminalAttach({
    path: "/api/gateway/ws/attach",
    codes,
    ownedTarget: async (user, canonical) =>
      user === 42 && owned && canonical === clientUuid + ":" + sessionId
        ? { clientUuid, sessionId }
        : null,
    ownerSocket: (client) => (client === clientUuid ? backend : undefined),
  });
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/backend")
      backendServer.handleUpgrade(req, socket, head, (ws) =>
        backendServer.emit("connection", ws),
      );
    else gateway.upgrade(req, socket as Socket, head);
  });
  backendServer.on("connection", (ws) => {
    backend = ws;
    ws.on("message", (raw) => gateway.handle(ws, raw));
    ws.on("close", () => gateway.backendClosed(ws));
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (httpServer.address() as { port: number }).port;
  const ownerTransport = new WebSocket("ws://127.0.0.1:" + port + "/backend");
  const bridge = new TerminalOwnerBridge(ownerTransport, { registry, leaseMs });
  ownerTransport.on("message", (raw) => {
    void bridge.handle(raw);
  });
  ownerTransport.on("close", () => bridge.close());
  await new Promise<void>((resolve, reject) => {
    ownerTransport.once("open", resolve);
    ownerTransport.once("error", reject);
  });
  cleanups.push(async () => {
    bridge.close();
    gateway.close();
    ownerTransport.terminate();
    for (const socket of backendServer.clients) socket.terminate();
    backendServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  const endpoint = "ws://127.0.0.1:" + port + "/api/gateway/ws/attach";
  const issue = () => gateway.issue(42, clientUuid + ":" + sessionId);
  const connect = async () => {
    const { code } = await issue();
    const connection = await connectGatewayTerminal(endpoint, code);
    cleanups.push(() => connection.socket.destroy());
    return connection;
  };
  const frontend = (code: string) => {
    const pty = spawn(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.resolve("src/cli.ts"),
        "attach",
        "--code",
        code,
        "--gateway",
        "http://127.0.0.1:" + port + "/api/gateway",
        "--env",
        profile,
      ],
      {
        cwd: viewerCwd,
        env: {
          ...process.env,
          TMPDIR: path.join(root, "viewer-tmp"),
        } as Record<string, string>,
        cols: 100,
        rows: 30,
        name: "xterm-256color",
      },
    );
    const result = { pty, text: "", code: undefined as number | undefined };
    pty.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EIO") throw error;
    });
    pty.onData((data) => (result.text += data));
    pty.onExit((event) => {
      result.code = event.exitCode;
    });
    cleanups.push(() => {
      if (result.code === undefined) pty.kill();
    });
    return result;
  };
  return {
    root,
    registry,
    owner,
    stream,
    target,
    codes,
    gateway,
    issue,
    connect,
    frontend,
    endpoint,
    clientUuid,
    sessionId,
    ownerTransport,
    setOwned(value: boolean) {
      owned = value;
    },
  };
}

it("binds an 8-digit five-minute code to the verified owner, target and process instance", async () => {
  const ctx = await setup();
  await expect(
    ctx.gateway.issue(43, ctx.clientUuid + ":" + ctx.sessionId),
  ).rejects.toThrow("owner");
  await expect(
    ctx.gateway.issue(42, randomUUID() + ":" + ctx.sessionId),
  ).rejects.toThrow("owner");
  const before = Date.now();
  const issued = await ctx.issue();
  expect(issued.code).toMatch(/^\d{8}$/u);
  expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 300000);
  expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 300000);
  expect([...ctx.codes.grants.keys()]).toEqual([attachCodeHash(issued.code)]);
  expect(ctx.codes.grants.get(attachCodeHash(issued.code))).toMatchObject({
    clientUuid: ctx.clientUuid,
    sessionId: ctx.sessionId,
    instance: ctx.owner.record.instance,
    telegramUserId: 42,
  });
});

it("consumes a code exactly once even for simultaneous redemptions", async () => {
  const ctx = await setup();
  const { code } = await ctx.issue();
  const results = await Promise.allSettled([
    connectGatewayTerminal(ctx.endpoint, code),
    connectGatewayTerminal(ctx.endpoint, code),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  for (const result of results)
    if (result.status === "fulfilled") result.value.socket.destroy();
  await expect(connectGatewayTerminal(ctx.endpoint, code)).rejects.toThrow(
    "invalid",
  );
});

it.each(["expired", "ownership", "instance"])(
  "rejects %s grants before forwarding any terminal input",
  async (reason) => {
    const ctx = await setup();
    const { code } = await ctx.issue();
    const grant = ctx.codes.grants.get(attachCodeHash(code))!;
    if (reason === "expired") grant.expiresAt = Date.now() - 1;
    else if (reason === "ownership") ctx.setOwned(false);
    else grant.instance = randomUUID();
    await expect(connectGatewayTerminal(ctx.endpoint, code)).rejects.toThrow(
      "invalid",
    );
    expect(ctx.stream.status.attached).toBe(false);
    expect(ctx.registry.list()).toHaveLength(1);
  },
);

it("limits code issuance and guessing, rejects caller-supplied targets and URL credentials", async () => {
  const ctx = await setup();
  for (let i = 0; i < 5; i++) await ctx.issue();
  await expect(ctx.issue()).rejects.toThrow("Too many");
  for (let i = 0; i < 11; i++)
    await expect(
      connectGatewayTerminal(ctx.endpoint, "99999999"),
    ).rejects.toThrow();
  expect(ctx.codes.counts.get("redeem:127.0.0.1")).toBe(11);
  const ws = new WebSocket(ctx.endpoint);
  ws.on("error", () => {});
  await new Promise<void>((resolve) => ws.once("open", resolve));
  ws.send(
    JSON.stringify({
      type: "redeem",
      code: "11111111",
      clientUuid: ctx.clientUuid,
    }),
  );
  await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  expect(ctx.stream.status.attached).toBe(false);
  expect(() =>
    attachEndpoint("https://user:password@example.com/api/gateway"),
  ).toThrow("credentials");
  expect(() => attachEndpoint("http://example.com/api/gateway")).toThrow(
    "HTTPS",
  );
  expect(attachEndpoint("https://example.com/api/gateway")).toBe(
    "wss://example.com/api/gateway/ws/attach",
  );
});

it("does not grant owner stop/admin protocol operations to a code holder", async () => {
  const ctx = await setup();
  const connection = await ctx.connect();
  connection.socket.on("error", () => {});
  connection.writer.control({ type: "stop" });
  await until(() => connection.socket.destroyed, "scope rejection");
  expect(ctx.registry.list()).toHaveLength(1);
  const probe = await connectOwner(ctx.owner.record);
  probe.socket.destroy();
  expect(probe.ptyPid).toBe(ctx.stream.status.pid);
});

it("remote CLI preserves PID, screen/raw input/resize and writable Live mirroring across detach and fresh-code reattach", async () => {
  const ctx = await setup();
  const pid = ctx.stream.status.pid;
  const first = ctx.frontend((await ctx.issue()).code);
  await until(() => first.text.includes("\x1bc"), "remote snapshot");
  first.pty.write(
    "echo REMOTE_PID=$$; printf '\\033[31mREMOTE_COLOR\\033[0m\\n'\r",
  );
  await until(
    () =>
      first.text.includes("REMOTE_PID=" + pid) &&
      first.text.includes("REMOTE_COLOR"),
    "remote raw input",
  );
  // Existing Live input shares the same shell alongside native clients.
  sendPtyText(ctx.target, "echo LIVE_MIRROR_OK\r");
  await until(
    () => first.text.includes("LIVE_MIRROR_OK\r\n"),
    "mirrored Live write",
  );
  first.pty.resize(105, 33);
  first.pty.write("stty size\r");
  await until(() => first.text.includes("33 105"), "remote resize");
  const local = await connectOwner(ctx.owner.record);
  const controls: Array<Record<string, unknown>> = [];
  local.socket.on("data", (data) => {
    for (const frame of local.decoder.push(data))
      if (frame.type === FrameType.Control)
        controls.push(JSON.parse(frame.payload.toString()));
  });
  local.writer.control({ type: "attach", cols: 80, rows: 24 });
  await until(
    () => controls.some((value) => value.type === "snapshot_begin"),
    "local attach alongside remote",
  );
  const boundary = controls.find((value) => value.type === "snapshot_begin")!;
  local.writer.control({
    type: "ack",
    generation: boundary.generation,
    sequence: boundary.sequence,
  });
  local.writer.send(FrameType.Input, Buffer.from("echo LOCAL_SHARED_PID=$$\r"));
  await until(
    () => first.text.includes("LOCAL_SHARED_PID=" + pid),
    "remote sees concurrent local input",
  );
  const parallelRemote = ctx.frontend((await ctx.issue()).code);
  await until(
    () => parallelRemote.text.includes("\x1bc"),
    "second remote snapshot",
  );
  parallelRemote.pty.write("echo TWO_REMOTE_PID=$$\r");
  await until(
    () =>
      parallelRemote.text.includes("TWO_REMOTE_PID=" + pid) &&
      first.text.includes("TWO_REMOTE_PID=" + pid),
    "both remote terminals share input/output",
  );
  parallelRemote.pty.write("\x1dd");
  await until(
    () => parallelRemote.code !== undefined,
    "only second remote detaches",
  );
  expect(parallelRemote.code).toBe(0);
  expect(first.code).toBeUndefined();
  expect(ctx.stream.status.attached).toBe(true);
  local.socket.destroy();
  first.pty.write("\x1dd");
  await until(() => first.code !== undefined, "remote detach");
  expect(first.code).toBe(0);
  await until(() => !ctx.stream.status.attached, "native lease released");
  sendPtyText(ctx.target, "echo DETACHED_LIVE_OK\r");
  const second = ctx.frontend((await ctx.issue()).code);
  await until(
    () =>
      second.text.includes("\x1bc") && second.text.includes("DETACHED_LIVE_OK"),
    "restored screen",
  );
  second.pty.write("echo SAME_PID=$$; printf 'REMOTE_FINAL\\n'; exit 7\r");
  await until(() => second.code !== undefined, "remote shell exit");
  expect(second.code).toBe(7);
  expect(second.text).toContain("SAME_PID=" + pid);
  expect(second.text).toContain("REMOTE_FINAL");
  expect(fs.readdirSync(path.join(ctx.root, "viewer"))).toEqual(["viewer.env"]);
  expect(
    fs.existsSync(
      path.join(ctx.root, "viewer-tmp", "tellymcp-" + process.getuid!()),
    ),
  ).toBe(false);
}, 30000);

it("losing the gateway-owner connection releases control and preserves the same owner/PTY", async () => {
  const ctx = await setup();
  const pid = ctx.stream.status.pid;
  const remote = ctx.frontend((await ctx.issue()).code);
  await until(() => remote.text.includes("\x1bc"), "connected remote");
  ctx.ownerTransport.terminate();
  await until(
    () => remote.code !== undefined && !ctx.stream.status.attached,
    "network loss releases control",
  );
  expect(ctx.registry.list()).toHaveLength(1);
  expect(ctx.stream.status.pid).toBe(pid);
  const local = await connectOwner(ctx.owner.record);
  expect(local.ptyPid).toBe(pid);
  local.socket.destroy();
}, 30000);

it("expires a remote lease if the gateway stops forwarding keepalives", async () => {
  const ctx = await setup(200);
  const connection = await ctx.connect();
  connection.socket.on("error", () => {});
  connection.writer.control({ type: "attach", cols: 80, rows: 24 });
  await until(() => ctx.stream.status.attached, "native remote lease");
  await until(() => !ctx.stream.status.attached, "expired remote lease");
  expect(ctx.registry.list()).toHaveLength(1);
  expect(ctx.stream.status.exit).toBeUndefined();
});
