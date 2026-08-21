import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { SessionStore } from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import {
  AgentRuntimeService,
  buildAgentLaunchCommand,
  createCodexSocketLocation,
  createCodexProgressRelay,
} from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentRuntimeService";
import type { CodexTurnResult } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/codexAppServerClient";

describe("agent runtime service", () => {
  it("creates the default Codex socket inside the project runtime directory", () => {
    const workspaceDirectory = mkdtempSync(
      path.join(os.tmpdir(), "tellymcp-codex-workspace-"),
    );
    const location = createCodexSocketLocation({ cwd: workspaceDirectory });
    const socketDirectory = path.dirname(location.socketPath);

    try {
      expect(statSync(socketDirectory).mode & 0o777).toBe(0o700);
      expect(socketDirectory).toBe(path.join(workspaceDirectory, ".tellymcp"));
      expect(path.basename(location.socketPath)).toMatch(
        /^codex-[a-f0-9]{12}\.sock$/u,
      );
    } finally {
      location.cleanup();
      rmSync(workspaceDirectory, { recursive: true, force: true });
    }

    expect(existsSync(workspaceDirectory)).toBe(false);
  });

  it("debounces, deduplicates, and bounds Codex progress notifications", async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn(async () => undefined);
      const relay = createCodexProgressRelay({
        notify,
        isActive: () => true,
        debounceMs: 100,
        maxUpdates: 2,
      });

      relay.push("Codex is running a command.");
      relay.push("Codex is preparing file changes.");
      await vi.advanceTimersByTimeAsync(100);
      expect(notify).toHaveBeenCalledWith(
        "⏳ Codex is preparing file changes.",
      );

      relay.push("Codex is preparing file changes.");
      await vi.advanceTimersByTimeAsync(100);
      expect(notify).toHaveBeenCalledTimes(1);

      relay.push("Codex updated its plan.");
      await vi.advanceTimersByTimeAsync(100);
      relay.push("Codex is searching the web.");
      await vi.advanceTimersByTimeAsync(100);
      expect(notify).toHaveBeenCalledTimes(2);

      relay.stop();
      relay.push("Codex finished a command.");
      await vi.advanceTimersByTimeAsync(100);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
    const closeAppServerClient = vi.fn();
    let completeTurn:
      | ((result: CodexTurnResult) => void | Promise<void>)
      | undefined;
    let interruptTurnCallback: (() => void | Promise<void>) | undefined;
    const interruptTurn = vi.fn(async () => undefined);
    const submitTurn = vi.fn(
      async (input: {
        onComplete: (result: CodexTurnResult) => void | Promise<void>;
        onInterrupted?: (() => void | Promise<void>) | undefined;
      }) => {
        completeTurn = input.onComplete;
        interruptTurnCallback = input.onInterrupted;
        return { threadId: "thread-1", turnId: "turn-1" };
      },
    );
    const notifyTelegram = vi.fn(async () => undefined);
    const requestApproval = vi.fn(async () => "accept" as const);
    const waitForThread = vi.fn(async () => "thread-1");
    let onApprovalRequest:
      | ((input: {
          requestId: string;
          kind: "command";
          threadId: string;
          turnId: string;
          itemId: string;
        }) => Promise<"accept" | "decline"> | "accept" | "decline")
      | undefined;
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
        startAppServer: async (input) => {
          onApprovalRequest = input.onApprovalRequest;
          return {
            endpoint: "unix:///tmp/tellymcp-codex-test.sock",
            cwd: "/workspace",
            diagnostics: {
              status: "ready",
              executablePath: "/bin/codex",
              version: "0.147.0",
              capabilities: {
                appServer: true,
                unixSocketListen: true,
                remoteTui: true,
                schemaGeneration: true,
              },
              message: "ready",
            },
            serverInfo: { userAgent: "codex-cli/0.147.0" },
            client: {
              submitTurn,
              interruptTurn,
              close: closeAppServerClient,
            },
            waitForThread,
            stop: stopAppServer,
          };
        },
        requestApproval,
        notifyTelegram,
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
      thread_id: "thread-1",
    });
    expect(
      service.attachAgent({ session_id: "workspace", agent_id: "codex" }),
    ).toMatchObject({
      ok: true,
      session_id: "workspace",
      agent_id: "codex",
      provider_id: "openai",
      transport: "app-server",
      thread_id: "thread-1",
    });
    expect(sendLine).toHaveBeenCalledOnce();
    expect(waitForThread).toHaveBeenCalledOnce();
    expect(waitForThread.mock.invocationCallOrder[0]).toBeLessThan(
      sendLine.mock.invocationCallOrder[0]!,
    );
    const approvalRequest = {
      requestId: "approval-1",
      kind: "command" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
    };
    await expect(onApprovalRequest?.(approvalRequest)).resolves.toBe("accept");
    expect(requestApproval).toHaveBeenCalledWith({
      sessionId: "workspace",
      request: approvalRequest,
    });
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
    expect(command).toContain(
      "'--ask-for-approval' 'on-request' '--sandbox' 'workspace-write'",
    );
    expect(command).not.toContain("'resume'");
    const sentinel = command.match(/(__TELLYMCP_AGENT_EXIT_[a-f0-9]+__)/u)?.[1];
    expect(sentinel).toBeTruthy();
    onData?.(command);
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      active_agent_id: "codex",
    });
    await expect(
      service.submitMessage({
        session_id: "workspace",
        message: "Continue from Telegram",
      }),
    ).resolves.toEqual({
      handled: true,
      session_id: "workspace",
      agent_id: "codex",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    await expect(
      service.submitMessage({
        session_id: "workspace",
        message: "Second message",
      }),
    ).rejects.toThrow("still running");
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      active_agent_id: "codex",
      turn_in_progress: true,
      active_turn_id: "turn-1",
    });
    await expect(
      service.stopTurn({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      ok: true,
      thread_id: "thread-1",
      turn_id: "turn-1",
      status: "interrupt_requested",
    });
    expect(interruptTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await expect(
      service.submitMessage({
        session_id: "workspace",
        message: "Too early after stop request",
      }),
    ).rejects.toThrow("still running");
    await interruptTurnCallback?.();
    expect(notifyTelegram).toHaveBeenCalledWith({
      sessionId: "workspace",
      message: "Codex turn stopped.",
    });
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      active_agent_id: "codex",
      turn_in_progress: false,
    });
    await service.submitMessage({
      session_id: "workspace",
      message: "Continue after stop",
    });
    await completeTurn?.({
      message: "Done from Codex",
      usage: {
        total: {
          totalTokens: 18,
          inputTokens: 10,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 18,
          inputTokens: 10,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 200000,
      },
    });
    expect(notifyTelegram).toHaveBeenCalledWith({
      sessionId: "workspace",
      message: "Done from Codex",
    });
    await expect(
      service.listAgents({ session_id: "workspace" }),
    ).resolves.toMatchObject({
      codex_runtime: {
        cwd: "/workspace",
        cli_version: "0.147.0",
        server_user_agent: "codex-cli/0.147.0",
        approval_policy: "on-request",
        sandbox: "workspace-write",
        network_access: false,
        last_turn: {
          status: "completed",
          usage: { last: { inputTokens: 10, outputTokens: 8 } },
        },
      },
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

  it("refuses Telegram attach when no Telly-managed agent exists", () => {
    const service = new AgentRuntimeService(
      { terminal: {} } as AppConfig,
      {} as SessionStore,
      { info: vi.fn() } as unknown as Logger,
      {
        inspectProviders: () => [],
      },
    );

    expect(() =>
      service.attachAgent({ session_id: "workspace", agent_id: "codex" }),
    ).toThrow("tellymcp run --agent codex");
  });
});
