import type { Logger } from "../../lib/logger/logger";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramInboxStore,
} from "../../api/storage/contract";
import type {
  TelegramMenuContext,
} from "./transportTypes";
import type { SupportedLocale } from "../../i18n";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import { readMenuPayloadKey } from "./transportUtils";

export interface TransportMenuFingerprintsHost {
  logger: Logger;
  bindingStore: SessionBindingStore;
  inboxStore: TelegramInboxStore;
  sessionStore: SessionStore;
  getMenuPayloadByKey(key: string): Promise<Record<string, unknown> | null>;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  listActiveSessionStorageEntries(sessionId: string): Promise<
    Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  >;
  listActiveSessionScreenshots(sessionId: string): Promise<string[]>;
}

export class TransportMenuFingerprints {
  public constructor(private readonly host: TransportMenuFingerprintsHost) {}

  public async buildMainMenuFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const count = await this.host.inboxStore.countInboxMessages(sessionId);
    return `${locale}:${sessionId}:${count}`;
  }

  public async buildInboxFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const messages = await this.host.inboxStore.listInboxMessages(sessionId, 10);
    return `${locale}:${sessionId}:${messages.map((message) => message.id).join(",")}`;
  }

  public async buildStorageFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const entries = await this.host.listActiveSessionStorageEntries(sessionId);
    return `${locale}:${sessionId}:${entries.map((entry) => entry.filePath).join(",")}`;
  }

  public async buildScreenshotsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const files = await this.host.listActiveSessionScreenshots(sessionId);
    return `${locale}:${sessionId}:${files.join(",")}`;
  }

  public async buildSessionsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    try {
      const locale = await this.host.resolveLocaleForContext(ctx);
      const principal = this.host.getPrincipalFromContext(ctx);
      if (!principal) {
        return `${locale}:no-principal`;
      }

      const activeSessionId =
        await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
      const sessionIds = (
        await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
      ).sort();
      const currentPayloadKey = readMenuPayloadKey(ctx);
      let selectedOwnerLabel = "";
      if (currentPayloadKey) {
        const payload = await this.host.getMenuPayloadByKey(currentPayloadKey);
        if (
          payload &&
          (payload.kind === "session-group" || payload.kind === "active-session") &&
          typeof payload.ownerKey === "string"
        ) {
          selectedOwnerLabel = payload.ownerKey;
        }
      }

      return `${locale}:${activeSessionId ?? "none"}:${selectedOwnerLabel}:${sessionIds.join(",")}`;
    } catch (error) {
      this.host.logger.warn("Failed to build Telegram sessions menu fingerprint", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return "sessions-error";
    }
  }

  public async buildLinkFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return `${locale}:no-active-session`;
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const sessionIds = (
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
    )
      .filter((sessionId) => sessionId !== activeSessionId)
      .sort();

    return `${locale}:${activeSessionId}:${session?.linkedSessionId ?? "none"}:${sessionIds.join(",")}`;
  }

  public async buildInboxButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "menu:inbox.button");
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.host.t(locale, "menu:inbox.button");
    }

    const count = await this.host.inboxStore.countInboxMessages(sessionId);
    return count > 0
      ? this.host.t(locale, "menu:inbox.button_count", { count })
      : this.host.t(locale, "menu:inbox.button");
  }

  public async buildScreenshotsButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "menu:browser.buttons.screenshots");
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.host.t(locale, "menu:browser.buttons.screenshots");
    }

    const count = (await this.host.listActiveSessionScreenshots(sessionId)).length;
    return count > 0
      ? this.host.t(locale, "menu:browser.buttons.screenshots_count", { count })
      : this.host.t(locale, "menu:browser.buttons.screenshots");
  }

  public async buildLinkButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "menu:local.buttons.link");
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.host.t(locale, "menu:local.buttons.link");
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      return this.host.t(locale, "menu:local.buttons.link");
    }

    const linkedSession = await this.host.sessionStore.getSession(
      session.linkedSessionId,
    );
    return linkedSession?.label
      ? this.host.t(locale, "menu:link.buttons.unlink_with_name", {
          sessionName: linkedSession.label,
        })
      : this.host.t(locale, "menu:link.buttons.unlink");
  }
}
