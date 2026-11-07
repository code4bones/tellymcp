import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, type IPty } from "node-pty";
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  LocalRegistry,
  processStartIdentity,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import { stopLocalOwner } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/localSessions";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await sleep(15);
  }
}
type Session = {
  handle: string;
  owner_pid: number;
  pty_pid: number;
  attached: boolean;
  client_uuid: string;
  local_session_id: string;
};
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telly-cli-test-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { mode: 0o700 });
  let registrations = 0;
  const gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/client/register")) registrations++;
      const input = JSON.parse(body || "{}") as { client_uuid?: string };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ client_uuid: input.client_uuid || randomUUID() }),
      );
    });
  });
  gateway.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as net.AddressInfo).port;
  cleanup.push(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  const envPath = path.join(cwd, ".env");
  const values = {
    DISTRIBUTED_MODE: "client",
    GATEWAY_PUBLIC_URL: "http://127.0.0.1:" + port + "/api/gateway",
    GATEWAY_WS_URL: "ws://127.0.0.1:" + port + "/api/gateway/ws",
    GATEWAY_AUTH_TOKEN: "test-transport",
    GATEWAY_SCOPE_TOKEN: "test-scope",
    GATEWAY_USER_UUID: "",
    TELEGRAM_BOT_TOKEN: "",
    ADMIN_TOKEN: "",
    BROWSER_ENABLED: "false",
    BROWSER_ATTACH_ENABLED: "false",
    TERMINAL_SHELL: "/bin/sh",
    TERMINAL_COLS: "80",
    TERMINAL_ROWS: "24",
    TERMINAL_SCROLLBACK_LINES: "100",
    LOG_LEVEL: "error",
    LOGFEED_ENABLED: "false",
    NODE_ID: "cli-test-" + randomUUID(),
    TELLYMCP_SESSION_ID: "",
    TELLYMCP_SESSION_LABEL: "",
    TELLYMCP_TERMINAL_CONTEXT: "",
    TELLYMCP_HTTP_PROXY: "",
    TELLYMCP_NO_PROXY: "127.0.0.1",
    LANG: "C",
  };
  fs.writeFileSync(
    envPath,
    Object.entries(values)
      .map(([key, value]) => key + "=" + value)
      .join("\n"),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    ...values,
    TMPDIR: root,
    TELLYMCP_SOURCE_RUNTIME: "true",
  };
  const prefix = [
    "--import",
    require.resolve("tsx"),
    path.resolve("src/cli.ts"),
  ];
  const run = (args: string[], workingDir = cwd) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawnProcess(process.execPath, [...prefix, ...args], {
          cwd: workingDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "",
          err = "";
        child.stdout.on("data", (data) => {
          out += data.toString();
        });
        child.stderr.on("data", (data) => {
          err += data.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, out, err }));
      },
    );
  const registryPath = path.join(root, "tellymcp-" + process.getuid!());
  cleanup.push(async () => {
    if (!fs.existsSync(registryPath)) return;
    const registry = new LocalRegistry(registryPath);
    for (const record of registry.list())
      await stopLocalOwner(registry, record);
  });
  const pty = (args: string[]) =>
    frontend(process.execPath, [...prefix, ...args], cwd, env);
  return {
    root,
    cwd,
    envPath,
    env,
    prefix,
    run,
    pty,
    get registrations() {
      return registrations;
    },
  };
}
function frontend(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const pty = spawn(command, args, {
    cwd,
    env: env as Record<string, string>,
    cols: 80,
    rows: 24,
    name: "xterm-256color",
  });
  let output = "",
    code: number | undefined;
  (
    pty as IPty & {
      on(event: string, fn: (error: NodeJS.ErrnoException) => void): void;
    }
  ).on("error", (error) => {
    if (error.code !== "EIO") throw error;
  });
  pty.onData((data) => {
    output += data;
  });
  pty.onExit((event) => {
    code = event.exitCode;
  });
  cleanup.push(() => {
    if (code === undefined) pty.kill();
  });
  return {
    pty,
    get text() {
      return output;
    },
    get code() {
      return code;
    },
  };
}
const shellQuote = (value: string) => "'" + value.replace(/'/gu, "'\\''") + "'";

it("public detached run is idempotent; attach/stop work without a profile or network; conflicts never create another runtime", async () => {
  const ctx = await setup();
  const [first, second] = await Promise.all([
    ctx.run(["run", "--detach"]),
    ctx.run(["run", "--detach"]),
  ]);
  expect(first.code, first.err).toBe(0);
  expect(second.code, second.err).toBe(0);
  const sessions = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  expect(sessions).toHaveLength(1);
  expect(ctx.registrations).toBe(1);
  const session = sessions[0]!;
  expect(first.out).toContain(session.handle);
  expect(second.out).toContain(session.handle);
  const markerPath = path.join(ctx.cwd, ".mcpsession.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<
    string,
    unknown
  >;
  const markerBytes = fs.readFileSync(markerPath, "utf8");
  const conflict = await ctx.run(["run", "--detach", "--agent", "codex"]);
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("another provider");
  const originalProfile = fs.readFileSync(ctx.envPath, "utf8");
  fs.appendFileSync(ctx.envPath, "\n# edited profile\n");
  const changed = await ctx.run(["run", "--detach"]);
  expect(changed.code).toBe(1);
  expect(changed.err).toContain("different startup configuration");
  fs.writeFileSync(ctx.envPath, originalProfile);
  expect(fs.readFileSync(markerPath, "utf8")).toBe(markerBytes);
  const bridgeConflict = await ctx.run(["run", "--detach", "--ws", "65534"]);
  expect(bridgeConflict.code).toBe(1);
  expect(bridgeConflict.err).toContain("another browser bridge");
  expect(ctx.registrations).toBe(1);

  const attached = ctx.pty(["attach", session.handle]);
  await until(() => attached.text.includes("\x1bc"), "native snapshot");
  attached.pty.write("echo CLI_PID=$$\r");
  await until(
    () => attached.text.includes("CLI_PID=" + session.pty_pid),
    "same shell input",
  );
  const busy = ctx.pty(["attach", session.handle]);
  await until(() => busy.code !== undefined, "second controller rejection");
  expect(busy.code).toBe(1);
  expect(busy.text).toContain("already has an interactive controller");
  attached.pty.resize(97, 31);
  attached.pty.write("stty size\r");
  await until(() => attached.text.includes("31 97"), "native resize");
  attached.pty.write("\x1d");
  await sleep(75);
  attached.pty.write("d");
  await until(() => attached.code !== undefined, "detach exits frontend");
  expect(attached.code).toBe(0);
  expect(attached.text).toContain("Detached. Attach:");
  expect(processStartIdentity(session.owner_pid)).not.toBeNull();
  expect(
    (JSON.parse((await ctx.run(["sessions", "--json"])).out) as Session[])[0]
      ?.attached,
  ).toBe(false);

  fs.unlinkSync(ctx.envPath);
  const resumed = ctx.pty(["attach"]); // Menu defaults to current marker, no env file.
  await until(
    () => resumed.text.includes("Select a session"),
    "session picker",
  );
  resumed.pty.write("\r");
  await until(() => resumed.text.includes("\x1bc"), "profile-free reattach");
  resumed.pty.write("echo STILL_PID=$$; printf 'FINAL-CLI\\n'; exit 7\r");
  await until(() => resumed.code !== undefined, "shell exit");
  expect(resumed.code).toBe(7);
  expect(resumed.text).toContain("STILL_PID=" + session.pty_pid);
  expect(resumed.text).toContain("FINAL-CLI");
  expect(JSON.parse((await ctx.run(["sessions", "--json"])).out)).toEqual([]);
  const saved = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<
    string,
    unknown
  >;
  expect(saved.gateway_client_uuid).toBe(marker.gateway_client_uuid);
  expect(saved.local_session_id).toBe(marker.local_session_id);
}, 45000);

it("ordinary run returns to an outer shell with exact termios after detach; stop only ends the owner", async () => {
  const ctx = await setup();
  const outer = frontend(
    "/bin/bash",
    ["--noprofile", "--norc", "-i"],
    ctx.cwd,
    ctx.env,
  );
  const command = [process.execPath, ...ctx.prefix, "run"]
    .map(shellQuote)
    .join(" ");
  outer.pty.write(
    "printf 'BEFORE_TERMIOS='; stty -g; " +
      command +
      "; printf 'AFTER_TERMIOS='; stty -g; printf 'OUTER_RETURNED\\n'\r",
  );
  await until(() => outer.text.includes("\x1bc"), "ordinary run snapshot");
  outer.pty.write("echo RUN_PID=$$\r");
  const list = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  expect(list).toHaveLength(1);
  await until(
    () => outer.text.includes("RUN_PID=" + list[0]!.pty_pid),
    "ordinary run input",
  );
  outer.pty.write("\x1dd");
  await until(
    () => /AFTER_TERMIOS=[a-f0-9:]+/u.test(outer.text),
    "outer termios restoration",
  );
  expect(/AFTER_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1]).toBe(
    /BEFORE_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1],
  );
  const start = outer.text.length;
  const attachCommand = [process.execPath, ...ctx.prefix, "attach"]
    .map(shellQuote)
    .join(" ");
  outer.pty.write(attachCommand + "; printf 'ACTIVE_STOP_RETURNED\\n'\r");
  await until(
    () => outer.text.slice(start).includes("Select a session"),
    "outer session picker",
  );
  outer.pty.write("\r");
  await until(
    () => outer.text.slice(start).includes("\x1bc"),
    "active stop attachment",
  );
  const stopped = await ctx.run(["stop", list[0]!.handle]);
  expect(stopped.code, stopped.err).toBe(0);
  await until(
    () => outer.text.includes("ACTIVE_STOP_RETURNED\r\n"),
    "active controller exits on stop",
  );
  expect(JSON.parse((await ctx.run(["sessions", "--json"])).out)).toEqual([]);
  outer.pty.write("echo OUTER_STILL_ALIVE\r");
  await until(
    () => outer.text.includes("OUTER_STILL_ALIVE\r\n"),
    "outer shell remains alive",
  );
  outer.pty.write("exit\r");
  await until(() => outer.code !== undefined, "outer shell exit");
}, 45000);

