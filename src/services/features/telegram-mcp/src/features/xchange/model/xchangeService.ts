import type { AppConfig } from "../../../app/config/env";
import type {
  GetXchangeRecordInput,
  GetXchangeRecordOutput,
  ListXchangeRecordsInput,
  ListXchangeRecordsOutput,
  MarkXchangeRecordReadInput,
  MarkXchangeRecordReadOutput,
} from "../../../entities/xchange/model/types";
import type {
  MaintenanceStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
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
    private readonly maintenanceStore: MaintenanceStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async listRecords(
    input: ListXchangeRecordsInput,
  ): Promise<ListXchangeRecordsOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForAccess(resolved.sessionId);
    const remote =
      this.config.distributed.mode !== "client"
        ? await this.remoteConsoleInvoker?.invokeForRelaySession<ListXchangeRecordsOutput>(
            sessionId,
            "telegramMcp.xchange.listRecordsRemote",
            {
              ...input,
              session_id: sessionId,
            } as Record<string, unknown>,
          )
        : null;
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(sessionId);
    const records = await listXchangeRecords(
      this.config.terminal,
      workspaceDir,
      this.config.exchange.dir,
      sessionId,
      {
        ...(input.status ? { status: input.status } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      },
    );

    this.logger.info("Xchange records listed", {
      sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      total: records.length,
      status: input.status,
      category: input.category,
      direction: input.direction,
      limit: input.limit,
    });

    return {
      session_id: sessionId,
      total: records.length,
      records,
    };
  }

  public async getRecord(
    input: GetXchangeRecordInput,
  ): Promise<GetXchangeRecordOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForAccess(resolved.sessionId);
    const remote =
      this.config.distributed.mode !== "client"
        ? await this.remoteConsoleInvoker?.invokeForRelaySession<GetXchangeRecordOutput>(
            sessionId,
            "telegramMcp.xchange.getRecordRemote",
            {
              ...input,
              session_id: sessionId,
            } as Record<string, unknown>,
          )
        : null;
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(sessionId);
    const record = await getXchangeRecord(
      this.config.terminal,
      workspaceDir,
      this.config.exchange.dir,
      sessionId,
      input.record_id,
    );

    this.logger.info("Xchange record fetched", {
      sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      recordId: input.record_id,
      exists: Boolean(record),
    });

    return {
      session_id: sessionId,
      record,
    };
  }

  public async markRead(
    input: MarkXchangeRecordReadInput,
  ): Promise<MarkXchangeRecordReadOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForAccess(resolved.sessionId);
    const remote =
      this.config.distributed.mode !== "client"
        ? await this.remoteConsoleInvoker?.invokeForRelaySession<MarkXchangeRecordReadOutput>(
            sessionId,
            "telegramMcp.xchange.markReadRemote",
            {
              ...input,
              session_id: sessionId,
            } as Record<string, unknown>,
          )
        : null;
    if (remote) {
      return remote;
    }
    const workspaceDir = await this.resolveWorkspaceDir(sessionId);
    const updated = await markXchangeRecordRead(
      this.config.terminal,
      workspaceDir,
      this.config.exchange.dir,
      sessionId,
      input.record_id,
    );

    this.logger.info("Xchange record marked as read", {
      sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      recordId: input.record_id,
      updated,
    });

    return {
      session_id: sessionId,
      record_id: input.record_id,
      updated,
    };
  }

  private async normalizeSessionIdForAccess(sessionId: string): Promise<string> {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return trimmed;
    }

    const direct = await this.sessionStore.getSession(trimmed);
    if (direct) {
      return trimmed;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      return trimmed;
    }

    const localClientUuid = await this.maintenanceStore.getGatewayClientUuid();
    const clientUuid = trimmed.slice(0, separatorIndex).trim();
    const localSessionId = trimmed.slice(separatorIndex + 1).trim();
    if (!localClientUuid || clientUuid !== localClientUuid || !localSessionId) {
      return trimmed;
    }

    const localSession = await this.sessionStore.getSession(localSessionId);
    return localSession ? localSessionId : trimmed;
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
