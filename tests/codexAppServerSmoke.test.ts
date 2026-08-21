import { expect, it, vi } from "vitest";

import { startCodexAppServer } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentRuntimeService";
import { resolveExecutablePath } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentProviderRegistry";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";

const smoke = process.env.TELLYMCP_CODEX_SMOKE === "1" ? it : it.skip;

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
      ephemeralThread: true,
    });
    stop = server.stop;
    expect(server.threadId).toMatch(/^\S+$/u);
    expect(server.cwd).toBe(process.cwd());
    expect(server.diagnostics?.status).toBe("ready");
    expect(server.serverInfo?.userAgent).toBeTruthy();
  } finally {
    stop?.();
  }
}, 15_000);
