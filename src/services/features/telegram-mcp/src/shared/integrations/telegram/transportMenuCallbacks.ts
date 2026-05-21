import path from "node:path";

import type { TelegramInboxMessage, TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../lib/logger/logger";
import type { TelegramMenuContext } from "./transportTypes";

export interface TransportMenuCallbacksHost {
  logger: Logger;
  getMenuPayloadByKey(key: string): Promise<Record<string, unknown> | null>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu" | "inbox"; sessionId?: string },
    options?: { reply_markup?: unknown },
  ): Promise<void | { message_id: number }>;
  editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: { reply_markup?: unknown },
  ): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showLinkMenu(ctx: TelegramMenuContext): Promise<void>;
  showPartnerMenu(ctx: TelegramMenuContext): Promise<void>;
  showScreenshotsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showStorageMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  inboxMessageMenu: unknown;
  storageMessageMenu: unknown;
  screenshotMessageMenu: unknown;
  xchangeFileMetaStore: {
    getXchangeFileMeta(
      sessionId: string,
      filePath: string,
    ): Promise<TelegramXchangeFileMeta | null>;
    deleteXchangeFileMeta(sessionId: string, filePath: string): Promise<boolean>;
  };
  inboxStore: {
    getInboxMessage(sessionId: string, messageId: string): Promise<TelegramInboxMessage | null>;
    deleteInboxMessage(sessionId: string, messageId: string): Promise<boolean>;
  };
  sessionStore: {
    getSession(sessionId: string): Promise<SessionContext | null>;
  };
  bindingStore: {
    getActiveSessionIdForPrincipal(
      principal: { telegramChatId: number; telegramUserId: number },
    ): Promise<string | null>;
    listBoundSessionIdsForPrincipal(
      principal: { telegramChatId: number; telegramUserId: number },
    ): Promise<string[]>;
    setActiveSessionIdForPrincipal(
      principal: { telegramChatId: number; telegramUserId: number },
      sessionId: string,
    ): Promise<void>;
  };
  objectStore: {
    deleteStoredFile(input: { storageRef?: string; vfsNodeId?: number }): Promise<void>;
  };
  formatInboxDetail(message: TelegramInboxMessage): string;
  formatScreenshotDetail(
    sessionId: string,
    filePath: string,
    meta: TelegramXchangeFileMeta | null,
  ): string;
  formatStorageDetail(
    sessionId: string,
    filePath: string,
    meta: TelegramXchangeFileMeta | null,
  ): string;
  formatFilePreviewLabel(filePath: string, meta: TelegramXchangeFileMeta | null): string;
  listActiveSessionFiles(sessionId: string): Promise<string[]>;
  createPartnerFileTargetPayload(
    sessionId: string,
    targetSessionId: string,
    title: string,
    filePath: string,
  ): Promise<string>;
  ensureStoredXchangeFile(
    sessionId: string,
    filePath: string,
    source: "browser-screenshot" | "telegram-upload",
  ): Promise<{ session: SessionContext | null; filePath: string }>;
  sendDocumentToChat(chatId: number, filePath: string, caption: string): Promise<{ messageId: number }>;
  linkSessions(sessionId: string, targetSessionId: string): Promise<void>;
  maybeNotifyToolsMismatchForSession(sessionId: string): Promise<void>;
}

export class TransportMenuCallbacks {
  public constructor(private readonly host: TransportMenuCallbacksHost) {}

