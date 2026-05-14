import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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

type VfsNodeExistsResult = {
  error?: boolean;
  message?: string;
};

type MinioCompleteUploadResponse = {
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
type MinioRequestUploadResponse = {
  uploadId: string;
  method: "PUT";
  bucketName: string;
  objectName: string;
  storageRef: string;
  uploadUrl: string;
  expiresIn: number;
  headers?: Record<string, string> | undefined;
  contentType: string;
  createdAt: string;
};
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
    private readonly distributedMode: "client" | "gateway" | "both" = "client",
    private readonly gatewayPublicUrl?: string,
    private readonly gatewayAuthToken?: string,
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
    if (this.shouldUseGatewayStorage()) {
      return this.storeFileThroughGateway(params);
    }

    const relativePath = normalizeRelativePath(params.relativePath);

    const targetDir = await this.ensureVfsDirectory(
      params.session,
      params.sessionId,
      params.source,
      relativePath,
    );
    const inferredMimeType =
      params.mimeType || inferMimeType(path.basename(relativePath));
    const targetFileName = await this.ensureUniqueFileName(
      targetDir.node_id,
      path.basename(relativePath),
    );
    const response = await this.uploadFileThroughManagedFlow(
      targetDir.node_id,
      targetFileName,
      inferredMimeType,
      params.content,
      this.createUploadOwnerSub(),
    );
    if (!response.node?.node_id || !response.upload?.storageRef) {
      throw new Error("Managed upload completed without VFS node metadata.");
    }

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

    const content = this.shouldUseGatewayStorage()
      ? Buffer.from(
          (
            await this.callGateway<{
              contentBase64: string;
            }>("/xchange/read", {
              storageRef: params.storageRef,
              relativePath,
            })
          ).contentBase64,
          "base64",
        )
      : await this.readStoredContent({
          relativePath,
          storageRef: params.storageRef,
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
    if (this.shouldUseGatewayStorage()) {
      const result = await this.callGateway<{
        contentBase64: string;
      }>("/xchange/read", {
        storageRef: params.storageRef,
        relativePath: params.relativePath,
      });
      return Buffer.from(result.contentBase64, "base64");
    }

    const relativePath = normalizeRelativePath(params.relativePath);
    const resolved = await this.callInternalBroker<{
      bucketName: string;
      objectName: string;
    } | unknown>("minio.resolveFileRef", {
      ref: params.storageRef,
      name: path.basename(relativePath),
    });
    if (
      !resolved ||
      typeof resolved !== "object" ||
      typeof (resolved as { bucketName?: unknown }).bucketName !== "string" ||
      typeof (resolved as { objectName?: unknown }).objectName !== "string"
    ) {
      throw new Error(
        this.extractActionErrorMessage(
          resolved,
          "Failed to resolve stored file reference.",
        ),
      );
    }
    const content = await this.callInternalBroker<MinioGetObjectResponse>(
      "minio.getObject",
      {
        bucketName: (resolved as { bucketName: string }).bucketName,
        objectName: (resolved as { objectName: string }).objectName,
      },
    );
    if (Buffer.isBuffer(content)) {
      return content;
    }
    if (content instanceof Uint8Array) {
      return Buffer.from(content);
    }
    throw new Error(
      this.extractActionErrorMessage(content, "Failed to read stored file content."),
    );
  }

  public async deleteStoredFile(params?: {
    storageRef?: string | undefined;
    vfsNodeId?: number | undefined;
  }): Promise<void> {
    if (!params?.storageRef && !params?.vfsNodeId) {
      return;
    }

    if (this.shouldUseGatewayStorage()) {
      await this.callGateway("/xchange/delete", {
        ...(params.storageRef ? { storageRef: params.storageRef } : {}),
        ...(typeof params.vfsNodeId === "number"
          ? { vfsNodeId: params.vfsNodeId }
          : {}),
      });
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
    extraMeta?: Record<string, unknown>,
  ): Promise<T> {
    return this.callBroker<T>(actionName, params, {
      meta: {
        ...this.internalCallMeta,
        ...(extraMeta || {}),
      },
    });
  }

  private async uploadFileThroughManagedFlow(
    parentNodeId: number,
    fileName: string,
    mimeType: string,
    content: Uint8Array,
    ownerSub: string,
  ): Promise<MinioCompleteUploadResponse> {
    const request = await this.callInternalBroker<MinioRequestUploadResponse>(
      "minio.requestUpload",
      {
        name: fileName,
        contentType: mimeType,
        parent_id: parentNodeId,
        size: content.byteLength,
      },
      { user: { sub: ownerSub } },
    );

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const uploadHeaders = new Headers();
    Object.entries(request.headers || {}).forEach(([key, value]) => {
      if (value != null && value !== "") {
        uploadHeaders.set(key, value);
      }
    });

    const uploadResponse = await fetch(request.uploadUrl, {
      method: request.method || "PUT",
      headers: uploadHeaders,
      body: buffer,
    });

    if (!uploadResponse.ok) {
      const message = await uploadResponse.text().catch(() => "");
      throw new Error(
        `Managed upload PUT failed with status ${uploadResponse.status}: ${message || uploadResponse.statusText}`,
      );
    }

    return this.callInternalBroker<MinioCompleteUploadResponse>(
      "minio.completeUpload",
      {
        uploadId: request.uploadId,
        storageRef: request.storageRef,
        name: fileName,
        parent_id: parentNodeId,
      },
      { user: { sub: ownerSub } },
    );
  }

  private async ensureUniqueFileName(
    parentNodeId: number,
    requestedFileName: string,
  ): Promise<string> {
    const ext = path.extname(requestedFileName);
    const baseName = path.basename(requestedFileName, ext) || "file";
    let candidate = requestedFileName;
    let index = 1;

    while (await this.vfsFileExists(parentNodeId, candidate)) {
      candidate = `${baseName}--${index}${ext}`;
      index += 1;
    }

    return candidate;
  }

  private async vfsFileExists(
    parentNodeId: number,
    fileName: string,
  ): Promise<boolean> {
    const result = await this.callInternalBroker<VfsNodeExistsResult>(
      "vfs.vfsNodeExists",
      {
        node: {
          parent_id: parentNodeId,
          name: fileName,
          type: "FILE",
          scope: this.vfsScope,
        },
        throw: false,
      },
    );
    return Boolean(result?.error);
  }

  private shouldUseGatewayStorage(): boolean {
    return this.distributedMode === "client" && Boolean(this.gatewayPublicUrl);
  }

  private async callGateway<T>(
    endpointPath: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    if (!this.gatewayPublicUrl) {
      throw new Error("Gateway storage relay requires GATEWAY_PUBLIC_URL.");
    }

    const url = new URL(this.gatewayPublicUrl);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    if (!url.pathname.endsWith("/gateway")) {
      url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
    }
    url.pathname = `${url.pathname}${endpointPath}`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.gatewayAuthToken
          ? { authorization: `Bearer ${this.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Gateway xchange request failed with status ${response.status}: ${message || response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  private async storeFileThroughGateway(params: {
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
    const binding = await this.bindingStore.getBinding(params.sessionId);
    const ownerSegment = this.buildOwnerSegment(binding, params.sessionId);
    const sessionSegment = this.buildSessionSegment(params.session, params.sessionId);
    const inferredMimeType =
      params.mimeType || inferMimeType(path.basename(relativePath));

    const response = await this.callGateway<{
      filePath: string;
      relativePath: string;
      storageRef: string;
      bucketName: string;
      objectName: string;
      vfsNodeId: number;
      vfsPublicUrl: string;
      vfsParentId: number;
      sizeBytes: number;
    }>("/xchange/store", {
      ownerSegment,
      sessionSegment,
      source: params.source,
      relativePath,
      mimeType: inferredMimeType,
      contentBase64: Buffer.from(params.content).toString("base64"),
      vfsScope: this.vfsScope,
    });

    this.logger.info("Exchange file stored via gateway VFS + MinIO relay", {
      sessionId: params.sessionId,
      source: params.source,
      relativePath,
      vfsScope: this.vfsScope,
      vfsNodeId: response.vfsNodeId,
      vfsPublicUrl: response.vfsPublicUrl,
      storageRef: response.storageRef,
    });

    return response;
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

  private createUploadOwnerSub(): string {
    return randomUUID();
  }

  private extractActionErrorMessage(value: unknown, fallback: string): string {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
      const extensions = record.extensions;
      if (extensions && typeof extensions === "object") {
        const extRecord = extensions as Record<string, unknown>;
        if (typeof extRecord.message === "string" && extRecord.message.trim()) {
          return extRecord.message;
        }
      }
    }
    return fallback;
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
