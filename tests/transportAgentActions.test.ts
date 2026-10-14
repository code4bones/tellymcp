import { describe, expect, it, vi } from "vitest";

import { TransportAgentActions } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportAgentActions";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

function createContext() {
  return {
    chat: { id: 42 },
    from: { id: 7 },
    answerCallbackQuery: vi.fn(async () => undefined),
  } as unknown as TelegramMenuContext;
}

function createHost(callGatewayJson: ReturnType<typeof vi.fn>) {
  const routes = new Map<
    string,
    { mode: "pty" } | { mode: "agent"; agentId: "codex" | "claude" }
  >();
  return {
    bindingStore: {
      getActiveSessionIdForPrincipal: vi.fn(async () => "relay-session"),
      getConsoleDeliveryRoute: vi.fn(
        async (_principal: unknown, sessionId: string) =>
          routes.get(sessionId) ?? ({ mode: "pty" } as const),
      ),
      setConsoleDeliveryRoute: vi.fn(
        async (
          _principal: unknown,
          sessionId: string,
          route:
            | { mode: "pty" }
            | { mode: "agent"; agentId: "codex" | "claude" },
        ) => {
          routes.set(sessionId, route);
        },
      ),
    },
    sessionStore: {
      getSession: vi.fn(async () => ({
        sessionId: "relay-session",
        label: "Backend",
      })),
    },
    resolveLocaleForContext: vi.fn(async () => "en" as const),
    getPrincipalFromContext: vi.fn(() => ({
      telegramChatId: 42,
      telegramUserId: 7,
    })),
    t: vi.fn(
      (_locale: string, key: string, vars?: Record<string, unknown>) =>
        `${key}${vars ? ` ${JSON.stringify(vars)}` : ""}`,
    ),
    callGatewayJson,
    renderMenuScreen: vi.fn(async () => undefined),
    getAgentMenu: vi.fn(() => ({ id: "agent-menu" })),
  };
}

