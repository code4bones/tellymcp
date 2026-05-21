import path from "node:path";

import { createInboxMessageId } from "../../lib/ids/ids";
import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import type { PartnerNoteKind, SendPartnerNoteOutput } from "../../../entities/collaboration/model/types";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramAdminAuthStore,
  TelegramInboxStore,
} from "../../api/storage/contract";
import type { HumanTransportReply } from "../../api/transport/contract";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import {
  buildPrincipalKey,
  isGatewayAdminCommand,
  isGatewayLinkCommand,
  isHelpCommand,
  isMenuEntryCommand,
  parseAdminAuthCommand,
  parsePairingCode,
} from "./transportUtils";
import type {
  GatewayRelayBindingPayload,
  StoredAttachmentRecord,
  TelegramAttachmentDescriptor,
  TelegramMenuContext,
  TelegramSendMessageOptions,
  WaiterRecord,
  SendMessageMeta,
} from "./transportTypes";

export interface TransportMessageFlowHost {
  logger: Logger;
  config: {
    distributed: { gatewayPublicUrl?: string | null };
    telegram: { adminToken?: string | null };
  };
  bindingStore: SessionBindingStore;
  sessionStore: SessionStore;
  inboxStore: TelegramInboxStore;
  adminAuthStore: TelegramAdminAuthStore;
  waiters: Map<string, WaiterRecord>;
  currentAttachmentTargets: Map<
    string,
    {
      sessionId: string;
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    }
  >;
  isAdminAuthEnabled(): boolean;
  isAdminBotProfile(): boolean;
  isPrincipalAdminAuthorized(
    principal: { telegramChatId: number; telegramUserId: number } | null,
  ): Promise<boolean>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  extractIncomingText(
    message: TelegramMenuContext["message"] | undefined,
  ): string | null;
  collectIncomingAttachments(
    message: TelegramMenuContext["message"] | undefined,
  ): TelegramAttachmentDescriptor[];
  buildInboxText(text: string | null, attachments: string[]): string;
  clearPendingInteractionsForContext(ctx: TelegramMenuContext): void;
  handlePendingRename(ctx: TelegramMenuContext, text: string): Promise<boolean>;
  handlePendingBroadcast(ctx: TelegramMenuContext, text: string): Promise<boolean>;
  handlePendingPartnerNote(ctx: TelegramMenuContext, text: string): Promise<boolean>;
  handlePendingFileHandoff(ctx: TelegramMenuContext, text: string): Promise<boolean>;
  handlePendingProject(ctx: TelegramMenuContext, text: string): Promise<boolean>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: SendMessageMeta,
    options?: TelegramSendMessageOptions,
  ): Promise<void | { message_id: number }>;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  showSessionsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showHelp(ctx: TelegramMenuContext): Promise<void>;
  showAdminMainMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showAdminClientsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  mainMenu: unknown;
  bindRelaySessionToPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
    payload: GatewayRelayBindingPayload;
  }): Promise<SessionContext>;
  clearWaiter(requestId: string): void;
  callGatewayJson<T>(path: string, payload?: unknown): Promise<T>;
  scheduleTmuxNudgeForInboxMessage(
    sessionId: string,
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): void;
  downloadIncomingAttachments(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    sourceTelegramMessageId: number,
    attachments: TelegramAttachmentDescriptor[],
  ): Promise<StoredAttachmentRecord[]>;
  storeTelegramUploadMetas(input: {
    sessionId: string;
    sourceTelegramMessageId: number;
    uploadedAt: string;
    attachments: StoredAttachmentRecord[];
    descriptors?: TelegramAttachmentDescriptor[] | undefined;
    caption?: string | undefined;
  }): Promise<void>;
  deliverAttachmentToPartner(input: {
    sessionId: string;
    filePath: string;
    description: string;
    targetSessionId: string;
    projectUuid?: string;
  }): Promise<void>;
}

export class TransportMessageFlow {
  public constructor(private readonly host: TransportMessageFlowHost) {}