it("attach menu selects another owner with arrows, works outside a workspace, and skips busy controllers", async () => {
  const ctx = await setup();
  expect((await ctx.run(["attach"])).out).toContain("No local sessions.");
  expect((await ctx.run(["run", "--detach", "-s", "First"])).code).toBe(0);
  const first = (
    JSON.parse((await ctx.run(["sessions", "--json"])).out) as Session[]
  )[0]!;
  const secondCwd = path.join(ctx.root, "second");
  fs.mkdirSync(secondCwd);
  const started = await ctx.run(
    ["run", "--detach", "--env", ctx.envPath, "-s", "Second"],
    secondCwd,
  );
  expect(started.code, started.err).toBe(0);
  const sessions = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  const second = sessions.find((session) => session.handle !== first.handle)!;
  const headless = await ctx.run(["attach"]);
  expect(headless.code).toBe(1);
  expect(headless.err).toContain("selection requires an interactive TTY");

  const selected = ctx.pty(["attach"]);
  await until(
    () => selected.text.includes("Select a session"),
    "two-owner menu",
  );
  expect(selected.text).toContain("First");
  expect(selected.text).toContain("Second");
  // Initial selection follows the current workspace, independent of registry order.
  selected.pty.write("\x1b[B\r");
  await until(() => selected.text.includes("\x1bc"), "second owner snapshot");
  selected.pty.write("echo SELECTED_PID=$$\r");
  await until(
    () => selected.text.includes("SELECTED_PID=" + second.pty_pid),
    "selected second shell",
  );

  const outside = path.join(ctx.root, "outside");
  fs.mkdirSync(outside);
  const other = frontend(
    process.execPath,
    [...ctx.prefix, "attach"],
    outside,
    ctx.env,
  );
  await until(() => other.text.includes("Select a session"), "outside menu");
  expect(other.text).toContain("attached · busy");
  other.pty.write("\x1b[B\r"); // Only First is available; busy Second is skipped.
  await until(() => other.text.includes("\x1bc"), "first owner snapshot");
  other.pty.write("echo AVAILABLE_PID=$$\r");
  await until(
    () => other.text.includes("AVAILABLE_PID=" + first.pty_pid),
    "available first shell",
  );
  const blocked = ctx.pty(["attach"]);
  await until(() => blocked.code !== undefined, "all busy rejection");
  expect(blocked.code).toBe(1);
  expect(blocked.text).toContain("No detached local sessions");
  for (const attached of [selected, other]) {
    attached.pty.write("\x1dd");
    await until(() => attached.code !== undefined, "menu frontend detaches");
    expect(attached.code).toBe(0);
  }
  const after = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  expect(after.map((session) => session.pty_pid).sort()).toEqual(
    sessions.map((session) => session.pty_pid).sort(),
  );
  expect(after.every((session) => !session.attached)).toBe(true);
  expect(ctx.registrations).toBe(2);
}, 45000);