describe("TransportAgentActions", () => {
  it("renders remote provider availability for the active console", async () => {
    const callGatewayJson = vi.fn(async () => ({
      session_id: "workspace",
      agents: [
        {
          providerId: "openai",
          providerName: "OpenAI",
          agentId: "codex",
          agentName: "Codex",
          available: true,
          state: "idle",
        },
      ],
    }));
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);

    await actions.showAgentMenu(createContext());

    expect(callGatewayJson).toHaveBeenCalledWith("/agent/status", {
      session_id: "relay-session",
      telegram_user_id: 7,
    });
    expect(host.renderMenuScreen).toHaveBeenCalledOnce();
    expect(String(host.renderMenuScreen.mock.calls[0]?.[1])).toContain(
      "menu:agents.states.ready",
    );
  });

  it("renders an unavailable menu when the gateway returns no agent list", async () => {
    const callGatewayJson = vi.fn(async () => ({
      ok: false,
      error: "Remote agent runtime failed",
    }));
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);

    await expect(
      actions.showAgentMenu(createContext()),
    ).resolves.toBeUndefined();

    expect(host.renderMenuScreen).toHaveBeenCalledOnce();
    expect(String(host.renderMenuScreen.mock.calls[0]?.[1])).toContain(
      "menu:agents.screen.unavailable",
    );
    expect(String(host.renderMenuScreen.mock.calls[0]?.[1])).toContain(
      "Remote agent runtime failed",
    );
  });

  it("attaches to an agent already managed by the active console", async () => {
    const callGatewayJson = vi.fn(async (path: string) =>
      path === "/agent/attach"
        ? { agent_id: "claude", provider_id: "anthropic" }
        : {
            session_id: "workspace",
            active_agent_id: "claude",
            agents: [],
          },
    );
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);

    await actions.attachAgent(createContext(), "claude");

    expect(callGatewayJson).toHaveBeenNthCalledWith(1, "/agent/attach", {
      session_id: "relay-session",
      agent_id: "claude",
      telegram_user_id: 7,
    });
    expect(callGatewayJson).toHaveBeenNthCalledWith(2, "/agent/status", {
      session_id: "relay-session",
      telegram_user_id: 7,
    });
    expect(host.bindingStore.setConsoleDeliveryRoute).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "relay-session",
      { mode: "agent", agentId: "claude" },
    );
    const rendered = String(host.renderMenuScreen.mock.calls[0]?.[1]);
    expect(rendered).toContain("menu:agents.screen.chat_ready_hint");
    expect(rendered).not.toContain("menu:agents.screen.running_hint");
  });

  it("switches Telegram message delivery back to PTY", async () => {
    const callGatewayJson = vi.fn(async () => ({
      session_id: "workspace",
      active_agent_id: "codex",
      agents: [],
    }));
    const host = createHost(callGatewayJson);
    await host.bindingStore.setConsoleDeliveryRoute(
      { telegramChatId: 42, telegramUserId: 7 },
      "relay-session",
      { mode: "agent", agentId: "codex" },
    );
    host.bindingStore.setConsoleDeliveryRoute.mockClear();
    const actions = new TransportAgentActions(host);

    await actions.useTerminal(createContext());

    expect(host.bindingStore.setConsoleDeliveryRoute).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "relay-session",
      { mode: "pty" },
    );
    expect(String(host.renderMenuScreen.mock.calls[0]?.[1])).toContain(
      "menu:agents.screen.route_pty",
    );
  });

  it("does not fall back to launching an unmanaged agent", async () => {
    const callGatewayJson = vi.fn(async () => {
      throw new Error(
        "No Telly-managed Codex conversation is running. Start it locally with 'tellymcp run --agent codex'.",
      );
    });
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);
    const ctx = createContext();

    await actions.attachAgent(ctx, "codex");

    expect(callGatewayJson).toHaveBeenCalledOnce();
    expect(callGatewayJson).toHaveBeenCalledWith("/agent/attach", {
      session_id: "relay-session",
      agent_id: "codex",
      telegram_user_id: 7,
    });
    expect(host.bindingStore.setConsoleDeliveryRoute).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it("renders Codex policy, version, and bounded last-turn usage", async () => {
    const callGatewayJson = vi.fn(async () => ({
      session_id: "workspace",
      active_agent_id: "codex",
      turn_in_progress: false,
      agents: [],
      codex_runtime: {
        cli_version: "0.147.0",
        approval_policy: "on-request",
        sandbox: "workspace-write",
        network_access: false,
        last_turn: {
          status: "completed",
          usage: { last: { inputTokens: 10, outputTokens: 8 } },
        },
      },
    }));
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);

    await actions.showAgentMenu(createContext());

    const rendered = String(host.renderMenuScreen.mock.calls[0]?.[1]);
    expect(rendered).toContain("menu:agents.screen.codex_policy");
    expect(rendered).toContain("menu:agents.screen.codex_version");
    expect(rendered).toContain("menu:agents.screen.last_usage");
    expect(rendered).not.toContain("thread_id");
  });

  it("requests stopping the active turn and refreshes the agent menu", async () => {
    const callGatewayJson = vi.fn(async (path: string) =>
      path === "/agent/stop"
        ? { ok: true, status: "interrupt_requested" }
        : {
            session_id: "workspace",
            active_agent_id: "codex",
            turn_in_progress: true,
            agents: [],
          },
    );
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);
    const ctx = createContext();

    await actions.stopTurn(ctx);

    expect(callGatewayJson).toHaveBeenNthCalledWith(1, "/agent/stop", {
      session_id: "relay-session",
      telegram_user_id: 7,
    });
    expect(callGatewayJson).toHaveBeenNthCalledWith(2, "/agent/status", {
      session_id: "relay-session",
      telegram_user_id: 7,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "menu:agents.actions.stop_requested",
    });
  });
});
