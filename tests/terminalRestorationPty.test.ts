import path from "node:path";

import { spawn } from "node-pty";
import * as XtermHeadless from "@xterm/headless";
import { expect, it } from "vitest";

import { TerminalRestorationPrototype } from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";

async function waitFor(
  check: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("reattaches to the same real shell and interactive child, preserves progress and input, with one reply per query", async () => {
  const pty = spawn(
    "/bin/sh",
    [
      "-c",
      '"$1" "$2"; printf "SHELL-DONE\\n"; exit 7',
      "restoration-test",
      process.execPath,
      path.resolve("tests/fixtures/restorationAgent.mjs"),
    ],
    {
      name: "xterm-256color",
      cols: 60,
      rows: 12,
      cwd: process.cwd(),
      env: { ...process.env },
    },
  );
  const model = new TerminalRestorationPrototype(pty, { cols: 60, rows: 12 });
  // Match the normal Unix PTY EOF handling used by ptyRegistry.
  (
    pty as unknown as {
      on(event: string, fn: (error: NodeJS.ErrnoException) => void): void;
    }
  ).on("error", (error) => {
    if (error.code !== "EIO" || error.syscall !== "read") throw error;
  });
  let output = "";
  const observer = pty.onData((data) => {
    output += data;
  });
  const display = new XtermHeadless.Terminal({
    cols: 60,
    rows: 12,
    allowProposedApi: true,
  });
  const displayReplies: string[] = [];
  display.onData((reply) => {
    displayReplies.push(reply);
    pty.write(reply);
  });
  const render = (data: string) =>
    new Promise<void>((resolve) => display.write(data, resolve));
  try {
    await waitFor(() => output.includes("tick:2"), "child startup");
    const match = /AGENT:(\d+):SHELL:(\d+)/u.exec(output)!;
    expect(Number(match[2])).toBe(pty.pid);
    const shellPid = pty.pid;
    const agentPid = Number(match[1]);
    const first = await model.attach(60, 12);
    await render(first.snapshot.ansi);
    first.acknowledge();
    first.write("query\r");
    await waitFor(() => output.includes("reply:1"), "attached query");
    await model.settled();
    for (const frame of first.drain()) await render(frame.data);
    expect(displayReplies).toEqual([]);
    first.detach();
    const before = output.length;
    // Detached application queries still complete, independently of a display.
    pty.write("query\r");
    await waitFor(() => output.includes("reply:2"), "detached query");
    await waitFor(
      () => /tick:\d+/u.test(output.slice(before)),
      "detached progress",
    );
    const next = await model.attach(48, 10);
    expect(model.status.pid).toBe(shellPid);
    process.kill(shellPid, 0);
    process.kill(agentPid, 0);
    display.resize(48, 10);
    await render(next.snapshot.ansi);
    next.acknowledge();
    expect(next.snapshot.instance).toBe(first.snapshot.instance);
    const bytes = Buffer.from("Привет 界 😀\r");
    for (const byte of bytes) next.write(Buffer.from([byte]));
    next.write("query\r");
    await waitFor(
      () => output.includes("echo:Привет 界 😀") && output.includes("reply:3"),
      "restored input",
    );
    await model.settled();
    const frames = next.drain();
    expect(frames.map((f) => f.sequence)).toEqual(
      frames.map((_, i) => next.snapshot.sequence + i + 1),
    );
    for (const frame of frames) await render(frame.data);
    expect(displayReplies).toEqual([]);
    expect(output.match(/reply:\d+/gu)).toEqual([
      "reply:1",
      "reply:2",
      "reply:3",
    ]);
    expect(output.match(/AGENT:/gu)).toHaveLength(1);
    next.write("exit\r");
    await waitFor(() => model.status.exit !== undefined, "shell exit");
    expect(model.status.exit?.exitCode).toBe(7);
    const finalOutput = next
      .drain()
      .map((frame) => frame.data)
      .join("");
    expect(finalOutput).toContain("AGENT-DONE");
    expect(finalOutput).toContain("SHELL-DONE");
  } finally {
    observer.dispose();
    await model.dispose();
    display.dispose();
    if (!model.status.exit) pty.kill();
  }
}, 10000);