it.each(["\x1b", "\x03"])(
  "attach menu cancellation %j restores exact outer termios without acquiring control",
  async (key) => {
    const ctx = await setup();
    expect((await ctx.run(["run", "--detach"])).code).toBe(0);
    const before = JSON.parse(
      (await ctx.run(["sessions", "--json"])).out,
    ) as Session[];
    const command = [process.execPath, ...ctx.prefix, "attach"]
      .map(shellQuote)
      .join(" ");
    const outer = frontend(
      "/bin/bash",
      [
        "-c",
        "stty -ixon; printf 'BEFORE_TERMIOS='; stty -g; " +
          command +
          "; printf 'MENU_STATUS=%s\\n' $?; printf 'AFTER_TERMIOS='; stty -g",
      ],
      ctx.cwd,
      ctx.env,
    );
    await until(() => outer.text.includes("Select a session"), "cancel menu");
    outer.pty.write(key);
    await until(
      () => outer.code !== undefined,
      "cancel returns to outer shell",
    );
    expect(outer.code).toBe(0);
    expect(outer.text).toContain("Attach cancelled.");
    expect(outer.text).toContain("MENU_STATUS=0");
    expect(/AFTER_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1]).toBe(
      /BEFORE_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1],
    );
    expect(outer.text).not.toContain("\x1bc");
    const after = JSON.parse(
      (await ctx.run(["sessions", "--json"])).out,
    ) as Session[];
    expect(after[0]!.pty_pid).toBe(before[0]!.pty_pid);
    expect(after[0]!.attached).toBe(false);
    expect(ctx.registrations).toBe(1);
  },
  30000,
);

