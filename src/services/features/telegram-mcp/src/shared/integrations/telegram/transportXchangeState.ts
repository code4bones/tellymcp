import type { AppConfig } from "../../../app/config/env";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type {
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../../api/storage/contract";
import { listXchangeFiles } from "../terminal/client";

export interface TransportXchangeStateHost {
  config: AppConfig;
  sessionStore: SessionStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
  callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
}

export class TransportXchangeState {
  public constructor(private readonly host: TransportXchangeStateHost) {}

  private async resolveSessionStorageAccess(sessionId: string): Promise<{
    sessionId: string;
    mode: "filesystem" | "meta" | "relay";
  }> {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return { sessionId: trimmed, mode: "meta" };
    }

    const relay = parseLiveRelaySessionId(trimmed);
    if (relay?.localSessionId) {
      const localSession = await this.host.sessionStore.getSession(
        relay.localSessionId,
      );
      if (localSession?.cwd?.trim()) {
        return { sessionId: relay.localSessionId, mode: "filesystem" };
      }

      return { sessionId: trimmed, mode: "relay" };
    }

    const direct = await this.host.sessionStore.getSession(trimmed);
    if (direct?.cwd?.trim()) {
      return { sessionId: trimmed, mode: "filesystem" };
    }

    return { sessionId: trimmed, mode: "meta" };
  }

  public async listActiveSessionFiles(sessionId: string): Promise<string[]> {
    const access = await this.resolveSessionStorageAccess(sessionId);
    const metas =
      access.mode === "filesystem"
        ? await this.listReconciledSessionXchangeMetas(
            access.sessionId,
            await this.listSessionFilesystemXchangeFiles(access.sessionId),
          )
        : access.mode === "relay"
          ? await this.listRelaySessionXchangeFileMetas(
              access.sessionId,
              "telegram-upload",
            )
        : await this.host.xchangeFileMetaStore.listXchangeFileMetas(
            access.sessionId,
          );
    const uploadFiles = metas
      .filter((meta) => meta.source === "telegram-upload")
      .map((meta) => meta.filePath);

    return uploadFiles.sort((left, right) => right.localeCompare(left));
  }

  public async listActiveSessionStorageEntries(sessionId: string): Promise<
    Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  > {
    const access = await this.resolveSessionStorageAccess(sessionId);
    if (access.mode === "relay") {
      const metas = await this.listRelaySessionXchangeFileMetas(access.sessionId);
      return metas.map((meta) => ({
        filePath: meta.filePath,
        meta,
      }));
    }

    if (access.mode === "meta") {
      const metas = await this.host.xchangeFileMetaStore.listXchangeFileMetas(
        access.sessionId,
      );
      return metas.map((meta) => ({
        filePath: meta.filePath,
        meta,
      }));
    }

    const filePaths = await this.listSessionFilesystemXchangeFiles(access.sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(
      access.sessionId,
      filePaths,
    );
    const metaByPath = new Map(metas.map((meta) => [meta.filePath, meta] as const));
    return filePaths.map((filePath) => ({
      filePath,
      meta: metaByPath.get(filePath) ?? null,
    }));
  }

  public async listActiveSessionScreenshots(sessionId: string): Promise<string[]> {
    const access = await this.resolveSessionStorageAccess(sessionId);
    const metas =
      access.mode === "filesystem"
        ? await this.listReconciledSessionXchangeMetas(
            access.sessionId,
            await this.listSessionFilesystemXchangeFiles(access.sessionId),
          )
        : access.mode === "relay"
          ? await this.listRelaySessionXchangeFileMetas(
              access.sessionId,
              "browser-screenshot",
            )
        : await this.host.xchangeFileMetaStore.listXchangeFileMetas(
            access.sessionId,
          );
    const screenshots = metas
      .filter((meta) => meta.source === "browser-screenshot")
      .map((meta) => meta.filePath);

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
      this.host.config.terminal,
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

  private async listRelaySessionXchangeFileMetas(
    sessionId: string,
    source?: TelegramXchangeFileMeta["source"],
  ): Promise<TelegramXchangeFileMeta[]> {
    const output = await this.host.callGatewayJson<{
      session_id: string;
      metas?: TelegramXchangeFileMeta[];
    }>("/storage/list", {
      session_id: sessionId,
      ...(source ? { source } : {}),
    });

    return Array.isArray(output.metas) ? output.metas : [];
  }
}