  public async handleMessage(ctx: TelegramMenuContext): Promise<void> {
    const text = this.host.extractIncomingText(ctx.message);
    const attachments = this.host.collectIncomingAttachments(ctx.message);
    if (!text && attachments.length === 0) {
      return;
    }

    this.host.logger.info("Telegram message received", {
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
      ...(text ? { text: redactSecrets(text) } : {}),
      attachmentCount: attachments.length,
      activeWaiters: this.host.waiters.size,
    });

    const principal = this.host.getPrincipalFromContext(ctx);
    const authToken = text ? parseAdminAuthCommand(text) : null;
    if (this.host.isAdminAuthEnabled() && principal && authToken) {
      await this.handleAdminAuthCommand(ctx, principal, authToken);
      return;
    }

    if (this.host.isAdminBotProfile()) {
      const handled = await this.handleGatewayTopLevelMessage(ctx, text);
      if (handled) {
        return;
      }
    }

    if (text && (await this.host.handlePendingRename(ctx, text))) return;
    if (text && (await this.host.handlePendingBroadcast(ctx, text))) return;
    if (text && (await this.host.handlePendingPartnerNote(ctx, text))) return;
    if (text && (await this.host.handlePendingFileHandoff(ctx, text))) return;
    if (text && (await this.host.handlePendingProject(ctx, text))) return;

    if (text && isMenuEntryCommand(text)) {
      this.host.clearPendingInteractionsForContext(ctx);
      await this.host.showSessionsMenu(ctx);
      return;
    }

    if (text && isHelpCommand(text)) {
      this.host.clearPendingInteractionsForContext(ctx);
      await this.host.showHelp(ctx);
      return;
    }

    const pairingCode = text ? parsePairingCode(text) : null;
    if (pairingCode) {
      this.host.logger.debug("Telegram message identified as pairing command", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        messageId: ctx.message?.message_id,
      });
      await this.handlePairingCommand(ctx, pairingCode);
      return;
    }

    const replyMatched = text ? await this.handleReply(ctx) : false;
    if (replyMatched) {
      return;
    }

    if (attachments.length > 0) {
      await this.handleAttachmentUpload(ctx, attachments);
      return;
    }

