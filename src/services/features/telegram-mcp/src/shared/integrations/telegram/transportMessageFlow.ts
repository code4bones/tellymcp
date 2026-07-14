import path from "node:path";

import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import type { AppConfig } from "../../../app/config/env";
import { writeTelegramMessageXchangeRecord } from "../../lib/telegramXchangeRecords";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../api/storage/contract";
import type { HumanTransportReply } from "../../api/transport/contract";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import {
  buildPrincipalKey,
  isHelpCommand,
  isMenuEntryCommand,
  parseAdminAuthCommand,
} from "./transportUtils";
import type {
  StoredAttachmentRecord,
  TelegramAttachmentDescriptor,
  TelegramMenuContext,
  TelegramSendMessageOptions,
  WaiterRecord,
  SendMessageMeta,
} from "./transportTypes";

export interface TransportMessageFlowHost {
  logger: Logger;
  config: AppConfig;
  bindingStore: SessionBindingStore;
  sessionStore: SessionStore;
  isAdminAuthEnabled(): boolean;
  isPrincipalAdminAuthorized(
    principal: { telegramChatId: number; telegramUserId: number } | null,
  ): Promise<boolean>;
  setPrincipalAdminAuthorized(principal: {
    telegramChatId: number;
    telegramUserId: number;
  }): Promise<void>;
  ensureGatewayUserForPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
  }): Promise<{ gateway_user_uuid: string }>;
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
  isAdminBotProfile(): boolean;
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
  ensureGatewayScopeConsolesBound(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
  }): Promise<{ sessionIds: string[]; activeSessionId: string | null }>;
  getMainMenu(): unknown;
  clearWaiter(requestId: string): void;
  callGatewayJson<T>(path: string, payload?: unknown): Promise<T>;
  scheduleTerminalNudgeForInboxMessage(
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
    const authToken = text ? parseAdminAuthCommand(text) : null;
    if (authToken !== null) {
      if (!this.host.isAdminAuthEnabled()) {
        await this.host.replyText(
          ctx,
          await this.host.tForContext(ctx, "menu:admin.auth.disabled"),
          { sessionId: "gateway-auth", kind: "transport" },
        );
        return true;
      }

      if (authToken !== this.host.config.distributed.gatewayScopeToken) {
        await this.host.replyText(
          ctx,
          await this.host.tForContext(ctx, "menu:admin.auth.invalid"),
          { sessionId: "gateway-auth", kind: "transport" },
        );
        return true;
      }

      if (!principal) {
        return true;
      }

      const user = await this.host.ensureGatewayUserForPrincipal({
        principal,
        ctx,
      });
      await this.host.setPrincipalAdminAuthorized(principal);
      await this.host.replyText(
        ctx,
        [
          await this.host.tForContext(ctx, "menu:admin.auth.success"),
          "",
          `<code>GATEWAY_USER_UUID=${user.gateway_user_uuid}</code>`,
          "Set this in your agent .env.",
        ].join("\n"),
        { sessionId: "gateway-auth", kind: "transport" },
        { parse_mode: "HTML" },
      );
      return true;
    }

    if (
      this.host.isAdminAuthEnabled() &&
      !(await this.host.isPrincipalAdminAuthorized(principal))
    ) {
      await this.host.replyText(
        ctx,
        await this.host.tForContext(ctx, "menu:admin.auth.prompt"),
        { sessionId: "gateway-auth", kind: "transport" },
      );
      return true;
    }

    if (text && isMenuEntryCommand(text)) {
      if (principal) {
        await this.host.ensureGatewayScopeConsolesBound({ principal, ctx });
      }
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
        activeSessionId,
        boundSessionCount: boundSessionIds.length,
        boundSessionIds,
      });

      void hasLinkedSessions;
      this.host.clearPendingInteractionsForContext(ctx);
      await this.host.showSessionsMenu(ctx);
      return true;
    }

    if (text && isHelpCommand(text)) {
      const principal = this.host.getPrincipalFromContext(ctx);
      if (principal) {
        await this.host.ensureGatewayScopeConsolesBound({ principal, ctx });
      }
      this.host.clearPendingInteractionsForContext(ctx);
      await this.host.showHelp(ctx);
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

  public async routeTelegramInboxToRelaySession(input: {
    ctx: TelegramMenuContext;
    principal: { telegramChatId: number; telegramUserId: number };
    relayTarget: { clientUuid: string; localSessionId: string; sourceClientUuid?: string };
    sourceSessionId: string;
    messageText: string;
    attachments: StoredAttachmentRecord[];
  }): Promise<void> {
    const sourceActorLabel = this.resolveGatewayTelegramSourceLabel(input.ctx);
    const output = await this.host.callGatewayJson<{
      ok: true;
      session_id: string;
      submitted_text: string;
    }>("/relay/console-message", {
      source_actor_label: sourceActorLabel,
      target_client_uuid: input.relayTarget.clientUuid,
      target_local_session_id: input.relayTarget.localSessionId,
      message: input.messageText,
      ...(input.attachments.length > 0
        ? {
            attachments: input.attachments.map((attachment) => attachment.filePath),
          }
        : {}),
    });

    this.host.logger.info("Telegram message routed to gateway relay session", {
      sessionId: input.sourceSessionId,
      targetClientUuid: input.relayTarget.clientUuid,
      targetLocalSessionId: input.relayTarget.localSessionId,
      submittedTextLength: output.submitted_text.length,
      chatId: input.principal.telegramChatId,
      userId: input.principal.telegramUserId,
    });
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
        "No active console selected yet. Open /menu and choose a console first.",
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
            this.host.getMainMenu() as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
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

    const recordId = await writeTelegramMessageXchangeRecord({
      config: this.host.config,
      session,
      sessionId,
      text: normalizedText,
      createdAt: new Date(message.date * 1000).toISOString(),
      attachments: attachments.map((attachment) => ({
        file_path: attachment.filePath,
      })),
      tags: [
        "telegram",
        "human",
        ...(attachments.length > 0 ? ["attachments"] : []),
      ],
    });
    this.host.logger.info("Telegram message stored in xchange", {
      sessionId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      recordId,
      text: redactSecrets(normalizedText),
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => attachment.filePath),
    });

    try {
      this.host.scheduleTerminalNudgeForInboxMessage(sessionId, session);
    } catch (error) {
      this.host.logger.error("terminal nudge failed after xchange capture", {
        sessionId,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }

    await this.host.replyText(
      ctx,
      session?.label
        ? attachments.length > 0
          ? `Saved to xchange for session: ${session.label}. Files downloaded: ${attachments.length}`
          : `Saved to xchange for session: ${session.label}`
        : attachments.length > 0
          ? `Saved to xchange for session: ${sessionId}. Files downloaded: ${attachments.length}`
          : `Saved to xchange for session: ${sessionId}`,
      { kind: "transport", sessionId },
      {
        reply_markup:
          this.host.getMainMenu() as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
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
        "No active console selected yet. Open /menu and choose a console first.",
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
            this.host.getMainMenu() as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
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
          this.host.getMainMenu() as NonNullable<TelegramSendMessageOptions["reply_markup"]>,
      },
    );
  }
}
