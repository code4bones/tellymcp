import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, access } from "node:fs/promises";

import type { SessionBinding } from "../../../entities/auth/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { SessionBindingStore } from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import { ensureXchangeDir, writeXchangeRelativeFile } from "../tmux/client";
import type { TmuxRuntimeConfig } from "../tmux/client";

export type ExchangeFileSource =
  | "telegram-upload"
  | "browser-screenshot"
  | "partner-artifact";

type BrokerCallOptions = {
  meta?: Record<string, unknown>;
};

type BrokerCaller = <T>(
  actionName: string,
  params?: unknown,
  options?: BrokerCallOptions,
) => Promise<T>;

type VfsNode = {
  node_id: number;
  parent_id?: number | null;
  public_url?: string | undefined;
  name?: string | undefined;
  scope?: string | undefined;
};

type MinioIngestResponse = {
  node: {
    node_id: number;
    parent_id: number;
    public_url: string;
    name: string;
    hash: string;
  };
  upload: {
    bucketName: string;
    objectName: string;
    storageRef: string;
  };
  tileInfo?: unknown;
};

type MinioGetObjectResponse = Uint8Array | Buffer;
const TEMP_XCHANGE_ROOT = path.join(tmpdir(), "telegram-mcp-xchange");

function sanitizePathSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[\/\\]+/gu, "-")
    .replace(/[\x00-\x1f]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/[^-\w.]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function sanitizeVfsPathSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[\/\\]+/gu, "-")
    .replace(/[\x00-\x1f]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/[^-\p{L}\p{N}._@]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath
    .split(/[\/\\]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  if (!normalized) {
    throw new Error("Relative exchange path is required.");
  }

  return normalized;
}

function inferMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

function resolveWorkspaceDir(
  session: SessionContext | null,
  tmuxConfig: TmuxRuntimeConfig,
): string {
  const workspaceDir = session?.cwd?.trim() || "";
  if (tmuxConfig.proxyUrl && !workspaceDir) {
    throw new Error(
      `Session ${session?.sessionId || "unknown"} has no cwd configured for host bridge file exchange.`,
    );
  }

  return workspaceDir || process.cwd();
}

function buildVirtualFilePath(publicUrl: string): string {
  return `vfs://${publicUrl}`;
}

function getXchangeKind(source: ExchangeFileSource): string {
  if (source === "browser-screenshot") {
    return "screenshots";
  }
  if (source === "partner-artifact") {
    return "shares";
  }
  return "files";
}

export class MinioExchangeStore {
  private readonly internalCallMeta = { internal_call: true } as const;

  public constructor(
    private readonly callBroker: BrokerCaller,
    private readonly bindingStore: SessionBindingStore,
    private readonly tmuxConfig: TmuxRuntimeConfig,
    private readonly exchangeDirName: string,
    private readonly vfsScope: string,
    private readonly logger: Logger,
  ) {}

  public resolveWorkspaceDir(session: SessionContext | null): string {
    return resolveWorkspaceDir(session, this.tmuxConfig);
  }

  public getTempSessionDir(sessionId: string): string {
    return path.join(
      TEMP_XCHANGE_ROOT,
      sanitizePathSegment(sessionId) || "session",
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
    storageRef: string;
    bucketName: string;
    objectName: string;
    vfsNodeId: number;
    vfsPublicUrl: string;
    vfsParentId: number;
    sizeBytes: number;
  }> {
    const relativePath = normalizeRelativePath(params.relativePath);

    const targetDir = await this.ensureVfsDirectory(
      params.session,
      params.sessionId,
      params.source,
      relativePath,
    );
    const inferredMimeType =
      params.mimeType || inferMimeType(path.basename(relativePath));
    const response = await this.callInternalBroker<MinioIngestResponse>(
      "minio.ingest",
      {
        files: [
          {
            fieldname: "file",
            originalname: path.basename(relativePath),
            encoding: "7bit",
            mimetype: inferredMimeType,
            size: params.content.byteLength,
            buffer: Buffer.from(params.content),
          },
        ],
        fields: {
          parent_id: String(targetDir.node_id),
          name: path.basename(relativePath),
        },
      },
    );

    this.logger.info("Exchange file stored via VFS + MinIO", {
      sessionId: params.sessionId,
      source: params.source,
      relativePath,
      vfsScope: this.vfsScope,
      vfsParentId: targetDir.node_id,
      vfsNodeId: response.node.node_id,
      vfsPublicUrl: response.node.public_url,
      storageRef: response.upload.storageRef,
    });

    return {
      filePath: buildVirtualFilePath(response.node.public_url),
      relativePath,
      storageRef: response.upload.storageRef,
      bucketName: response.upload.bucketName,
      objectName: response.upload.objectName,
      vfsNodeId: response.node.node_id,
      vfsPublicUrl: response.node.public_url,
      vfsParentId: response.node.parent_id,
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
    if (!params.storageRef) {
      return params.filePath;
    }

    const relativePath = params.relativePath
      ? normalizeRelativePath(params.relativePath)
      : path.basename(params.filePath);

    const resolvedFilePath =
      params.source === "partner-artifact"
        ? path.resolve(
            this.resolveWorkspaceDir(params.session),
            this.exchangeDirName,
            relativePath,
          )
        : path.resolve(this.getTempSessionDir(params.sessionId), relativePath);

    try {
      await access(resolvedFilePath);
      return resolvedFilePath;
    } catch {
      // continue and rehydrate from MinIO
    }

    const resolved = await this.callInternalBroker<{
      bucketName: string;
      objectName: string;
    }>("minio.resolveFileRef", {
      ref: params.storageRef,
      name: path.basename(relativePath),
    });
    const content = await this.callInternalBroker<MinioGetObjectResponse>("minio.getObject", {
      bucketName: resolved.bucketName,
      objectName: resolved.objectName,
    });

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    let materializedPath: string;
    if (params.source === "partner-artifact") {
      const workspaceDir = this.resolveWorkspaceDir(params.session);
      await ensureXchangeDir(this.tmuxConfig, workspaceDir, this.exchangeDirName);
      materializedPath = await writeXchangeRelativeFile(
        this.tmuxConfig,
        workspaceDir,
        this.exchangeDirName,
        relativePath,
        buffer,
      );
    } else {
      const tempDir = this.getTempSessionDir(params.sessionId);
      materializedPath = path.resolve(tempDir, relativePath);
      await mkdir(path.dirname(materializedPath), { recursive: true });
      await writeFile(materializedPath, buffer);
    }

    this.logger.info("Exchange file rehydrated from MinIO", {
      sessionId: params.sessionId,
      filePath: materializedPath,
      relativePath,
      source: params.source,
    });

    return materializedPath;
  }

  public async readStoredContent(params: {
    relativePath: string;
    storageRef: string;
  }): Promise<Uint8Array> {
    const relativePath = normalizeRelativePath(params.relativePath);
    const resolved = await this.callInternalBroker<{
      bucketName: string;
      objectName: string;
    }>("minio.resolveFileRef", {
      ref: params.storageRef,
      name: path.basename(relativePath),
    });
    const content = await this.callInternalBroker<MinioGetObjectResponse>(
      "minio.getObject",
      {
        bucketName: resolved.bucketName,
        objectName: resolved.objectName,
      },
    );

    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  }

  public async deleteStoredFile(params?: {
    storageRef?: string | undefined;
    vfsNodeId?: number | undefined;
  }): Promise<void> {
    if (!params?.storageRef && !params?.vfsNodeId) {
      return;
    }

    if (typeof params?.vfsNodeId === "number" && params.vfsNodeId > 0) {
      try {
        await this.callInternalBroker("vfs.vfsDeleteNode", {
          node_id: [params.vfsNodeId],
        });
        return;
      } catch (error) {
        this.logger.warn("VFS node deletion failed, falling back to direct object deletion", {
          vfsNodeId: params.vfsNodeId,
          storageRef: params.storageRef,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (params?.storageRef) {
      await this.callInternalBroker("minio.deleteByRef", {
        ref: params.storageRef,
      });
    }
  }

  private async callInternalBroker<T>(
    actionName: string,
    params?: unknown,
  ): Promise<T> {
    return this.callBroker<T>(actionName, params, {
      meta: this.internalCallMeta,
    });
  }

  private async ensureVfsDirectory(
    session: SessionContext | null,
    sessionId: string,
    source: ExchangeFileSource,
    relativePath: string,
  ): Promise<VfsNode> {
    const binding = await this.bindingStore.getBinding(sessionId);
    const ownerSegment = this.buildOwnerSegment(binding, sessionId);
    const sessionSegment = this.buildSessionSegment(session, sessionId);
    const kindSegment = getXchangeKind(source);
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const relativeDir = path.posix.dirname(normalizedRelativePath);
    const targetDirPath =
      source === "partner-artifact"
        ? relativeDir === "." ? kindSegment : relativeDir
        : relativeDir === "." ? kindSegment : `${kindSegment}/${relativeDir}`;

    return this.callInternalBroker<VfsNode>("vfs.vfsCreateDir", {
      scope: this.vfsScope,
      node: {
        name: `xchange/${ownerSegment}/${sessionSegment}/${targetDirPath}`,
      },
    });
  }

  private buildOwnerSegment(
    binding: SessionBinding | null,
    sessionId: string,
  ): string {
    const username = binding?.telegramUsername?.trim();
    if (username) {
      return sanitizeVfsPathSegment(username) || `session-${sanitizePathSegment(sessionId)}`;
    }

    if (binding?.telegramChatId) {
      return sanitizeVfsPathSegment(String(binding.telegramChatId));
    }

    return `session-${sanitizePathSegment(sessionId) || "unknown"}`;
  }

  private buildSessionSegment(
    session: SessionContext | null,
    sessionId: string,
  ): string {
    const label = session?.label?.trim();
    if (label) {
      return sanitizeVfsPathSegment(label) || "session";
    }

    return sanitizeVfsPathSegment(sessionId) || "session";
  }
}
