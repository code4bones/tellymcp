import path from "node:path";

import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
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
  showSessionsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showScreenshotsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showStorageMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  storageMessageMenu: unknown;
  screenshotMessageMenu: unknown;
  xchangeFileMetaStore: {
    getXchangeFileMeta(
      sessionId: string,
      filePath: string,
    ): Promise<TelegramXchangeFileMeta | null>;
    deleteXchangeFileMeta(sessionId: string, filePath: string): Promise<boolean>;
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
  maybeNotifyToolsMismatchForSession(sessionId: string): Promise<void>;
  callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
}

export class TransportMenuCallbacks {
  public constructor(private readonly host: TransportMenuCallbacksHost) {}

  public async handleScreenshotOpen(ctx: TelegramMenuContext, payloadKey: string | null): Promise<void> {
    const payload = await this.requireFileEntryPayload(ctx, payloadKey, "Screenshot");
    if (!payload) return;
    const meta = await this.getXchangeFileMeta(payload.sessionId, payload.filePath);
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
    if (this.isRelaySessionId(payload.sessionId)) {
      await this.host.callGatewayJson("/transport/send-file", {
        session_id: payload.sessionId,
        file_path: payload.filePath,
        caption: `Screenshot: ${path.basename(payload.filePath)}`,
      });
      await ctx.answerCallbackQuery({ text: "Screenshot sent." });
      await this.host.showScreenshotsMenu(ctx, "Screenshot sent to Telegram.");
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
    const meta = await this.getXchangeFileMeta(payload.sessionId, payload.filePath);
    if (this.isRelaySessionId(payload.sessionId)) {
      await this.deleteXchangeFileMeta(payload.sessionId, payload.filePath);
      await ctx.answerCallbackQuery({
        text: meta ? "Screenshot deleted." : "Screenshot already absent.",
      });
      await this.host.showScreenshotsMenu(
        ctx,
        meta ? "Screenshot deleted." : "Screenshot was already removed.",
      );
      return;
    }
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
    const meta = await this.getXchangeFileMeta(payload.sessionId, payload.filePath);
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
    const meta = await this.getXchangeFileMeta(payload.sessionId, payload.filePath);
    if (this.isRelaySessionId(payload.sessionId)) {
      await this.host.callGatewayJson("/transport/send-file", {
        session_id: payload.sessionId,
        file_path: payload.filePath,
        caption: `Storage: ${this.host.formatFilePreviewLabel(payload.filePath, meta)}`,
      });
      await ctx.answerCallbackQuery({ text: "Storage file sent." });
      await this.host.showStorageMenu(ctx, "Storage file sent to Telegram.");
      return;
    }
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
    const meta = await this.getXchangeFileMeta(payload.sessionId, payload.filePath);
    if (this.isRelaySessionId(payload.sessionId)) {
      await this.deleteXchangeFileMeta(payload.sessionId, payload.filePath);
      await ctx.answerCallbackQuery({
        text: "Storage metadata deleted.",
      });
      await this.host.showStorageMenu(ctx, "Stale storage metadata deleted.");
      return;
    }
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

  public async handleSessionGroupSelection(
    ctx: TelegramMenuContext,
    payloadKey: string | null,
  ): Promise<void> {
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: "Session group payload is missing.", show_alert: true });
      return;
    }
    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    this.host.logger.info("Telegram session group payload lookup", {
      payloadKey,
      payload,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });
    if (!payload || payload.kind !== "session-group") {
      await ctx.answerCallbackQuery({ text: "Session group payload is invalid or expired.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({
      text:
        typeof payload.ownerLabel === "string" && payload.ownerLabel.trim()
          ? payload.ownerLabel
          : "Sessions",
    });
    await this.host.showSessionsMenu(ctx);
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

    const sessionId = String(payload.sessionId ?? "").trim();
    const filePath = String(payload.filePath).trim();
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: `${kindLabel} session is missing in payload.`,
        show_alert: true,
      });
      return null;
    }

    const relay = parseLiveRelaySessionId(sessionId);
    if (!relay?.localSessionId) {
      return { sessionId, filePath };
    }

    const localSession = await this.host.sessionStore.getSession(relay.localSessionId);
    if (!localSession) {
      return { sessionId, filePath };
    }

    return {
      sessionId: relay.localSessionId,
      filePath,
    };
  }

  private isRelaySessionId(sessionId: string): boolean {
    return Boolean(parseLiveRelaySessionId(sessionId));
  }

  private async getXchangeFileMeta(
    sessionId: string,
    filePath: string,
  ): Promise<TelegramXchangeFileMeta | null> {
    if (this.isRelaySessionId(sessionId)) {
      const output = await this.host.callGatewayJson<{
        meta?: TelegramXchangeFileMeta | null;
      }>("/storage/meta", {
        session_id: sessionId,
        file_path: filePath,
      });
      return output.meta ?? null;
    }

    return this.host.xchangeFileMetaStore.getXchangeFileMeta(sessionId, filePath);
  }

  private async deleteXchangeFileMeta(
    sessionId: string,
    filePath: string,
  ): Promise<boolean> {
    if (this.isRelaySessionId(sessionId)) {
      const output = await this.host.callGatewayJson<{ deleted?: boolean }>(
        "/storage/delete-meta",
        {
          session_id: sessionId,
          file_path: filePath,
        },
      );
      return output.deleted === true;
    }

    return this.host.xchangeFileMetaStore.deleteXchangeFileMeta(
      sessionId,
      filePath,
    );
  }
}