it("SIGTERM aborts the attach picker without acquiring control or leaving the CLI waiting", async () => {
  const ctx = await setup();
  expect((await ctx.run(["run", "--detach"])).code).toBe(0);
  const picker = ctx.pty(["attach"]);
  await until(() => picker.text.includes("Select a session"), "signal menu");
  process.kill(picker.pty.pid, "SIGTERM");
  await until(() => picker.code !== undefined, "signal abort exits");
  expect(picker.code).toBe(143);
  expect(picker.text).toContain("Attach cancelled.");
  expect(picker.text).not.toContain("\x1bc");
  const sessions = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.attached).toBe(false);
  expect(ctx.registrations).toBe(1);
}, 30000);

it("stop menu stops an attached owner, refreshes for the remaining owner and exits only when empty", async () => {
  const ctx = await setup();
  expect((await ctx.run(["stop"])).out).toContain("No local sessions.");
  expect((await ctx.run(["run", "--detach", "-s", "First"])).code).toBe(0);
  const first = (
    JSON.parse((await ctx.run(["sessions", "--json"])).out) as Session[]
  )[0]!;
  const secondCwd = path.join(ctx.root, "second");
  fs.mkdirSync(secondCwd);
  const started = await ctx.run(
    ["run", "--detach", "--env", ctx.envPath, "-s", "Second"],
    secondCwd,
  );
  expect(started.code, started.err).toBe(0);
  const sessions = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  const second = sessions.find((session) => session.handle !== first.handle)!;
  const headless = await ctx.run(["stop"]);
  expect(headless.code).toBe(1);
  expect(headless.err).toContain("tellymcp stop <handle>");
  const attached = ctx.pty(["attach", first.handle]);
  await until(
    () => attached.text.includes("\x1bc"),
    "owner attached before stop",
  );
  const menu = ctx.pty(["stop"]);
  await until(
    () => menu.text.includes("Select a session to stop"),
    "stop menu",
  );
  expect(menu.text).toContain("First");
  expect(menu.text).toContain("Second");
  expect(menu.text).not.toContain("attached · busy");
  menu.pty.write("\r");
  const stopped = "Stopped: " + first.handle;
  await until(
    () =>
      menu.text.includes(stopped) &&
      menu.text
        .slice(menu.text.indexOf(stopped) + stopped.length)
        .includes("Select a session to stop"),
    "stop menu refreshes after first owner",
  );
  await until(() => attached.code !== undefined, "attached frontend exits");
  expect(attached.code).toBe(0);
  expect(menu.code).toBeUndefined();
  const remaining = JSON.parse(
    (await ctx.run(["sessions", "--json"])).out,
  ) as Session[];
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.handle).toBe(second.handle);
  expect(remaining[0]!.pty_pid).toBe(second.pty_pid);
  menu.pty.write("\r");
  await until(() => menu.code !== undefined, "stop menu ends when empty");
  expect(menu.code).toBe(0);
  expect(menu.text).toContain("Stopped: " + second.handle);
  expect(menu.text).toContain("No local sessions.");
  expect(menu.text.match(/TellyMCP · stop/gu)).toHaveLength(1);
  expect(JSON.parse((await ctx.run(["sessions", "--json"])).out)).toEqual([]);
  expect(ctx.registrations).toBe(2);
}, 45000);