  public async handleInboxMessageOpen(
    ctx: TelegramMenuContext,
    payloadKey: string | null,
  ): Promise<void> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: "Inbox payload is missing.", show_alert: true });
      return;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    if (!payload || payload.kind !== "inbox-message" || !payload.messageId) {
      await ctx.answerCallbackQuery({
        text: "Inbox payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }
    const message = await this.host.inboxStore.getInboxMessage(
      String(payload.sessionId),
      String(payload.messageId),
    );
    if (!message) {
      await ctx.answerCallbackQuery({ text: "Inbox message no longer exists.", show_alert: true });
      return;
    }

    this.host.logger.info("Telegram inbox message opened from menu", {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });
    await ctx.answerCallbackQuery({ text: "Inbox message opened." });
    await this.host.replyText(
      ctx,
      this.host.formatInboxDetail(message),
      { kind: "inbox", sessionId: String(payload.sessionId) },
      { reply_markup: this.host.inboxMessageMenu },
    );
  }

  public async showPartnerEntryPoint(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }
    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "menu:partner.screen.use_link_first"),
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text: await this.host.tForContext(ctx, "menu:partner.actions.open_partner_menu"),
    });
    await this.host.showPartnerMenu(ctx);
  }

  public async showPartnerFiles(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }
    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "menu:partner.screen.use_link_first"),
        show_alert: true,
      });
      return;
    }

    const linkedSession = await this.host.sessionStore.getSession(session.linkedSessionId);
    const files = await this.host.listActiveSessionFiles(sessionId);
    const lines = [
      await this.host.tForContext(ctx, "menu:handoff.choose_title"),
      "",
      await this.host.tForContext(ctx, "menu:handoff.choose_recipient", {
        label: linkedSession?.label ?? session.linkedSessionId,
      }),
      "",
      files.length > 0
        ? await this.host.tForContext(ctx, "menu:handoff.choose_local")
        : await this.host.tForContext(ctx, "menu:handoff.no_files"),
    ];

    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard();
    for (const filePath of files) {
      const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(sessionId, filePath);
      const label = this.host.formatFilePreviewLabel(filePath, meta).slice(0, 56);
      const key = await this.host.createPartnerFileTargetPayload(
        sessionId,
        session.linkedSessionId,
        linkedSession?.label ?? session.linkedSessionId,
        filePath,
      );
      keyboard.text(label, `partner-file-open:${key}`).row();
    }
    keyboard.text(await this.host.tForContext(ctx, "common:menu.back"), "partner-back");
    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, { kind: "menu", sessionId }, { reply_markup: keyboard });
      return;
    }
    await this.host.replyText(ctx, text, { kind: "menu", sessionId }, { reply_markup: keyboard });
  }

  public async handleLinkTargetSelect(
    ctx: TelegramMenuContext,
    payloadKey: string | null,
  ): Promise<void> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: "Link payload is missing.", show_alert: true });
      return;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    if (!payload || payload.kind !== "link-target" || !payload.sessionId || !payload.targetSessionId) {
      await ctx.answerCallbackQuery({ text: "Link payload is invalid or expired.", show_alert: true });
      return;
    }
    await this.host.linkSessions(String(payload.sessionId), String(payload.targetSessionId));
    const linkedSession = await this.host.sessionStore.getSession(String(payload.targetSessionId));
    await ctx.answerCallbackQuery({ text: "Sessions linked." });
    await this.host.showMainMenu(
      ctx,
      linkedSession?.label
        ? `Linked with ${linkedSession.label}. Share API details, changes, errors, and git context with your teammate.`
        : `Linked with ${String(payload.targetSessionId)}. Share API details, changes, errors, and git context with your teammate.`,
    );
  }

  public async handleScreenshotOpen(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Screenshot");
    if (!payload) return;
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(payload.sessionId, payload.filePath);
    await ctx.answerCallbackQuery({ text: "Screenshot opened." });
    await this.host.editText(
      ctx,
      this.host.formatScreenshotDetail(payload.sessionId, payload.filePath, meta),
      { kind: "menu", sessionId: payload.sessionId },
      { reply_markup: this.host.screenshotMessageMenu },
    );
  }

  public async handleScreenshotGet(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Screenshot");
    if (!payload) return;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Telegram chat is unavailable.", show_alert: true });
      return;
    }
    const ensured = await this.host.ensureStoredXchangeFile(payload.sessionId, payload.filePath, "browser-screenshot");
    await this.host.sendDocumentToChat(chatId, ensured.filePath, `Screenshot: ${path.basename(ensured.filePath)}`);
    await ctx.answerCallbackQuery({ text: "Screenshot sent." });
    await this.host.showScreenshotsMenu(ctx, "Screenshot sent to Telegram.");
  }

  public async handleScreenshotDelete(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Screenshot");
    if (!payload) return;
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(payload.sessionId, payload.filePath);
    await this.host.objectStore.deleteStoredFile({
      ...(meta?.storageRef ? { storageRef: meta.storageRef } : {}),
      ...(typeof meta?.vfsNodeId === "number" ? { vfsNodeId: meta.vfsNodeId } : {}),
    });
    await this.host.xchangeFileMetaStore.deleteXchangeFileMeta(payload.sessionId, payload.filePath);
    await ctx.answerCallbackQuery({
      text: meta ? "Screenshot deleted." : "Screenshot already absent.",
    });
    await this.host.showScreenshotsMenu(
      ctx,
      meta ? "Screenshot deleted." : "Screenshot was already removed.",
    );
  }

  public async handleStorageOpen(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Storage");
    if (!payload) return;
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(payload.sessionId, payload.filePath);
    await ctx.answerCallbackQuery({ text: "Storage entry opened." });
    await this.host.editText(
      ctx,
      this.host.formatStorageDetail(payload.sessionId, payload.filePath, meta),
      { kind: "menu", sessionId: payload.sessionId },
      { reply_markup: this.host.storageMessageMenu },
    );
  }

  public async handleStorageGet(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Storage");
    if (!payload) return;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Telegram chat is unavailable.", show_alert: true });
      return;
    }
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(payload.sessionId, payload.filePath);
    let ensured: { session: SessionContext | null; filePath: string };
    try {
      ensured = await this.host.ensureStoredXchangeFile(
        payload.sessionId,
        payload.filePath,
        (meta?.source as "telegram-upload") ?? "telegram-upload",
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message : "Storage file is not available locally.",
        show_alert: true,
      });
      await this.host.showStorageMenu(
        ctx,
        "Storage entry is stale or missing locally. You can delete it from Storage.",
      );
      return;
    }
    await this.host.sendDocumentToChat(
      chatId,
      ensured.filePath,
      `Storage: ${this.host.formatFilePreviewLabel(ensured.filePath, meta)}`,
    );
    await ctx.answerCallbackQuery({ text: "Storage file sent." });
    await this.host.showStorageMenu(ctx, "Storage file sent to Telegram.");
  }

  public async handleStorageDelete(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Storage");
    if (!payload) return;
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(payload.sessionId, payload.filePath);
    await this.host.objectStore.deleteStoredFile({
      ...(meta?.storageRef ? { storageRef: meta.storageRef } : {}),
      ...(typeof meta?.vfsNodeId === "number" ? { vfsNodeId: meta.vfsNodeId } : {}),
    });
    await this.host.xchangeFileMetaStore.deleteXchangeFileMeta(payload.sessionId, payload.filePath);
    await ctx.answerCallbackQuery({
      text: "Storage metadata deleted.",
    });
    await this.host.showStorageMenu(ctx, "Stale storage metadata deleted.");
  }

  public async handleInboxMessageDelete(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: "Inbox payload is missing.", show_alert: true });
      return;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    if (!payload || payload.kind !== "inbox-message" || !payload.messageId) {
      await ctx.answerCallbackQuery({ text: "Inbox payload is invalid or expired.", show_alert: true });
      return;
    }
    const deleted = await this.host.inboxStore.deleteInboxMessage(
      String(payload.sessionId),
      String(payload.messageId),
    );
    this.host.logger.info("Telegram inbox message deleted from menu", {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      deleted,
    });
    await ctx.answerCallbackQuery({
      text: deleted ? "Inbox message deleted." : "Inbox message already absent.",
    });
    await ctx.deleteMessage().catch(async () => {
      await ctx.editMessageText(deleted ? "Inbox message deleted." : "Inbox message was already removed.");
    });
  }

  public async handleSessionSelection(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: "Session payload is missing.", show_alert: true });
      return;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    if (!payload || payload.kind !== "active-session") {
      await ctx.answerCallbackQuery({ text: "Session payload is invalid or expired.", show_alert: true });
      return;
    }
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({ text: "Telegram user or chat is missing.", show_alert: true });
      return;
    }
    const sessionIds = await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);
    if (!sessionIds.includes(String(payload.sessionId))) {
      await ctx.answerCallbackQuery({
        text: "This session is not linked to your Telegram identity.",
        show_alert: true,
      });
      return;
    }
    await this.host.bindingStore.setActiveSessionIdForPrincipal(principal, String(payload.sessionId));
    const session = await this.host.sessionStore.getSession(String(payload.sessionId));
    this.host.logger.info("Telegram active session changed", {
      sessionId: payload.sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });
    await this.host.maybeNotifyToolsMismatchForSession(String(payload.sessionId));
    await ctx.answerCallbackQuery({
      text: session?.label ? `Active session: ${session.label}` : `Active session: ${String(payload.sessionId)}`,
    });
    await this.host.showMainMenu(ctx);
  }

  private async requireFileEntryPayload(
    ctx: TelegramMenuContext,
    payloadKey: string | null,
    kindLabel: string,
  ): Promise<{ sessionId: string; filePath: string } | null> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: `${kindLabel} payload is missing.`, show_alert: true });
      return null;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: `${kindLabel} payload is invalid or expired.`,
        show_alert: true,
      });
      return null;
    }
    return {
      sessionId: String(payload.sessionId),
      filePath: String(payload.filePath),
    };
  }
}
