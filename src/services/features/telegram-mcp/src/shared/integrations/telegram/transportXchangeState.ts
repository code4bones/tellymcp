import type { AppConfig } from "../../../app/config/env";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type {
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../../api/storage/contract";
import { listXchangeFiles } from "../tmux/client";

export interface TransportXchangeStateHost {
  config: AppConfig;
  sessionStore: SessionStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
}

export class TransportXchangeState {
  public constructor(private readonly host: TransportXchangeStateHost) {}

  private async normalizeSessionIdForFilesystem(sessionId: string): Promise<string> {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return trimmed;
    }

    const direct = await this.host.sessionStore.getSession(trimmed);
    if (direct?.cwd?.trim()) {
      return trimmed;
    }

    const relay = parseLiveRelaySessionId(trimmed);
    if (!relay?.localSessionId) {
      return trimmed;
    }

    const localSession = await this.host.sessionStore.getSession(relay.localSessionId);
    return localSession?.cwd?.trim() ? relay.localSessionId : trimmed;
  }

  public async listActiveSessionFiles(sessionId: string): Promise<string[]> {
    const storageSessionId = await this.normalizeSessionIdForFilesystem(sessionId);
    const files = await this.listSessionFilesystemXchangeFiles(storageSessionId);
    const metas = await this.listReconciledSessionXchangeMetas(storageSessionId, files);
    const uploadFiles = metas
      .filter((meta) => meta.source === "telegram-upload")
      .map((meta) => meta.filePath)
      .filter((filePath) => files.includes(filePath));

    return uploadFiles.sort((left, right) => right.localeCompare(left));
  }

  public async listActiveSessionStorageEntries(sessionId: string): Promise<
    Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  > {
    const storageSessionId = await this.normalizeSessionIdForFilesystem(sessionId);
    const filePaths = await this.listSessionFilesystemXchangeFiles(storageSessionId);
    const metas = await this.listReconciledSessionXchangeMetas(storageSessionId, filePaths);
    const metaByPath = new Map(metas.map((meta) => [meta.filePath, meta] as const));
    return filePaths.map((filePath) => ({
      filePath,
      meta: metaByPath.get(filePath) ?? null,
    }));
  }

  public async listActiveSessionScreenshots(sessionId: string): Promise<string[]> {
    const storageSessionId = await this.normalizeSessionIdForFilesystem(sessionId);
    const files = await this.listSessionFilesystemXchangeFiles(storageSessionId);
    const metas = await this.listReconciledSessionXchangeMetas(storageSessionId, files);
    const screenshots = metas
      .filter((meta) => meta.source === "browser-screenshot")
      .map((meta) => meta.filePath)
      .filter((filePath) => files.includes(filePath));

    return screenshots.sort((left, right) => right.localeCompare(left));
  }

  public async listSessionFilesystemXchangeFiles(sessionId: string): Promise<string[]> {
    const session = await this.host.sessionStore.getSession(sessionId);
    const resolvedWorkspaceDir = session?.cwd?.trim() || "";
    if (!resolvedWorkspaceDir) {
      throw new Error(
        `Workspace cwd is not registered for console '${sessionId}'.`,
      );
    }
    const files = await listXchangeFiles(
      this.host.config.tmux,
      resolvedWorkspaceDir,
      this.host.config.exchange.dir,
    );
    return files.sort((left, right) => right.localeCompare(left));
  }

  public async listReconciledSessionXchangeMetas(
    sessionId: string,
    existingFiles: string[],
  ): Promise<TelegramXchangeFileMeta[]> {
    const metas =
      await this.host.xchangeFileMetaStore.listXchangeFileMetas(sessionId);
    if (metas.length === 0) {
      return [];
    }

    const existingSet = new Set(existingFiles);
    const staleMetas = metas.filter((meta) => !existingSet.has(meta.filePath));

    for (const meta of staleMetas) {
      await this.host.xchangeFileMetaStore.deleteXchangeFileMeta(
        sessionId,
        meta.filePath,
      );
    }

    return metas.filter((meta) => existingSet.has(meta.filePath));
  }
}
