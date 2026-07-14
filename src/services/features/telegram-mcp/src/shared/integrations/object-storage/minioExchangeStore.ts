import path from "node:path";
import { access } from "node:fs/promises";

import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../lib/logger/logger";
import { writeXchangeRelativeFile } from "../terminal/client";
import type { TerminalRuntimeConfig } from "../terminal/client";

export type ExchangeFileSource =
  | "telegram-upload"
  | "browser-screenshot"
  | "partner-artifact";

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath
    .split(/[/\\]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  if (!normalized) {
    throw new Error("Relative exchange path is required.");
  }

  return normalized;
}

function resolveWorkspaceDir(
  session: SessionContext | null,
  _terminalConfig: TerminalRuntimeConfig,
): string {
  const workspaceDir = session?.cwd?.trim() || "";
  if (!workspaceDir) {
    throw new Error("Workspace cwd is not registered for this console.");
  }
  return workspaceDir;
}

export class MinioExchangeStore {
  public constructor(
    private readonly terminalConfig: TerminalRuntimeConfig,
    private readonly exchangeDirName: string,
    private readonly logger: Logger,
  ) {}

  public resolveWorkspaceDir(session: SessionContext | null): string {
    return resolveWorkspaceDir(session, this.terminalConfig);
  }

  public getTempSessionDir(sessionId: string): string {
    return path.resolve(
      process.cwd(),
      this.exchangeDirName,
      "__legacy__",
      sessionId,
    );
  }

  public async storeFile(params: {
    session: SessionContext | null;
    sessionId: string;
    source: ExchangeFileSource;
    relativePath: string;
    content: Uint8Array;
    mimeType?: string | undefined;
  }): Promise<{
    filePath: string;
    relativePath: string;
    storageRef?: string | undefined;
    bucketName?: string | undefined;
    objectName?: string | undefined;
    vfsNodeId?: number | undefined;
    vfsPublicUrl?: string | undefined;
    vfsParentId?: number | undefined;
    sizeBytes: number;
  }> {
    const relativePath = normalizeRelativePath(params.relativePath);
    const workspaceDir = this.resolveWorkspaceDir(params.session);
    const filePath = await writeXchangeRelativeFile(
      this.terminalConfig,
      workspaceDir,
      this.exchangeDirName,
      relativePath,
      Buffer.from(params.content),
    );

    this.logger.info("Exchange file stored locally", {
      sessionId: params.sessionId,
      source: params.source,
      relativePath,
      filePath,
    });

    return {
      filePath,
      relativePath,
      sizeBytes: params.content.byteLength,
    };
  }

  public async ensureLocalFile(params: {
    sessionId: string;
    session: SessionContext | null;
    filePath: string;
    relativePath?: string | undefined;
    storageRef?: string | undefined;
    source: ExchangeFileSource;
  }): Promise<string> {
    const candidates = new Set<string>();
    if (params.filePath?.trim()) {
      candidates.add(
        path.isAbsolute(params.filePath)
          ? path.resolve(params.filePath)
          : path.resolve(this.resolveWorkspaceDir(params.session), params.filePath),
      );
    }

    if (params.relativePath?.trim()) {
      candidates.add(
        path.resolve(
          this.resolveWorkspaceDir(params.session),
          this.exchangeDirName,
          normalizeRelativePath(params.relativePath),
        ),
      );
    }

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }

    throw new Error(
      params.storageRef
        ? "Exchange file is not available locally. VFS/S3 relay has been removed."
        : "Exchange file is not available locally.",
    );
  }

  public async readStoredContent(_params: {
    relativePath: string;
    storageRef: string;
  }): Promise<Uint8Array> {
    throw new Error("Direct VFS/S3 artifact reads are no longer supported.");
  }

  public async deleteStoredFile(_params?: {
    storageRef?: string | undefined;
    vfsNodeId?: number | undefined;
  }): Promise<void> {
    // Local exchange files are deleted directly by their workspace path.
  }
}
