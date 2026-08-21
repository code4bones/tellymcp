import { expect, it, vi } from "vitest";
import { spawn, type IPty } from "node-pty";

import { startCodexAppServer } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentRuntimeService";
import { resolveExecutablePath } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentProviderRegistry";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";

const smoke = process.env.TELLYMCP_CODEX_SMOKE === "1" ? it : it.skip;
const tuiSmoke =
  process.env.TELLYMCP_CODEX_TUI_SMOKE === "1" ? it : it.skip;

smoke("connects to the installed Codex app-server contract", async () => {
  const executablePath = resolveExecutablePath("codex");
  expect(executablePath).toBeTruthy();
  let stop: (() => void) | undefined;
  try {
    const server = await startCodexAppServer({
      executablePath: executablePath!,
      sessionId: "codex-smoke",
      cwd: process.cwd(),
      logger: { warn: vi.fn() } as unknown as Logger,
      clientVersion: "smoke",
      onApprovalRequest: async () => "decline",
    });
    stop = server.stop;
    expect(server.waitForThread).toBeTypeOf("function");
    expect(server.cwd).toBe(process.cwd());
    expect(server.diagnostics?.status).toBe("ready");
    expect(server.serverInfo?.userAgent).toBeTruthy();
  } finally {
    stop?.();
  }
}, 15_000);

tuiSmoke("captures the exact thread started by the remote Codex TUI", async () => {
  const executablePath = resolveExecutablePath("codex");
  expect(executablePath).toBeTruthy();
  let stop: (() => void) | undefined;
  let terminal: IPty | undefined;
  try {
    const server = await startCodexAppServer({
      executablePath: executablePath!,
      sessionId: "codex-tui-smoke",
      cwd: process.cwd(),
      logger: { warn: vi.fn() } as unknown as Logger,
      clientVersion: "smoke",
      onApprovalRequest: async () => "decline",
    });
    stop = server.stop;
    const threadStarted = server.waitForThread();
    terminal = spawn(
      executablePath!,
      ["--remote", server.endpoint, "-C", process.cwd(), "--no-alt-screen"],
      {
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(process.env).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value]],
          ),
        ),
        cols: 120,
        rows: 40,
      },
    );

    await expect(threadStarted).resolves.toMatch(/^[0-9a-f-]+$/u);
  } finally {
    terminal?.kill();
    stop?.();
  }
}, 20_000);
