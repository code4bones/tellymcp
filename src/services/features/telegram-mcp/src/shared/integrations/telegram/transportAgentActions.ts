import type { SupportedLocale } from "../../i18n";
import type { TelegramMenuContext } from "./transportTypes";

type AgentStatus = {
  providerId: string;
  providerName: string;
  agentId: string;
  agentName: string;
  available: boolean;
  state: "idle" | "running";
};

type AgentStatusResponse = {
  session_id: string;
  agents: AgentStatus[];
  active_agent_id?: string | undefined;
  turn_in_progress?: boolean | undefined;
  active_turn_id?: string | undefined;
  codex_runtime?:
    | {
        cli_version?: string | undefined;
        approval_policy: string;
        sandbox: string;
        network_access: boolean;
        last_turn?: {
          status: string;
          usage?: {
            last: { inputTokens: number; outputTokens: number };
          };
        };
      }
    | undefined;
};

function getInvalidStatusMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string" &&
    value.error.trim()
  ) {
    return value.error.trim().slice(0, 400);
  }

  return "Invalid agent status response from gateway.";
}

export interface TransportAgentActionsHost {
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: {
      telegramChatId: number;
      telegramUserId: number;
    }): Promise<string | null>;
  };
  sessionStore: {
    getSession(sessionId: string): Promise<{
      sessionId: string;
      label?: string | undefined;
    } | null>;
  };
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  callGatewayJson<T>(
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  getAgentMenu(): unknown;
}

export class TransportAgentActions {
  public constructor(private readonly host: TransportAgentActionsHost) {}

  private async getActiveSession(ctx: TelegramMenuContext): Promise<{
    locale: SupportedLocale;
    sessionId: string;
    sessionName: string;
  } | null> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return null;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return null;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    return {
      locale,
      sessionId,
      sessionName: session?.label?.trim() || sessionId,
    };
  }

  public async showAgentMenu(
    ctx: TelegramMenuContext,
    introText?: string,
    chatReady = false,
  ): Promise<void> {
    const active = await this.getActiveSession(ctx);
    if (!active) {
      return;
    }

    let status: AgentStatusResponse;
    try {
      const response = await this.host.callGatewayJson<unknown>(
        "/agent/status",
        { session_id: active.sessionId },
      );
      if (
        !response ||
        typeof response !== "object" ||
        !("agents" in response) ||
        !Array.isArray(response.agents)
      ) {
        throw new Error(getInvalidStatusMessage(response));
      }
      status = response as AgentStatusResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.host.renderMenuScreen(
        ctx,
        [
          this.host.t(active.locale, "menu:agents.screen.title"),
          "",
          this.host.t(active.locale, "menu:agents.screen.active_session", {
            sessionName: active.sessionName,
          }),
          this.host.t(active.locale, "menu:agents.screen.unavailable", {
            message,
          }),
        ].join("\n"),
        { kind: "menu", sessionId: active.sessionId },
        this.host.getAgentMenu(),
      );
      return;
    }

    const lines = status.agents.map((agent) => {
      const state =
        agent.state === "running"
          ? this.host.t(active.locale, "menu:agents.states.running")
          : agent.available
            ? this.host.t(active.locale, "menu:agents.states.ready")
            : this.host.t(active.locale, "menu:agents.states.missing");
      return this.host.t(active.locale, "menu:agents.screen.provider", {
        agentName: agent.agentName,
        providerName: agent.providerName,
        state,
      });
    });
    const runtimeLines = status.codex_runtime
      ? [
          this.host.t(active.locale, "menu:agents.screen.codex_policy", {
            sandbox: status.codex_runtime.sandbox,
            approvalPolicy: status.codex_runtime.approval_policy,
            network: status.codex_runtime.network_access ? "on" : "off",
          }),
          ...(status.codex_runtime.cli_version
            ? [
                this.host.t(active.locale, "menu:agents.screen.codex_version", {
                  version: status.codex_runtime.cli_version,
                }),
              ]
            : []),
          ...(status.codex_runtime.last_turn?.usage
            ? [
                this.host.t(active.locale, "menu:agents.screen.last_usage", {
                  inputTokens:
                    status.codex_runtime.last_turn.usage.last.inputTokens,
                  outputTokens:
                    status.codex_runtime.last_turn.usage.last.outputTokens,
                }),
              ]
            : []),
        ]
      : [];
    const text = [
      this.host.t(active.locale, "menu:agents.screen.title"),
      "",
      this.host.t(active.locale, "menu:agents.screen.active_session", {
        sessionName: active.sessionName,
      }),
      ...lines,
      ...runtimeLines,
      "",
      status.active_agent_id
        ? status.turn_in_progress
          ? this.host.t(active.locale, "menu:agents.screen.turn_running_hint")
          : this.host.t(
              active.locale,
              chatReady
                ? "menu:agents.screen.chat_ready_hint"
                : "menu:agents.screen.running_hint",
            )
        : this.host.t(active.locale, "menu:agents.screen.choose_hint"),
    ].join("\n");

    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu", sessionId: active.sessionId },
      this.host.getAgentMenu(),
    );
  }

  public async attachAgent(
    ctx: TelegramMenuContext,
    agentId: "codex" | "claude",
  ): Promise<void> {
    const active = await this.getActiveSession(ctx);
    if (!active) {
      return;
    }

    try {
      const result = await this.host.callGatewayJson<{
        agent_id: string;
        provider_id: string;
      }>("/agent/attach", {
        session_id: active.sessionId,
        agent_id: agentId,
      });
      await ctx.answerCallbackQuery({
        text: this.host.t(active.locale, "menu:agents.actions.attached", {
          agentName: result.agent_id,
        }),
      });
      await this.showAgentMenu(
        ctx,
        this.host.t(active.locale, "menu:agents.screen.attached", {
          agentName: result.agent_id,
        }),
        true,
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text:
          error instanceof Error
            ? error.message.slice(0, 180)
            : String(error).slice(0, 180),
        show_alert: true,
      });
    }
  }

  public async stopTurn(ctx: TelegramMenuContext): Promise<void> {
    const active = await this.getActiveSession(ctx);
    if (!active) {
      return;
    }

    try {
      await this.host.callGatewayJson("/agent/stop", {
        session_id: active.sessionId,
      });
      await ctx.answerCallbackQuery({
        text: this.host.t(active.locale, "menu:agents.actions.stop_requested"),
      });
      await this.showAgentMenu(
        ctx,
        this.host.t(active.locale, "menu:agents.screen.stop_requested"),
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text:
          error instanceof Error
            ? error.message.slice(0, 180)
            : String(error).slice(0, 180),
        show_alert: true,
      });
    }
  }
}
