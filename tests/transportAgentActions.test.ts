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
  return {
    bindingStore: {
      getActiveSessionIdForPrincipal: vi.fn(async () => "relay-session"),
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
    });
    expect(host.renderMenuScreen).toHaveBeenCalledOnce();
    expect(String(host.renderMenuScreen.mock.calls[0]?.[1])).toContain(
      "menu:agents.states.ready",
    );
  });

  it("starts the selected agent on the active console", async () => {
    const callGatewayJson = vi.fn(async (path: string) =>
      path === "/agent/start"
        ? { agent_id: "claude", provider_id: "anthropic" }
        : {
            session_id: "workspace",
            active_agent_id: "claude",
            agents: [],
          },
    );
    const host = createHost(callGatewayJson);
    const actions = new TransportAgentActions(host);

    await actions.startAgent(createContext(), "claude");

    expect(callGatewayJson).toHaveBeenNthCalledWith(1, "/agent/start", {
      session_id: "relay-session",
      agent_id: "claude",
    });
    expect(callGatewayJson).toHaveBeenNthCalledWith(2, "/agent/status", {
      session_id: "relay-session",
    });
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
    });
    expect(callGatewayJson).toHaveBeenNthCalledWith(2, "/agent/status", {
      session_id: "relay-session",
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "menu:agents.actions.stop_requested",
    });
  });
});
