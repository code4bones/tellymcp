import type { AppConfig } from "../../../app/config/env";
import type { SessionStore, SessionBindingStore } from "../../api/storage/contract";
import type { SupportedLocale } from "../../i18n";
import type { TelegramMenuContext } from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportLinkingActionsHost {
  config: AppConfig;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  showMainMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showLinkMenu(ctx: TelegramMenuContext): Promise<void>;
  showLocalMenu(ctx: TelegramMenuContext): Promise<void>;
  showProjectsMenu(ctx: TelegramMenuContext): Promise<void>;
}

export class TransportLinkingActions {
  public constructor(private readonly host: TransportLinkingActionsHost) {}

  public async handleLinkButton(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (session?.linkedSessionId) {
      await this.unlinkSessions(sessionId, session.linkedSessionId);
      const text = this.host.t(locale, "menu:link.actions.unlinked");
      await ctx.answerCallbackQuery({ text });
      await this.host.showMainMenu(ctx, text);
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:link.actions.choose_partner"),
    });
    await this.host.showLinkMenu(ctx);
  }

  public async showLocalEntryPoint(ctx: TelegramMenuContext): Promise<void> {
    await ctx.answerCallbackQuery({
      text: await this.host.tForContext(ctx, "menu:local.actions.open_local"),
    });
    await this.host.showLocalMenu(ctx);
  }

  public async showProjectsEntryPoint(ctx: TelegramMenuContext): Promise<void> {
    if (!this.host.config.distributed.gatewayPublicUrl) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "menu:collab.actions.gateway_only"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: await this.host.tForContext(ctx, "menu:collab.actions.open_collab"),
    });
    await this.host.showProjectsMenu(ctx);
  }

  public async linkSessions(
    sessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    if (sessionId === targetSessionId) {
      throw new Error("A session cannot be linked to itself.");
    }

    const sourceSession = await this.host.sessionStore.getSession(sessionId);
    const targetSession = await this.host.sessionStore.getSession(targetSessionId);
    if (!sourceSession || !targetSession) {
      throw new Error("Source or target session does not exist.");
    }

    await this.unlinkSessions(sessionId, sourceSession.linkedSessionId);
    await this.unlinkSessions(targetSessionId, targetSession.linkedSessionId);

    await this.host.sessionStore.setSession({
      ...sourceSession,
      linkedSessionId: targetSessionId,
      updatedAt: new Date().toISOString(),
    });
    await this.host.sessionStore.setSession({
      ...targetSession,
      linkedSessionId: sessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  public async unlinkSessions(
    sessionId: string,
    linkedSessionId?: string | undefined,
  ): Promise<void> {
    const sourceSession = await this.host.sessionStore.getSession(sessionId);
    if (!sourceSession) {
      return;
    }

    const partnerId = linkedSessionId ?? sourceSession.linkedSessionId;
    if (sourceSession.linkedSessionId) {
      const { linkedSessionId: _linkedSessionId, ...rest } = sourceSession;
      await this.host.sessionStore.setSession({
        ...rest,
        updatedAt: new Date().toISOString(),
      });
    }

    if (!partnerId) {
      return;
    }

    const partnerSession = await this.host.sessionStore.getSession(partnerId);
    if (!partnerSession || partnerSession.linkedSessionId !== sessionId) {
      return;
    }

    const { linkedSessionId: _partnerLinkedSessionId, ...restPartner } =
      partnerSession;
    await this.host.sessionStore.setSession({
      ...restPartner,
      updatedAt: new Date().toISOString(),
    });
  }
}
