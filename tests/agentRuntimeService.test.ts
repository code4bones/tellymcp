import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { SessionStore } from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import {
  AgentRuntimeService,
  buildAgentLaunchCommand,
} from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentRuntimeService";

describe("agent runtime service", () => {
  it("builds a quoted command with an exit sentinel", () => {
    expect(
      buildAgentLaunchCommand({
        executablePath: "/opt/Codex CLI/codex",
        args: ["--profile", "team's"],
        sentinel: "__EXIT__",
      }),
    ).toContain("'/opt/Codex CLI/codex' '--profile' 'team'\\''s'");
    expect(
      buildAgentLaunchCommand({
        executablePath: "/bin/codex",
        args: [],
        sentinel: "__EXIT__",
      }),
    ).toContain("__EXIT__%s");
  });

  it("tracks one active agent and releases the session after its sentinel", async () => {
    const setSession = vi.fn(async () => undefined);
    const sessionStore = {
      getSession: vi.fn(async () => ({
        sessionId: "workspace",
        cwd: "/workspace",
        terminalTarget: "pty:workspace",
        updatedAt: "2026-08-21T00:00:00.000Z",
      })),
      listSessions: vi.fn(async () => []),
      setSession,
      clearSession: vi.fn(async () => undefined),
    } satisfies SessionStore;
    let onData: ((data: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const stopAppServer = vi.fn();
    const sendLine = vi.fn(async () => undefined);
    const service = new AgentRuntimeService(
      { terminal: {} } as AppConfig,
      sessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
      {
        inspectProviders: () => [
          {
            providerId: "openai",
            providerName: "OpenAI",
            agentId: "codex",
            agentName: "Codex",
            executable: "codex",
            executablePath: "/bin/codex",
            transport: "app-server",
            launchArgs: [],
            aliases: ["codex"],
            available: true,
          },
        ],
        ensureTarget: () => "pty:workspace",
        sendLine,
        subscribe: (_target, input) => {
          onData = input.onData;
          return unsubscribe;
        },
        startAppServer: async () => ({
          endpoint: "unix:///tmp/tellymcp-codex-test.sock",
          stop: stopAppServer,
        }),
      },
    );

    const started = await service.startAgent({
      session_id: "workspace",
      agent_id: "codex",
    });
    expect(started).toMatchObject({
      ok: true,
      agent_id: "codex",
      provider_id: "openai",
      terminal_target: "pty:workspace",
      transport: "app-server",
    });
    expect(sendLine).toHaveBeenCalledOnce();
    await expect(
      service.startAgent({ session_id: "workspace", agent_id: "codex" }),
    ).rejects.toThrow("already running");
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      active_agent_id: "codex",
      agents: [{ agentId: "codex", state: "running" }],
    });

    const command = String(sendLine.mock.calls[0]?.[2]);
    expect(command).toContain(
      "'/bin/codex' '--remote' 'unix:///tmp/tellymcp-codex-test.sock' '-C' '/workspace'",
    );
    const sentinel = command.match(/(__TELLYMCP_AGENT_EXIT_[a-f0-9]+__)/u)?.[1];
    expect(sentinel).toBeTruthy();
    onData?.(command);
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      active_agent_id: "codex",
    });
    onData?.(`${sentinel}0\r\n`);

    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      agents: [{ agentId: "codex", state: "idle", lastExitCode: 0 }],
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopAppServer).toHaveBeenCalledOnce();
  });

  it("rejects a provider whose CLI is missing", async () => {
    const service = new AgentRuntimeService(
      { terminal: {} } as AppConfig,
      {
        getSession: vi.fn(),
      } as unknown as SessionStore,
      {} as Logger,
      {
        inspectProviders: () => [
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            agentId: "claude",
            agentName: "Claude Code",
            executable: "claude",
            transport: "pty",
            launchArgs: [],
            aliases: ["claude"],
            available: false,
          },
        ],
      },
    );

    await expect(
      service.startAgent({ session_id: "workspace", agent_id: "claude" }),
    ).rejects.toThrow("not installed");
  });
});
