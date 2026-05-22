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
import {
  listXchangeRecords,
  markXchangeRecordRead,
} from "../../../shared/integrations/xchange/sqliteRecordStore";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
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
    const total = await this.countTelegramMessageRecords(resolved.sessionId);

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
    const workspaceDir = await this.resolveWorkspaceDir(resolved.sessionId);
    const records = await listXchangeRecords(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      resolved.sessionId,
      {
        status: "new",
        category: "telegram_message",
        direction: "incoming",
        limit,
      },
    );
    const total = await this.countTelegramMessageRecords(resolved.sessionId);

    this.logger.info("Telegram inbox fetched", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      limit,
      returned: records.length,
      total,
    });

    return {
      session_id: resolved.sessionId,
      total,
      has_more: total > records.length,
      messages: records.map((record) => ({
        message_id: record.record_id,
        source: "telegram",
        message_kind: "human",
        telegram_chat_id: 0,
        telegram_user_id: 0,
        telegram_message_id: 0,
        text: record.body_text,
        ...(record.attachments?.length
          ? {
              attachments: record.attachments.map(
                (attachment) => attachment.file_path,
              ),
            }
          : {}),
        received_at: record.created_at,
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
    const workspaceDir = await this.resolveWorkspaceDir(resolved.sessionId);
    const deleted = await markXchangeRecordRead(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
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

  private async countTelegramMessageRecords(sessionId: string): Promise<number> {
    const workspaceDir = await this.resolveWorkspaceDir(sessionId);
    const records = await listXchangeRecords(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      sessionId,
      {
        status: "new",
        category: "telegram_message",
        direction: "incoming",
      },
    );
    return records.length;
  }

  private async resolveWorkspaceDir(sessionId: string): Promise<string> {
    const getSession = (this._sessionStore as { getSession?: (sessionId: string) => Promise<{ cwd?: string } | null> }).getSession;
    if (!getSession) {
      throw new Error("Session store does not expose getSession; cannot resolve console workspace.");
    }
    const session = await getSession(sessionId);
    const workspaceDir = session?.cwd?.trim();
    if (!workspaceDir) {
      throw new Error(
        `Workspace cwd is not registered for console '${sessionId}'.`,
      );
    }
    return workspaceDir;
  }
}
