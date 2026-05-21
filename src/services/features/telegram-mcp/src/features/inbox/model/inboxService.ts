import type {
  DeleteTelegramInboxMessageInput,
  DeleteTelegramInboxMessageOutput,
  GetTelegramInboxCountInput,
  GetTelegramInboxCountOutput,
  GetTelegramInboxInput,
  GetTelegramInboxOutput,
} from "../../../entities/inbox/model/types";
import type { AppConfig } from "../../../app/config/env";
import type {
  SessionStore,
  TelegramInboxStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T | null>;
};

export class InboxService {
  public constructor(
    private readonly config: AppConfig,
    private readonly inboxStore: TelegramInboxStore,
    private readonly _sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async getInboxCount(
    input: GetTelegramInboxCountInput,
  ): Promise<GetTelegramInboxCountOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<GetTelegramInboxCountOutput>(
      resolved.sessionId,
      "telegramMcp.inbox.getInboxCountRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const total = await this.inboxStore.countInboxMessages(resolved.sessionId);

    this.logger.info("Telegram inbox count fetched", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      total,
    });

    return {
      session_id: resolved.sessionId,
      total,
    };
  }

  public async getInbox(
    input: GetTelegramInboxInput,
  ): Promise<GetTelegramInboxOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<GetTelegramInboxOutput>(
      resolved.sessionId,
      "telegramMcp.inbox.getInboxRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const limit = this.config.telegram.inboxBatchSize;
    const messages = await this.inboxStore.listInboxMessages(
      resolved.sessionId,
      limit,
    );
    const total = await this.inboxStore.countInboxMessages(resolved.sessionId);

    this.logger.info("Telegram inbox fetched", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      limit,
      returned: messages.length,
      total,
    });

    return {
      session_id: resolved.sessionId,
      total,
      has_more: total > messages.length,
      messages: messages.map((message) => ({
        message_id: message.id,
        source: "telegram",
        message_kind:
          message.sourceTelegramMessageId > 0 ? "human" : "system",
        telegram_chat_id: message.telegramChatId,
        telegram_user_id: message.telegramUserId,
        telegram_message_id: message.sourceTelegramMessageId,
        text: message.text,
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
        received_at: message.receivedAt,
      })),
    };
  }

  public async deleteInboxMessage(
    input: DeleteTelegramInboxMessageInput,
  ): Promise<DeleteTelegramInboxMessageOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<DeleteTelegramInboxMessageOutput>(
      resolved.sessionId,
      "telegramMcp.inbox.deleteInboxMessageRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const deleted = await this.inboxStore.deleteInboxMessage(
      resolved.sessionId,
      input.message_id,
    );

    this.logger.info("Telegram inbox message deleted", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      messageId: input.message_id,
      deleted,
    });

    return {
      deleted,
      session_id: resolved.sessionId,
      message_id: input.message_id,
    };
  }
}