    await this.handleInboxCapture(ctx);
  }

  public async handleGatewayTopLevelMessage(
    ctx: TelegramMenuContext,
    text: string | null,
  ): Promise<boolean> {
    const principal = this.host.getPrincipalFromContext(ctx);

    if (text && isGatewayLinkCommand(text)) {
      await this.host.showAdminClientsMenu(ctx);
      return true;
    }

    if (text && isGatewayAdminCommand(text)) {
      await this.host.showAdminMainMenu(ctx);
      return true;
    }

    if (text && isMenuEntryCommand(text)) {
      const isAdminAuthorized = await this.host.isPrincipalAdminAuthorized(principal);
      const activeSessionId = principal
        ? await this.host.bindingStore.getActiveSessionIdForPrincipal(principal)
        : null;
      const boundSessionIds = principal
        ? await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
        : [];
      const hasLinkedSessions = Boolean(activeSessionId) || boundSessionIds.length > 0;

      this.host.logger.info("Gateway /menu routing evaluated", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        isAdminAuthorized,
        activeSessionId,
        boundSessionCount: boundSessionIds.length,
        boundSessionIds,
      });

      if (hasLinkedSessions) {
        this.host.clearPendingInteractionsForContext(ctx);
        await this.host.showSessionsMenu(ctx);
      } else if (isAdminAuthorized) {
        await this.host.showAdminMainMenu(ctx);
      } else {
        this.host.clearPendingInteractionsForContext(ctx);
        await this.host.showSessionsMenu(ctx);
      }
      return true;
    }

    if (text && isHelpCommand(text)) {
      const isAdminAuthorized = await this.host.isPrincipalAdminAuthorized(principal);
      const activeSessionId = principal
        ? await this.host.bindingStore.getActiveSessionIdForPrincipal(principal)
        : null;
      const boundSessionIds = principal
        ? await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
        : [];
      const hasLinkedSessions = Boolean(activeSessionId) || boundSessionIds.length > 0;
      if (hasLinkedSessions) {
        this.host.clearPendingInteractionsForContext(ctx);
        await this.host.showHelp(ctx);
      } else if (isAdminAuthorized) {
        await this.host.showAdminMainMenu(
          ctx,
          await this.host.tForContext(ctx, "menu:admin.screen.help"),
        );
      } else {
        await this.host.showHelp(ctx);
      }
      return true;
    }

    return false;
  }

  public resolveGatewayTelegramSourceLabel(ctx: TelegramMenuContext): string {
    const firstName = ctx.from?.first_name?.trim();
    const lastName = ctx.from?.last_name?.trim();
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const username = ctx.from?.username?.trim();
    if (displayName) return displayName;
    if (username) return `@${username.replace(/^@/u, "")}`;
    return `Telegram user ${ctx.from?.id ?? "unknown"}`;
  }

  public inferGatewayInboxKind(text: string): PartnerNoteKind {
    return /\?\s*$/u.test(text.trim()) ? "question" : "request";
  }

  public buildGatewayInboxSummary(text: string): string {
    const summary =
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? "Telegram message";
    return summary.length > 140 ? `${summary.slice(0, 137).trimEnd()}...` : summary;
  }

  public async routeTelegramInboxToRelaySession(input: {
    ctx: TelegramMenuContext;
    principal: { telegramChatId: number; telegramUserId: number };
    relayTarget: { clientUuid: string; localSessionId: string; sourceClientUuid?: string };
    sourceSessionId: string;
    messageText: string;
    attachments: StoredAttachmentRecord[];
  }): Promise<void> {
    const sourceActorLabel = this.resolveGatewayTelegramSourceLabel(input.ctx);
    const output = await this.host.callGatewayJson<SendPartnerNoteOutput>("/relay/inbox", {
      client_uuid: "gateway-telegram",
      local_session_id: `telegram-user-${input.principal.telegramUserId}`,
      source_actor_label: sourceActorLabel,
      target_client_uuid: input.relayTarget.clientUuid,
      target_local_session_id: input.relayTarget.localSessionId,
      kind: this.inferGatewayInboxKind(input.messageText),
      summary: this.buildGatewayInboxSummary(input.messageText),
      message: input.messageText,
      requires_reply: false,
      artifact_refs: input.attachments.map((attachment) => ({
        file_path: attachment.filePath,
        ...(attachment.relativePath ? { relative_path: attachment.relativePath } : {}),
        original_name: path.basename(attachment.relativePath || attachment.filePath),
        ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
        ...(typeof attachment.sizeBytes === "number"
          ? { size_bytes: attachment.sizeBytes }
          : {}),
        ...(attachment.storageRef ? { storage_ref: attachment.storageRef } : {}),
      })),
    });

    this.host.logger.info("Telegram message routed to gateway relay session", {
      sessionId: input.sourceSessionId,
      targetClientUuid: input.relayTarget.clientUuid,
      targetLocalSessionId: input.relayTarget.localSessionId,
      shareId: output.share_id,
      deliveryStatus: output.delivery_status,
      chatId: input.principal.telegramChatId,
      userId: input.principal.telegramUserId,
    });
  }

  public async handlePairingCommand(
    ctx: TelegramMenuContext,
    code: string,
  ): Promise<void> {
    const pairCode = await this.host.bindingStore.consumePairCode(code);
    if (!pairCode) {
      this.host.logger.warn("Invalid or expired pairing code", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        code,
      });
      await this.host.replyText(ctx, "Pairing code is invalid or expired.", {
        kind: "pairing",
      });
      return;
    }

    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!fromUserId || !chatId) {
      await this.host.replyText(ctx, "Unable to determine Telegram user or chat.", {
        kind: "transport",
      });
      return;
    }

    if (pairCode.targetClientUuid && pairCode.targetLocalSessionId) {
      const principal = {
        telegramChatId: chatId,
        telegramUserId: fromUserId,
      };

      const session = await this.host.bindRelaySessionToPrincipal({
        principal,
        ctx,
        payload: {
          sessionId: pairCode.sessionId,
          targetSessionId: pairCode.targetLocalSessionId,
          targetSessionLabel:
            pairCode.sessionLabel ?? pairCode.targetLocalSessionId,
          targetClientUuid: pairCode.targetClientUuid,
          targetLocalSessionId: pairCode.targetLocalSessionId,
        },
      });

      this.host.logger.info("Gateway relay session linked via pairing code", {
        code,
        sessionId: session.sessionId,
        targetClientUuid: pairCode.targetClientUuid,
        targetLocalSessionId: pairCode.targetLocalSessionId,
        telegramChatId: chatId,
        telegramUserId: fromUserId,
      });

      await this.host.showSessionsMenu(
        ctx,
        "Pairing complete. Choose the active session from the menu.",
      );
      return;
    }

    await this.host.bindingStore.setBinding({
      sessionId: pairCode.sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
      ...(ctx.from?.username ? { telegramUsername: ctx.from.username } : {}),
      linkedAt: new Date().toISOString(),
    });
    await this.host.bindingStore.setActiveSessionIdForPrincipal(
      { telegramChatId: chatId, telegramUserId: fromUserId },
      pairCode.sessionId,
    );

    this.host.logger.info("Session linked to Telegram user", {
      sessionId: pairCode.sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
    });

    const existingSession = await this.host.sessionStore.getSession(pairCode.sessionId);
    await this.host.sessionStore.setSession({
      sessionId: pairCode.sessionId,
      ...(existingSession?.label || pairCode.sessionLabel
        ? { label: existingSession?.label ?? pairCode.sessionLabel }
        : {}),
      ...(existingSession?.cwd ? { cwd: existingSession.cwd } : {}),
      ...(existingSession?.linkedSessionId
        ? { linkedSessionId: existingSession.linkedSessionId }
        : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions ? { decisions: existingSession.decisions } : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      ...(existingSession?.tmuxSessionName
        ? { tmuxSessionName: existingSession.tmuxSessionName }
        : {}),
      ...(existingSession?.tmuxWindowName
        ? { tmuxWindowName: existingSession.tmuxWindowName }
        : {}),
      ...(typeof existingSession?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: existingSession.tmuxWindowIndex }
        : {}),
      ...(existingSession?.tmuxPaneId ? { tmuxPaneId: existingSession.tmuxPaneId } : {}),
      ...(typeof existingSession?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: existingSession.tmuxPaneIndex }
        : {}),
      ...(existingSession?.tmuxTarget ? { tmuxTarget: existingSession.tmuxTarget } : {}),
      ...(existingSession?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existingSession.lastTmuxNudgeAt }
        : {}),
      updatedAt: new Date().toISOString(),
    });

    await this.host.replyText(
      ctx,
      pairCode.sessionLabel
        ? `Session linked: ${pairCode.sessionLabel}`
        : `Session linked: ${pairCode.sessionId}`,
      { kind: "pairing", sessionId: pairCode.sessionId },
    );
    await this.host.showSessionsMenu(
      ctx,
      "Pairing complete. Choose the active session from the menu.",
    );
  }

  public async handleAdminAuthCommand(
    ctx: TelegramMenuContext,
    principal: { telegramChatId: number; telegramUserId: number },
    token: string,
  ): Promise<void> {
    const expected = this.host.config.telegram.adminToken?.trim();
    if (!expected) {
      await this.host.replyText(
        ctx,
        await this.host.tForContext(ctx, "menu:admin.auth.disabled"),
        { kind: "transport" },
      );
      return;
    }

    if (token !== expected) {
      this.host.logger.warn("Telegram admin auth rejected", {
        chatId: principal.telegramChatId,
        userId: principal.telegramUserId,
      });
      await this.host.replyText(
        ctx,
        await this.host.tForContext(ctx, "menu:admin.auth.invalid"),
        { kind: "transport" },
      );
      return;
    }

    await this.host.adminAuthStore.setAdminAuthorized(principal);
    this.host.logger.info("Telegram admin auth granted", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
    });
    await this.host.showAdminMainMenu(
      ctx,
      await this.host.tForContext(ctx, "menu:admin.auth.success"),
    );
  }

  public async handleReply(ctx: TelegramMenuContext): Promise<boolean> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!message?.text || !fromUserId || !chatId) {
      return false;
    }

    const waiters = Array.from(this.host.waiters.values());
    if (waiters.length === 0) {
      this.host.logger.debug(
        "Telegram message ignored because there are no active waiters",
        {
          chatId,
          userId: fromUserId,
          messageId: message.message_id,
          text: redactSecrets(message.text.trim()),
        },
      );
      return false;
    }

    const replyToMessageId = message.reply_to_message?.message_id;
    const messageTimestampMs = message.date * 1000;
    const matched =
      waiters.find(
        (waiter) =>
          waiter.telegramChatId === chatId &&
          waiter.telegramUserId === fromUserId &&
          replyToMessageId === waiter.telegramMessageId,
      ) ??
      (waiters.length === 1
        ? waiters.find(
            (waiter) =>
              waiter.telegramChatId === chatId &&
              waiter.telegramUserId === fromUserId &&
              messageTimestampMs >= waiter.sentAtMs,
          )
        : undefined);

    if (!matched) {
      this.host.logger.debug("Telegram message did not match any active waiter", {
        chatId,
        userId: fromUserId,
        messageId: message.message_id,
        replyToMessageId,
        activeWaiterIds: waiters.map((waiter) => waiter.requestId),
        text: redactSecrets(message.text.trim()),
      });
      return false;
    }

    this.host.logger.info("Telegram message matched active waiter", {
      requestId: matched.requestId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      replyToMessageId,
      text: redactSecrets(message.text.trim()),
    });

    const reply: HumanTransportReply = {
      requestId: matched.requestId,
      answer: message.text.trim(),
      receivedAt: new Date(message.date * 1000).toISOString(),
    };

    if (matched.sourceClientUuid && this.host.config.distributed.gatewayPublicUrl) {
      try {
        await this.host.callGatewayJson("/transport/reply", {
          client_uuid: matched.sourceClientUuid,
          request_id: matched.requestId,
          answer: reply.answer,
          received_at: reply.receivedAt,
        });
      } catch (error) {
        this.host.logger.error("Failed to forward gateway transport reply to client", {
          requestId: matched.requestId,
          sourceClientUuid: matched.sourceClientUuid,
          chatId,
          userId: fromUserId,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return false;
      }

      this.host.clearWaiter(matched.requestId);
      return true;
    }

    if (matched.resolve) {
      matched.resolve(reply);
      return true;
    }

    matched.reply = reply;
    return true;
  }

  public async handleInboxCapture(ctx: TelegramMenuContext): Promise<void> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = this.host.extractIncomingText(message);
    const attachmentDescriptors = this.host.collectIncomingAttachments(message);

    if (!message || (!text && attachmentDescriptors.length === 0) || !fromUserId || !chatId) {
      return;
    }

    const principal = { telegramChatId: chatId, telegramUserId: fromUserId };
    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      this.host.logger.debug(
        "Telegram message ignored because no active session is linked for principal",
        { chatId, userId: fromUserId, messageId: message.message_id },
      );
      await this.host.replyText(
        ctx,
        "No active session is linked yet. Use a pairing code first, then open the menu.",
        { kind: "transport" },
      );
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    const relayTarget = parseLiveRelaySessionId(sessionId);
    let attachments: StoredAttachmentRecord[] = [];
    try {
      attachments = await this.host.downloadIncomingAttachments(
        session,
        sessionId,
        message.message_id,
        attachmentDescriptors,
      );
    } catch (error) {
      this.host.logger.error("Telegram attachment upload failed", {
        sessionId,
        chatId,
        userId: fromUserId,
        messageId: message.message_id,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      await this.host.replyText(
        ctx,
        error instanceof Error
          ? `Could not save uploaded file: ${error.message}`
          : "Could not save uploaded file.",
        { kind: "transport", sessionId },
        {
          reply_markup:
            this.host.mainMenu as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
        },
      );
      return;
    }

    const normalizedText = this.host.buildInboxText(
      text,
      attachments.map((attachment) => attachment.filePath),
    );

    if (relayTarget) {
      try {
        await this.routeTelegramInboxToRelaySession({
          ctx,
          principal,
          relayTarget,
          sourceSessionId: sessionId,
          messageText: normalizedText,
          attachments,
        });
      } catch (error) {
        this.host.logger.error("Failed to route Telegram message to gateway relay session", {
          sessionId,
          targetClientUuid: relayTarget.clientUuid,
          targetLocalSessionId: relayTarget.localSessionId,
          chatId,
          userId: fromUserId,
          messageId: message.message_id,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        await this.host.replyText(
          ctx,
          await this.host.tForContext(ctx, "menu:system.gateway_relay_inbox_failed"),
          { kind: "transport", sessionId },
        );
        return;
      }

      await this.host.replyText(
        ctx,
        await this.host.tForContext(ctx, "menu:system.gateway_relay_inbox_sent", {
          sessionName: session?.label ?? relayTarget.localSessionId,
        }),
        { kind: "transport", sessionId },
      );
      return;
    }

    await this.host.storeTelegramUploadMetas({
      sessionId,
      sourceTelegramMessageId: message.message_id,
      uploadedAt: new Date(message.date * 1000).toISOString(),
      attachments,
      descriptors: attachmentDescriptors,
    });

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
      sourceTelegramMessageId: message.message_id,
      text: normalizedText,
      ...(attachments.length > 0
        ? { attachments: attachments.map((attachment) => attachment.filePath) }
        : {}),
      receivedAt: new Date(message.date * 1000).toISOString(),
    };

    await this.host.inboxStore.createInboxMessage(inboxMessage);
    this.host.logger.info("Telegram message stored in inbox", {
      sessionId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      inboxMessageId: inboxMessage.id,
      text: redactSecrets(inboxMessage.text),
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => attachment.filePath),
    });

    try {
      this.host.scheduleTmuxNudgeForInboxMessage(sessionId, session);
    } catch (error) {
      this.host.logger.error("tmux nudge failed after inbox capture", {
        sessionId,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }

    await this.host.replyText(
      ctx,
      session?.label
        ? attachments.length > 0
          ? `Saved to inbox for session: ${session.label}. Files downloaded: ${attachments.length}`
          : `Saved to inbox for session: ${session.label}`
        : attachments.length > 0
          ? `Saved to inbox for session: ${sessionId}. Files downloaded: ${attachments.length}`
          : `Saved to inbox for session: ${sessionId}`,
      { kind: "inbox", sessionId },
      {
        reply_markup:
          this.host.mainMenu as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
      },
    );
  }

  public async handleAttachmentUpload(
    ctx: TelegramMenuContext,
    attachmentDescriptors: TelegramAttachmentDescriptor[],
  ): Promise<void> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!message || !fromUserId || !chatId || attachmentDescriptors.length === 0) {
      return;
    }

    const principal = { telegramChatId: chatId, telegramUserId: fromUserId };
    const principalKey = buildPrincipalKey(principal);
    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await this.host.replyText(
        ctx,
        "No active session is linked yet. Use a pairing code first, then open the menu.",
        { kind: "transport" },
      );
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    const caption = this.host.extractIncomingText(message);
    const attachments = await this.host.downloadIncomingAttachments(
      session,
      sessionId,
      message.message_id,
      attachmentDescriptors,
    );

    const currentTarget = this.host.currentAttachmentTargets.get(principalKey);
    if (currentTarget && currentTarget.sessionId === sessionId) {
      await this.host.storeTelegramUploadMetas({
        sessionId,
        sourceTelegramMessageId: message.message_id,
        uploadedAt: new Date(message.date * 1000).toISOString(),
        attachments,
        descriptors: attachmentDescriptors,
        caption: caption || undefined,
      });

      for (const attachment of attachments) {
        await this.host.deliverAttachmentToPartner({
          sessionId,
          filePath: attachment.filePath,
          description: (caption || "").trim() || path.basename(attachment.filePath),
          targetSessionId: currentTarget.targetSessionId,
          ...(currentTarget.projectUuid
            ? { projectUuid: currentTarget.projectUuid }
            : {}),
        });
      }

      await this.host.replyText(
        ctx,
        currentTarget.projectUuid
          ? await this.host.tForContext(ctx, "menu:handoff.uploaded_to_session", {
              label: currentTarget.targetSessionLabel,
            })
          : await this.host.tForContext(ctx, "menu:handoff.uploaded_to_partner", {
              label: currentTarget.targetSessionLabel,
            }),
        { kind: "inbox", sessionId },
        {
          reply_markup:
            this.host.mainMenu as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
        },
      );
      return;
    }

    await this.host.storeTelegramUploadMetas({
      sessionId,
      sourceTelegramMessageId: message.message_id,
      uploadedAt: new Date(message.date * 1000).toISOString(),
      attachments,
      descriptors: attachmentDescriptors,
      caption: caption || undefined,
    });

    this.host.logger.info("Telegram files uploaded for session", {
      sessionId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => attachment.filePath),
    });

    await this.host.replyText(
      ctx,
      session?.label
        ? attachments.length === 1
          ? await this.host.tForContext(ctx, "menu:handoff.delivered_one", {
              label: session.label,
            })
          : await this.host.tForContext(ctx, "menu:handoff.delivered_many", {
              label: session.label,
              count: attachments.length,
            })
        : attachments.length === 1
          ? await this.host.tForContext(ctx, "menu:handoff.delivered_one", {
              label: sessionId,
            })
          : await this.host.tForContext(ctx, "menu:handoff.delivered_many", {
              label: sessionId,
              count: attachments.length,
            }),
      { kind: "inbox", sessionId },
      {
        reply_markup:
          this.host.mainMenu as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
      },
    );
  }
}