it.each(["\x1b", "\x03"])(
  "stop menu cancellation %j keeps the remaining session and restores outer termios",
  async (key) => {
    const ctx = await setup();
    expect((await ctx.run(["run", "--detach"])).code).toBe(0);
    const before = JSON.parse(
      (await ctx.run(["sessions", "--json"])).out,
    ) as Session[];
    const command = [process.execPath, ...ctx.prefix, "stop"]
      .map(shellQuote)
      .join(" ");
    const outer = frontend(
      "/bin/bash",
      [
        "-c",
        "stty -ixon; printf 'BEFORE_TERMIOS='; stty -g; " +
          command +
          "; printf 'MENU_STATUS=%s\\n' $?; printf 'AFTER_TERMIOS='; stty -g",
      ],
      ctx.cwd,
      ctx.env,
    );
    await until(
      () => outer.text.includes("Select a session to stop"),
      "stop cancel menu",
    );
    outer.pty.write(key);
    await until(() => outer.code !== undefined, "stop menu cancellation");
    expect(outer.text).toContain("Stop menu closed.");
    expect(outer.text).toContain("MENU_STATUS=0");
    expect(/AFTER_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1]).toBe(
      /BEFORE_TERMIOS=([a-f0-9:]+)/u.exec(outer.text)?.[1],
    );
    const after = JSON.parse(
      (await ctx.run(["sessions", "--json"])).out,
    ) as Session[];
    expect(after[0]!.handle).toBe(before[0]!.handle);
    expect(after[0]!.pty_pid).toBe(before[0]!.pty_pid);
    expect(after[0]!.attached).toBe(false);
    expect(ctx.registrations).toBe(1);
  },
  30000,
);

