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
};

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
  ): Promise<void> {
    const active = await this.getActiveSession(ctx);
    if (!active) {
      return;
    }

    let status: AgentStatusResponse;
    try {
      status = await this.host.callGatewayJson<AgentStatusResponse>(
        "/agent/status",
        { session_id: active.sessionId },
      );
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
    const text = [
      this.host.t(active.locale, "menu:agents.screen.title"),
      "",
      this.host.t(active.locale, "menu:agents.screen.active_session", {
        sessionName: active.sessionName,
      }),
      ...lines,
      "",
      status.active_agent_id
        ? status.turn_in_progress
          ? this.host.t(active.locale, "menu:agents.screen.turn_running_hint")
          : this.host.t(active.locale, "menu:agents.screen.running_hint")
        : this.host.t(active.locale, "menu:agents.screen.choose_hint"),
    ].join("\n");

    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu", sessionId: active.sessionId },
      this.host.getAgentMenu(),
    );
  }

  public async startAgent(
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
      }>("/agent/start", {
        session_id: active.sessionId,
        agent_id: agentId,
      });
      await ctx.answerCallbackQuery({
        text: this.host.t(active.locale, "menu:agents.actions.started", {
          agentName: result.agent_id,
        }),
      });
      await this.showAgentMenu(
        ctx,
        this.host.t(active.locale, "menu:agents.screen.started", {
          agentName: result.agent_id,
        }),
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
