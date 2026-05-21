import type { AppConfig } from "../../../app/config/env";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
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

  public async listActiveSessionFiles(sessionId: string): Promise<string[]> {
    const files = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, files);
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
    const filePaths = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, filePaths);
    const metaByPath = new Map(metas.map((meta) => [meta.filePath, meta] as const));
    return filePaths.map((filePath) => ({
      filePath,
      meta: metaByPath.get(filePath) ?? null,
    }));
  }

  public async listActiveSessionScreenshots(sessionId: string): Promise<string[]> {
    const files = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, files);
    const screenshots = metas
      .filter((meta) => meta.source === "browser-screenshot")
      .map((meta) => meta.filePath)
      .filter((filePath) => files.includes(filePath));

    return screenshots.sort((left, right) => right.localeCompare(left));
  }

  public async listSessionFilesystemXchangeFiles(sessionId: string): Promise<string[]> {
    const session = await this.host.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim() || "";
    const resolvedWorkspaceDir = workspaceDir || process.cwd();
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
