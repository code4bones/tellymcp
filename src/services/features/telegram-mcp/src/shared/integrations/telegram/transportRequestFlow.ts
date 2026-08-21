import {
  formatTelegramMessage,
  formatTelegramNotification,
} from "./messageFormat";
import type {
  HumanTransportNotification,
  HumanTransportReply,
  HumanTransportRequest,
} from "../../api/transport/contract";
import type {
  AdminGatewayRegistrationSessionRecord,
  SentChunk,
  TelegramMenuContext,
  TelegramSendMessageOptions,
  WaiterRecord,
} from "./transportTypes";
import { InlineKeyboard } from "grammy";
import type { AppConfig } from "../../../app/config/env";
import type { MaintenanceStore, TelegramAdminAuthStore } from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";

export interface TransportRequestFlowHost {
  logger: Logger;
  config: AppConfig;
  adminAuthStore: TelegramAdminAuthStore;
  maintenanceStore: MaintenanceStore;
  waiters: Map<string, WaiterRecord>;
  isTelegramEnabled(): boolean;
  isAdminAuthEnabled(): boolean;
  resolveLocaleForTelegramUserId(
    telegramUserId: number,
    telegramLanguageCode?: string | null,
  ): Promise<SupportedLocale>;
  t(locale: SupportedLocale, key: string, options?: Record<string, unknown>): string;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  sendTextChunks(
    chatId: number,
    body: string,
    meta: {
      sessionId: string;
      requestId?: string;
      kind: "request" | "notification" | "transport";
    },
    finalChunkOptions?: TelegramSendMessageOptions,
  ): Promise<SentChunk[]>;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportRequestFlow {
  public constructor(private readonly host: TransportRequestFlowHost) {}

  public async sendAdminGatewayRegistrationNotifications(input: {
    clientUuid: string;
    gatewayUserUuid?: string;
    nodeId?: string;
    packageVersion?: string;
    totalSessions: number;
    isNewClient: boolean;
    newSessions: AdminGatewayRegistrationSessionRecord[];
  }): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      return;
    }

    const ownerRoute = await this.host.callGatewayJson<{
      gateway_user_uuid?: string;
      telegram_user_id?: number;
      telegram_chat_id?: number | null;
      telegram_username?: string;
      telegram_display_name?: string;
    }>("/user/route", {
      client_uuid: input.clientUuid,
      ...(input.gatewayUserUuid ? { gateway_user_uuid: input.gatewayUserUuid } : {}),
    });

    if (
      typeof ownerRoute.telegram_user_id !== "number" ||
      typeof ownerRoute.telegram_chat_id !== "number"
    ) {
      this.host.logger.debug(
        "Skipping gateway registration notification because owner Telegram route is unavailable",
        {
          clientUuid: input.clientUuid,
          gatewayUserUuid: input.gatewayUserUuid ?? null,
        },
      );
      return;
    }

    const principal = {
      telegramChatId: ownerRoute.telegram_chat_id,
      telegramUserId: ownerRoute.telegram_user_id,
    };
    const locale = await this.host.resolveLocaleForTelegramUserId(
      principal.telegramUserId,
    );
    const lines = [
      this.host.t(
        locale,
        input.isNewClient
          ? "menu:notices.admin.gateway_client_registered_title"
          : "menu:notices.admin.gateway_session_registered_title",
      ),
      this.host.t(locale, "menu:notices.admin.gateway_client_uuid", {
        value: input.clientUuid,
      }),
      ...(input.nodeId
        ? [
            this.host.t(locale, "menu:notices.admin.gateway_node_id", {
              value: input.nodeId,
            }),
          ]
        : []),
      ...(input.packageVersion
        ? [
            this.host.t(locale, "menu:notices.admin.gateway_package_version", {
              value: input.packageVersion,
            }),
          ]
        : []),
      this.host.t(locale, "menu:notices.admin.gateway_session_count", {
        count: input.totalSessions,
      }),
      ...(input.newSessions.length > 0
        ? [
            "",
            this.host.t(locale, "menu:notices.admin.gateway_new_sessions"),
            ...input.newSessions.map((session) =>
              this.host.t(locale, "menu:notices.admin.gateway_session_item", {
                label: session.session_label?.trim() || session.local_session_id,
                localSessionId: session.local_session_id,
              }),
            ),
          ]
        : []),
    ];