it("stop menu remains open after a failed stop and allows cancellation", async () => {
  const ctx = await setup();
  const registry = new LocalRegistry(
    path.join(ctx.root, "tellymcp-" + process.getuid!()),
  );
  // A live process identity with no owner socket: stop must report the error,
  // never signal that PID, and return to selection instead of exiting or spinning.
  const record = registry.createRecord(
    {
      cwd: ctx.cwd,
      envPath: ctx.envPath,
      packageRoot: process.cwd(),
      clientUuid: randomUUID(),
      sessionId: "unavailable",
      sessionLabel: "Unavailable",
    },
    "0.0.43",
  );
  registry.reserve(record);
  registry.publish(record);
  cleanup.push(() => registry.release(record));
  const menu = ctx.pty(["stop"]);
  await until(
    () => menu.text.includes("Select a session to stop"),
    "unavailable stop menu",
  );
  menu.pty.write("\r");
  await until(
    () =>
      menu.text.includes("connect ENOENT") &&
      menu.text
        .slice(menu.text.indexOf("connect ENOENT"))
        .includes("Select a session to stop"),
    "stop error returns to menu",
  );
  expect(menu.code).toBeUndefined();
  menu.pty.write("\x1b");
  await until(() => menu.code !== undefined, "failed stop menu cancellation");
  expect(menu.code).toBe(1);
  expect(registry.list()).toHaveLength(1);
  expect(ctx.registrations).toBe(0);
}, 30000);

async function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

it("frontend SIGTERM/SIGKILL leave the owner and browser bridge alive; Ctrl+C/Z/D retain PTY behavior", async () => {
  const ctx = await setup();
  const reservation = net.createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const started = await ctx.run(["run", "--detach", "--ws", String(port)]);
  expect(started.code, started.err).toBe(0);
  expect(await tcpOpen(port)).toBe(true);
  const session = (
    JSON.parse((await ctx.run(["sessions", "--json"])).out) as Session[]
  )[0]!;
  const terminated = ctx.pty(["attach", session.handle]);
  await until(
    () => terminated.text.includes("\x1bc"),
    "signal frontend snapshot",
  );
  process.kill(terminated.pty.pid, "SIGTERM");
  await until(() => terminated.code !== undefined, "frontend SIGTERM");
  expect(terminated.code).toBe(143);
  expect(processStartIdentity(session.owner_pid)).not.toBeNull();
  expect(await tcpOpen(port)).toBe(true);

  const killed = ctx.pty(["attach", session.handle]);
  await until(() => killed.text.includes("\x1bc"), "kill frontend snapshot");
  process.kill(killed.pty.pid, "SIGKILL");
  await until(() => killed.code !== undefined, "frontend SIGKILL");
  const keys = ctx.pty(["attach", session.handle]);
  await until(() => keys.text.includes("\x1bc"), "keys frontend snapshot");
  keys.pty.write("printf 'SLEEP-READY\\n'; sleep 10\r");
  await until(() => keys.text.includes("SLEEP-READY\r\n"), "sleep ready");
  keys.pty.write("\x1a");
  await until(() => keys.text.includes("Stopped"), "Ctrl+Z");
  keys.pty.write("kill -KILL %1; printf 'JOB-CLEAN\\n'; sleep 10\r");
  await until(() => keys.text.includes("JOB-CLEAN\r\n"), "job cleanup");
  keys.pty.write("\x03");
  keys.pty.write("printf 'CTRL-C-OK\\n'\r");
  await until(() => keys.text.includes("CTRL-C-OK\r\n"), "Ctrl+C");
  expect(await tcpOpen(port)).toBe(true);
  keys.pty.write("\x04");
  await until(() => keys.code !== undefined, "Ctrl+D shell exit");
  expect(keys.code).toBe(0);
  await until(async () => !(await tcpOpen(port)), "bridge cleanup");
  expect(JSON.parse((await ctx.run(["sessions", "--json"])).out)).toEqual([]);
}, 45000);
