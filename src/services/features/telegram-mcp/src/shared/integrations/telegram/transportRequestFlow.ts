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
  WaiterRecord,
} from "./transportTypes";
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
  sendTextChunks(
    chatId: number,
    body: string,
    meta: {
      sessionId: string;
      requestId?: string;
      kind: "request" | "notification" | "transport";
    },
  ): Promise<SentChunk[]>;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportRequestFlow {
  public constructor(private readonly host: TransportRequestFlowHost) {}

  public async sendAdminGatewayRegistrationNotifications(input: {
    clientUuid: string;
    nodeId?: string;
    packageVersion?: string;
    totalSessions: number;
    isNewClient: boolean;
    newSessions: AdminGatewayRegistrationSessionRecord[];
  }): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      return;
    }

    if (!this.host.isAdminAuthEnabled()) {
      return;
    }

    const principals = await this.host.adminAuthStore.listAdminAuthorizedPrincipals();
    if (principals.length === 0) {
      this.host.logger.debug(
        "Skipping gateway registration admin notifications because no admins are authorized",
        {
          clientUuid: input.clientUuid,
        },
      );
      return;
    }

    const notifiedChats = new Set<string>();
    for (const principal of principals) {
      const dedupeKey = `${principal.telegramChatId}:${principal.telegramUserId}`;
      if (notifiedChats.has(dedupeKey)) {
        continue;
      }

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
          sessionId: `gateway-admin:${input.clientUuid}`,
          sessionLabel: "Gateway Admin",
          recipient: principal,
          message: lines.join("\n"),
        });
        notifiedChats.add(dedupeKey);
      } catch (error) {
        this.host.logger.warn("Failed to deliver gateway registration admin notification", {
          telegramChatId: principal.telegramChatId,
          telegramUserId: principal.telegramUserId,
          clientUuid: input.clientUuid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
    const sentChunks = await this.host.sendTextChunks(
      input.recipient.telegramChatId,
      text,
      {
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: "request",
      },
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
    });

    return { externalMessageId: response.messageId };
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
