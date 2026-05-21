import { buildPrincipalKey } from "./transportUtils";
import type { PendingBroadcastRecord, PendingRenameRecord, SendMessageMeta, TelegramMenuContext, TelegramSendMessageOptions } from "./transportTypes";
import type { AppConfig } from "../../../app/config/env";
import type { MaintenanceStore, SessionBindingStore, SessionStore } from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import type { SupportedLocale } from "../../i18n";

export interface TransportSessionActionsHost {
  logger: Logger;
  config: AppConfig;
  bindingStore: SessionBindingStore;
  sessionStore: SessionStore;
  maintenanceStore: MaintenanceStore;
  pendingRenames: Map<string, PendingRenameRecord>;
  pendingBroadcasts: Map<string, PendingBroadcastRecord>;
  getMainMenu(): unknown;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  t(locale: SupportedLocale, key: string, options?: Record<string, unknown>): string;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options?: TelegramSendMessageOptions,
  ): Promise<{ message_id: number } | void>;
  showSessionsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  clearPendingInteractionsForContext(ctx: TelegramMenuContext): void;
  clearTmuxNudgeDebounceTimers(): void;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportSessionActions {
  public constructor(private readonly host: TransportSessionActionsHost) {}

  public async unpairActiveSession(ctx: TelegramMenuContext): Promise<void> {
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
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (session && this.host.config.distributed.gatewayPublicUrl) {
      const clientUuid = await this.host.maintenanceStore.getGatewayClientUuid();
      if (clientUuid) {
        await this.host.callGatewayJson("/sessions/unregister", {
          client_uuid: clientUuid,
          local_session_id: sessionId,
        });
      }
      await this.host.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.host.bindingStore.clearBinding(sessionId);

    this.host.logger.info("Telegram active session unpaired from menu", {
      sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    this.host.clearPendingInteractionsForContext(ctx);

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:unpair.done", {
        sessionName: session?.label ?? sessionId,
      }),
    });
    await this.host.showSessionsMenu(
      ctx,
      this.host.t(locale, "menu:unpair.shown", {
        sessionName: session?.label ?? sessionId,
      }),
    );
  }

  public async beginRenameActiveSession(ctx: TelegramMenuContext): Promise<void> {
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
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.host.pendingBroadcasts.delete(principalKey);
    this.host.pendingRenames.set(principalKey, { sessionId });
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:settings.actions.rename_prompt"),
    });
    await this.host.replyText(
      ctx,
      ["✏ Rename session", "", this.host.t(locale, "menu:settings.actions.rename_body")].join(
        "\n",
      ),
      { kind: "menu", sessionId },
    );
  }

  public async pruneAllSessions(ctx: TelegramMenuContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: "Pruning all state..." });
    const result = await this.host.maintenanceStore.pruneAll();
    this.host.clearPendingInteractionsForContext(ctx);
    this.host.clearTmuxNudgeDebounceTimers();
    await this.host.showSessionsMenu(
      ctx,
      `Prune complete. Deleted ${result.deletedKeys} Redis keys.`,
    );
  }

  public async handlePendingRename(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const pending = this.host.pendingRenames.get(buildPrincipalKey(principal));
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.host.pendingRenames.delete(buildPrincipalKey(principal));
      return false;
    }

    const session = await this.host.sessionStore.getSession(pending.sessionId);
    const updatedAt = new Date().toISOString();
    const label = redactSecrets(text);

    await this.host.sessionStore.setSession({
      sessionId: pending.sessionId,
      label,
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.linkedSessionId
        ? { linkedSessionId: session.linkedSessionId }
        : {}),
      ...(session?.task ? { task: session.task } : {}),
      ...(session?.summary ? { summary: session.summary } : {}),
      ...(session?.files ? { files: session.files } : {}),
      ...(session?.decisions ? { decisions: session.decisions } : {}),
      ...(session?.risks ? { risks: session.risks } : {}),
      ...(session?.tmuxSessionName
        ? { tmuxSessionName: session.tmuxSessionName }
        : {}),
      ...(session?.tmuxWindowName
        ? { tmuxWindowName: session.tmuxWindowName }
        : {}),
      ...(typeof session?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: session.tmuxWindowIndex }
        : {}),
      ...(session?.tmuxPaneId ? { tmuxPaneId: session.tmuxPaneId } : {}),
      ...(typeof session?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: session.tmuxPaneIndex }
        : {}),
      ...(session?.tmuxTarget ? { tmuxTarget: session.tmuxTarget } : {}),
      ...(session?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: session.lastTmuxNudgeAt }
        : {}),
      updatedAt,
    });

    this.host.pendingRenames.delete(buildPrincipalKey(principal));
    this.host.logger.info("Telegram session renamed from menu", {
      sessionId: pending.sessionId,
      sessionLabel: label,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await this.host.replyText(
      ctx,
        `Session renamed: ${label}`,
      { kind: "menu", sessionId: pending.sessionId },
      {
        reply_markup:
          this.host.getMainMenu() as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
      },
    );
    return true;
  }
}
