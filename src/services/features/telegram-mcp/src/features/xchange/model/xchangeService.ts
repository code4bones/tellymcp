import type { AppConfig } from "../../../app/config/env";
import type {
  GetXchangeRecordInput,
  GetXchangeRecordOutput,
  ListXchangeRecordsInput,
  ListXchangeRecordsOutput,
  MarkXchangeRecordReadInput,
  MarkXchangeRecordReadOutput,
} from "../../../entities/xchange/model/types";
import type { SessionStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import {
  getXchangeRecord,
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

export class XchangeService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async listRecords(
    input: ListXchangeRecordsInput,
  ): Promise<ListXchangeRecordsOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<ListXchangeRecordsOutput>(
      resolved.sessionId,
      "telegramMcp.xchange.listRecordsRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(resolved.sessionId);
    const records = await listXchangeRecords(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      resolved.sessionId,
      {
        ...(input.status ? { status: input.status } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      },
    );

    this.logger.info("Xchange records listed", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      total: records.length,
      status: input.status,
      category: input.category,
      direction: input.direction,
      limit: input.limit,
    });

    return {
      session_id: resolved.sessionId,
      total: records.length,
      records,
    };
  }

  public async getRecord(
    input: GetXchangeRecordInput,
  ): Promise<GetXchangeRecordOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<GetXchangeRecordOutput>(
      resolved.sessionId,
      "telegramMcp.xchange.getRecordRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(resolved.sessionId);
    const record = await getXchangeRecord(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      resolved.sessionId,
      input.record_id,
    );

    this.logger.info("Xchange record fetched", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      recordId: input.record_id,
      exists: Boolean(record),
    });

    return {
      session_id: resolved.sessionId,
      record,
    };
  }

  public async markRead(
    input: MarkXchangeRecordReadInput,
  ): Promise<MarkXchangeRecordReadOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<MarkXchangeRecordReadOutput>(
      resolved.sessionId,
      "telegramMcp.xchange.markReadRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(resolved.sessionId);
    const updated = await markXchangeRecordRead(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      resolved.sessionId,
      input.record_id,
    );

    this.logger.info("Xchange record marked as read", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      recordId: input.record_id,
      updated,
    });

    return {
      session_id: resolved.sessionId,
      record_id: input.record_id,
      updated,
    };
  }

  private async resolveWorkspaceDir(sessionId: string): Promise<string> {
    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim();
    if (!workspaceDir) {
      throw new Error(
        `Workspace cwd is not registered for console '${sessionId}'.`,
      );
    }
    return workspaceDir;
  }
}