    try {
      await this.sendNotification({
        sessionId: `gateway-owner:${input.clientUuid}`,
        sessionLabel: "Gateway",
        recipient: principal,
        message: lines.join("\n"),
      });
    } catch (error) {
      this.host.logger.warn("Failed to deliver gateway registration owner notification", {
        telegramChatId: principal.telegramChatId,
        telegramUserId: principal.telegramUserId,
        clientUuid: input.clientUuid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async sendRequest(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.host.isTelegramEnabled()) {
      return this.sendRequestViaGateway(input);
    }

    const text = formatTelegramMessage(input, {
      maxQuestionChars: this.host.config.telegram.maxQuestionChars,
      maxContextChars: this.host.config.telegram.maxContextChars,
      maxMessageChars: this.host.config.telegram.maxMessageChars,
    });
    const optionKeyboard =
      input.options &&
      input.options.length > 0 &&
      input.options.length <= 5 &&
      Buffer.byteLength(
        `request-option:${input.options.length - 1}:${input.requestId}`,
        "utf8",
      ) <= 64
        ? new InlineKeyboard()
        : null;
    input.options?.forEach((option, index) => {
      if (!optionKeyboard) return;
      optionKeyboard.text(
        option.slice(0, 40),
        `request-option:${index}:${input.requestId}`,
      );
      if (index < (input.options?.length ?? 0) - 1) optionKeyboard.row();
    });
    const sentChunks = await this.host.sendTextChunks(
      input.recipient.telegramChatId,
      text,
      {
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: "request",
      },
      optionKeyboard ? { reply_markup: optionKeyboard } : {},
    );
    const response = sentChunks.at(-1);
    if (!response) {
      throw new Error("Telegram request send produced no message chunks");
    }

    this.host.waiters.set(input.requestId, {
      requestId: input.requestId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      telegramMessageId: response.messageId,
      sentAtMs: Date.now(),
      ...(input.options ? { options: [...input.options] } : {}),
    });

    return { externalMessageId: response.messageId };
  }

  public async handleRequestOptionCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^request-option:(\d+):(.+)$/u);
    const optionIndex = match?.[1] ? Number.parseInt(match[1], 10) : -1;
    const requestId = match?.[2]?.trim() ?? "";
    const waiter = requestId ? this.host.waiters.get(requestId) : undefined;
    const answer = waiter?.options?.[optionIndex];

    if (!waiter || !answer) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:request.stale"),
        show_alert: true,
      });
      return;
    }
    if (
      ctx.chat?.id !== waiter.telegramChatId ||
      ctx.from?.id !== waiter.telegramUserId
    ) {
      await ctx.answerCallbackQuery({
        text: await this.host.tForContext(ctx, "common:request.not_allowed"),
        show_alert: true,
      });
      return;
    }

    const reply: HumanTransportReply = {
      requestId,
      answer,
      receivedAt: new Date().toISOString(),
    };

    if (waiter.sourceClientUuid && this.host.config.distributed.gatewayPublicUrl) {
      try {
        await this.host.callGatewayJson("/transport/reply", {
          client_uuid: waiter.sourceClientUuid,
          request_id: requestId,
          answer,
          received_at: reply.receivedAt,
        });
      } catch (error) {
        this.host.logger.error("Failed to forward Telegram option reply to client", {
          requestId,
          sourceClientUuid: waiter.sourceClientUuid,
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.answerCallbackQuery({
          text: await this.host.tForContext(ctx, "common:menu.gateway_unavailable"),
          show_alert: true,
        });
        return;
      }
      this.clearWaiter(requestId);
    } else if (waiter.resolve) {
      waiter.resolve(reply);
    } else {
      waiter.reply = reply;
    }

    await ctx.answerCallbackQuery({
      text: await this.host.tForContext(ctx, "common:request.answer_recorded"),
    });
    await ctx
      .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
      .catch(() => undefined);
  }

  public async sendRequestForGatewayBoundSession(
    input: HumanTransportRequest & { sourceClientUuid: string },
  ): Promise<{ externalMessageId?: string | number }> {
    const result = await this.sendRequest(input);
    const waiter = this.host.waiters.get(input.requestId);
    if (waiter) {
      waiter.sourceClientUuid = input.sourceClientUuid;
    }
    return result;
  }

  public async sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.host.isTelegramEnabled()) {
      return this.sendNotificationViaGateway(input);
    }

    const text = formatTelegramNotification(input, {
      maxQuestionChars: this.host.config.telegram.maxQuestionChars,
      maxContextChars: this.host.config.telegram.maxContextChars,
      maxMessageChars: this.host.config.telegram.maxMessageChars,
    });
    const sentChunks = await this.host.sendTextChunks(
      input.recipient.telegramChatId,
      text,
      {
        sessionId: input.sessionId,
        kind: "notification",
      },
    );
    const response = sentChunks.at(-1);
    if (!response) {
      throw new Error("Telegram notification send produced no message chunks");
    }

    this.host.logger.info("Telegram notification delivered", {
      sessionId: input.sessionId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      messageId: response.messageId,
      chunks: sentChunks.length,
    });

    return { externalMessageId: response.messageId };
  }

  public async waitForReply(
    requestId: string,
    timeoutSeconds: number,
  ): Promise<HumanTransportReply | null> {
    const waiter = this.host.waiters.get(requestId);
    if (!waiter) {
      throw new Error(`Transport waiter not found for request ${requestId}`);
    }

    if (waiter.reply) {
      this.clearWaiter(requestId);
      return waiter.reply;
    }

    return new Promise<HumanTransportReply | null>((resolve) => {
      waiter.resolve = (reply) => {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        this.clearWaiter(requestId);
        resolve(reply);
      };
      waiter.timeout = setTimeout(() => {
        waiter.resolve?.(null);
      }, timeoutSeconds * 1000);
    });
  }

  public async handleGatewayTransportReplyEvent(input: {
    request_id: string;
    answer: string;
    received_at: string;
  }): Promise<void> {
    const waiter = this.host.waiters.get(input.request_id);
    if (!waiter) {
      this.host.logger.debug("Gateway transport reply ignored because waiter was not found", {
        requestId: input.request_id,
      });
      return;
    }

    const reply: HumanTransportReply = {
      requestId: input.request_id,
      answer: input.answer,
      receivedAt: input.received_at,
    };

    this.host.logger.info("Gateway transport reply received", {
      requestId: input.request_id,
      telegramChatId: waiter.telegramChatId,
      telegramUserId: waiter.telegramUserId,
    });

    if (waiter.resolve) {
      waiter.resolve(reply);
      return;
    }

    waiter.reply = reply;
  }

  public clearWaiter(requestId: string): void {
    const waiter = this.host.waiters.get(requestId);
    if (waiter?.timeout) {
      clearTimeout(waiter.timeout);
    }
    this.host.waiters.delete(requestId);
  }

  private async sendRequestViaGateway(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.host.config.distributed.gatewayPublicUrl) {
      throw new Error("Gateway is not configured for Telegram request proxying.");
    }

    const clientUuid = await this.host.maintenanceStore.getGatewayClientUuid();
    if (!clientUuid) {
      throw new Error("Gateway client UUID is unavailable for Telegram request proxying.");
    }

    this.host.waiters.set(input.requestId, {
      requestId: input.requestId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      telegramMessageId: 0,
      sentAtMs: Date.now(),
    });

    try {
      const response = await this.host.callGatewayJson<{
        message_id?: number | string;
      }>("/transport/request", {
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        request_id: input.requestId,
        ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
        telegram_chat_id: input.recipient.telegramChatId,
        telegram_user_id: input.recipient.telegramUserId,
        question: input.question,
        ...(input.task ? { task: input.task } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.affectedFiles ? { affected_files: input.affectedFiles } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.recommendedOption
          ? { recommended_option: input.recommendedOption }
          : {}),
        ...(input.riskLevel ? { risk_level: input.riskLevel } : {}),
        ...(input.fallbackIfTimeout
          ? { fallback_if_timeout: input.fallbackIfTimeout }
          : {}),
      });

      const waiter = this.host.waiters.get(input.requestId);
      if (waiter && typeof response.message_id === "number") {
        waiter.telegramMessageId = response.message_id;
      }

      return typeof response.message_id === "undefined"
        ? {}
        : { externalMessageId: response.message_id };
    } catch (error) {
      this.clearWaiter(input.requestId);
      throw error;
    }
  }

  private async sendNotificationViaGateway(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.host.config.distributed.gatewayPublicUrl) {
      throw new Error("Gateway is not configured for Telegram notification proxying.");
    }

    const clientUuid = await this.host.maintenanceStore.getGatewayClientUuid();
    if (!clientUuid) {
      throw new Error("Gateway client UUID is unavailable for Telegram notification proxying.");
    }

    const response = await this.host.callGatewayJson<{
      message_id?: number | string;
    }>("/transport/notify", {
      client_uuid: clientUuid,
      local_session_id: input.sessionId,
      ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
      telegram_chat_id: input.recipient.telegramChatId,
      telegram_user_id: input.recipient.telegramUserId,
      message: input.message,
      ...(input.task ? { task: input.task } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.riskLevel ? { risk_level: input.riskLevel } : {}),
    });

    this.host.logger.info("Gateway transport notification delivered", {
      sessionId: input.sessionId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      ...(typeof response.message_id !== "undefined"
        ? { messageId: response.message_id }
        : {}),
    });

    return typeof response.message_id === "undefined"
      ? {}
      : { externalMessageId: response.message_id };
  }
}
