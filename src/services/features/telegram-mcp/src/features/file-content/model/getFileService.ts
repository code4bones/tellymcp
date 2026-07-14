import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { AppConfig } from "../../../app/config/env";
import type {
  GetFileInput,
  GetFileListInput,
  GetFileListOutput,
  GetFileOutput,
} from "../../../entities/request/model/types";
import type {
  MaintenanceStore,
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../../../shared/api/storage/contract";
import { resolveWorkspaceFileForRead } from "../../../shared/integrations/terminal/client";
import {
  assertSerializedBodySize,
  MAX_BASE64_SOURCE_SIZE_BYTES,
} from "../../../shared/lib/bodyLimits";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import {
  TEMPORARY_FILE_LINK_MAX_BYTES,
  TemporaryFileLinkStore,
  resolvePublicFilesBaseUrl,
} from "./temporaryFileLinkStore";
import {
  assertWorkspaceFilePathAllowed,
  decodeWorkspaceTextContent,
  resolveWorkspaceFileMimeType,
} from "./workspaceFilePolicy";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

export type GetFileResult = GetFileOutput & {
  native_image_data?: string | undefined;
};

const MAX_NATIVE_IMAGE_SOURCE_SIZE_BYTES = 11 * 1024 * 1024;
const MAX_TEXT_SOURCE_SIZE_BYTES = 7 * 1024 * 1024;

function normalizeWorkspaceRelativePath(
  workspaceDir: string,
  filePath: string,
): string {
  const trimmed = filePath.trim();
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedFilePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedWorkspaceDir, trimmed);
  const relative = path.relative(resolvedWorkspaceDir, resolvedFilePath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("File path is outside the workspace directory.");
  }

  return relative.split(path.sep).join("/");
}

export class GetFileService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
    private readonly temporaryFileLinkStore?: TemporaryFileLinkStore | null,
  ) {}

  public async get(input: GetFileInput): Promise<GetFileResult> {
    if (input.file_path?.trim()) {
      assertWorkspaceFilePathAllowed(input.file_path.trim());
    }
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForWorkspace(
      resolved.sessionId,
    );
    const responseType = input.type ?? "url";
    const cacheKey = this.createCacheKey(sessionId, input);

    if (this.config.distributed.mode !== "client") {
      if (responseType === "url" || responseType === "image") {
        if (!this.temporaryFileLinkStore) {
          throw new Error(
            "URL file delivery requires gateway mode with GATEWAY_PUBLIC_URL.",
          );
        }
        const ticket = this.temporaryFileLinkStore.createTicket(cacheKey);
        try {
          if (!this.remoteConsoleInvoker) {
            throw new Error("Gateway remote console routing is unavailable.");
          }
          await this.remoteConsoleInvoker.invokeForRelaySession(
            sessionId,
            "telegramMcp.fileContent.uploadFileRemote",
            {
              ...input,
              type: "url",
              session_id: sessionId,
              upload_url: ticket.upload_url,
            } as Record<string, unknown>,
          );
          const link = this.temporaryFileLinkStore.getReadyLink(
            ticket.download_token,
          );
          const output: GetFileOutput = {
            type: "url",
            data: link.url,
            filename: link.filename,
            mimetype: link.mimetype,
            size_bytes: link.size_bytes,
            expires_at: link.expires_at,
          };
          if (responseType === "image") {
            if (!link.mimetype.toLowerCase().startsWith("image/")) {
              throw new Error(
                `type='image' requires an image MIME type, received '${link.mimetype}'.`,
              );
            }
            const nativeImage =
              await this.temporaryFileLinkStore.readCachedBase64(
                cacheKey,
                MAX_NATIVE_IMAGE_SOURCE_SIZE_BYTES,
              );
            if (!nativeImage) {
              throw new Error(
                "Image is too large for native MCP image content; retry with type='url'.",
              );
            }
            if (!nativeImage.data || nativeImage.data === "[image]") {
              throw new Error("Native MCP image base64 payload is empty.");
            }
            const decodedImageBytes = Buffer.from(
              nativeImage.data,
              "base64",
            ).byteLength;
            if (decodedImageBytes !== link.size_bytes) {
              throw new Error(
                `Native MCP image payload size mismatch: expected ${link.size_bytes} bytes, decoded ${decodedImageBytes} bytes.`,
              );
            }
            const imageOutput: GetFileResult = {
              ...output,
              type: "image",
              native_image_data: nativeImage.data,
            };
            assertSerializedBodySize(imageOutput);
            this.logger.info("Native MCP image content prepared", {
              sessionId,
              filename: link.filename,
              mimetype: link.mimetype,
              sizeBytes: link.size_bytes,
              base64Chars: nativeImage.data.length,
              decodedBytes: decodedImageBytes,
            });
            return imageOutput;
          }

          assertSerializedBodySize(output);
          return output;
        } catch (error) {
          await this.temporaryFileLinkStore.discard(ticket.download_token);
          throw error;
        }
      }

      if (responseType === "base64") {
        const cached = await this.temporaryFileLinkStore?.readCachedBase64(
          cacheKey,
          MAX_BASE64_SOURCE_SIZE_BYTES,
        );
        if (cached) {
          const output: GetFileOutput = {
            type: "base64",
            data: cached.data,
            filename: cached.filename,
            mimetype: cached.mimetype,
            size_bytes: cached.size_bytes,
          };
          assertSerializedBodySize(output);
          return output;
        }
      }

      const remote =
        await this.remoteConsoleInvoker?.invokeForRelaySession<GetFileOutput>(
          sessionId,
          "telegramMcp.fileContent.getFileRemote",
          {
            ...input,
            type: responseType,
            session_id: sessionId,
          } as Record<string, unknown>,
        );
      if (remote) {
        assertSerializedBodySize(remote);
        return remote;
      }
    }

    if (responseType === "url" || responseType === "image") {
      throw new Error(
        "URL and native image delivery must be initiated through the gateway MCP.",
      );
    }

    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = path.resolve(session?.cwd?.trim() || resolved.cwd);
    const requestedFilePath = await this.resolveRequestedFilePath(
      sessionId,
      input,
    );
    const relativeFilePath = normalizeWorkspaceRelativePath(
      workspaceDir,
      requestedFilePath,
    );
    assertWorkspaceFilePathAllowed(relativeFilePath);
    const resolvedFile = await resolveWorkspaceFileForRead(
      this.config.terminal,
      workspaceDir,
      relativeFilePath,
      responseType === "text"
        ? MAX_TEXT_SOURCE_SIZE_BYTES
        : MAX_BASE64_SOURCE_SIZE_BYTES,
    );
    const resolvedRelativeFilePath = normalizeWorkspaceRelativePath(
      workspaceDir,
      resolvedFile.filePath,
    );
    assertWorkspaceFilePathAllowed(resolvedRelativeFilePath);
    const fileContent = await readFile(resolvedFile.filePath);
    const filename = path.basename(relativeFilePath);
    const mimetype = resolveWorkspaceFileMimeType(filename);
    const output: GetFileOutput = {
      type: responseType,
      data:
        responseType === "text"
          ? decodeWorkspaceTextContent(fileContent)
          : Buffer.from(fileContent).toString("base64"),
      mimetype,
      filename,
      size_bytes: fileContent.byteLength,
    };
    assertSerializedBodySize(output);

    this.logger.info("Workspace file content retrieved", {
      sessionId,
      filename,
      sizeBytes: fileContent.byteLength,
      mimetype: output.mimetype,
    });

    return output;
  }

  public async upload(input: GetFileInput & { upload_url: string }): Promise<{
    uploaded: true;
    filename: string;
    mimetype: string;
    size_bytes: number;
  }> {
    if (this.config.distributed.mode !== "client") {
      throw new Error(
        "Temporary file uploads can only run on a client console.",
      );
    }

    this.assertAllowedUploadUrl(input.upload_url);

    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForWorkspace(
      resolved.sessionId,
    );
    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = path.resolve(session?.cwd?.trim() || resolved.cwd);
    const requestedFilePath = await this.resolveRequestedFilePath(
      sessionId,
      input,
    );
    const relativeFilePath = normalizeWorkspaceRelativePath(
      workspaceDir,
      requestedFilePath,
    );
    assertWorkspaceFilePathAllowed(relativeFilePath);
    const resolvedFile = await resolveWorkspaceFileForRead(
      this.config.terminal,
      workspaceDir,
      relativeFilePath,
      TEMPORARY_FILE_LINK_MAX_BYTES,
    );
    const resolvedRelativeFilePath = normalizeWorkspaceRelativePath(
      workspaceDir,
      resolvedFile.filePath,
    );
    assertWorkspaceFilePathAllowed(resolvedRelativeFilePath);
    const filename = path.basename(relativeFilePath);
    const mimetype = resolveWorkspaceFileMimeType(filename);
    const body = Readable.toWeb(createReadStream(resolvedFile.filePath));
    const response = await fetch(input.upload_url, {
      method: "PUT",
      headers: {
        "content-type": mimetype,
        "content-length": String(resolvedFile.sizeBytes),
        "x-telly-filename": encodeURIComponent(filename),
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Gateway temporary file upload failed with status ${response.status}: ${message || response.statusText}`,
      );
    }

    return {
      uploaded: true,
      filename,
      mimetype,
      size_bytes: resolvedFile.sizeBytes,
    };
  }

  public async list(input: GetFileListInput): Promise<GetFileListOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForWorkspace(
      resolved.sessionId,
    );

    if (this.config.distributed.mode !== "client") {
      const remote =
        await this.remoteConsoleInvoker?.invokeForRelaySession<GetFileListOutput>(
          sessionId,
          "telegramMcp.fileContent.listFilesRemote",
          {
            ...input,
            session_id: sessionId,
          } as Record<string, unknown>,
        );
      if (remote) {
        assertSerializedBodySize(remote);
        return remote;
      }
    }

    const metas =
      await this.xchangeFileMetaStore.listXchangeFileMetas(sessionId);
    const filtered = metas
      .filter((item) => !input.source || item.source === input.source)
      .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
    const limit = input.limit ?? 50;
    const output: GetFileListOutput = {
      total: filtered.length,
      files: filtered.slice(0, limit).map((item) => {
        const filename =
          item.originalName ||
          path.basename(item.relativePath?.trim() || item.filePath);
        return {
          file_path: item.filePath,
          filename,
          mimetype: item.mimeType || resolveWorkspaceFileMimeType(filename),
          source: item.source,
          ...(typeof item.sizeBytes === "number"
            ? { size_bytes: item.sizeBytes }
            : {}),
          created_at: item.uploadedAt,
        };
      }),
    };
    assertSerializedBodySize(output);

    this.logger.info("Workspace file list retrieved", {
      sessionId,
      source: input.source ?? "all",
      total: output.total,
      returned: output.files.length,
    });

    return output;
  }

  private async resolveRequestedFilePath(
    sessionId: string,
    input: GetFileInput,
  ): Promise<string> {
    if (input.file_path?.trim()) {
      if (input.selector) {
        throw new Error("Provide exactly one of file_path or selector.");
      }
      return input.file_path.trim();
    }

    if (input.selector !== "latest_screenshot") {
      throw new Error("Provide exactly one of file_path or selector.");
    }

    const screenshots = (
      await this.xchangeFileMetaStore.listXchangeFileMetas(sessionId)
    )
      .filter((item) => item.source === "browser-screenshot")
      .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
    const latest = screenshots[0];
    if (!latest) {
      throw new Error("No browser screenshots were found for this session.");
    }

    return latest.filePath;
  }

  private async normalizeSessionIdForWorkspace(
    sessionId: string,
  ): Promise<string> {
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

  private createCacheKey(sessionId: string, input: GetFileInput): string {
    return JSON.stringify({
      session_id: sessionId,
      ...(input.file_path?.trim() ? { file_path: input.file_path.trim() } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
    });
  }

  private assertAllowedUploadUrl(uploadUrl: string): void {
    const expectedBaseUrl = resolvePublicFilesBaseUrl(
      this.config.distributed.gatewayPublicUrl,
    );
    const candidateUrl = new URL(uploadUrl);
    const uploadPathPrefix = `${expectedBaseUrl.pathname.replace(/\/+$/u, "")}/upload/`;
    const uploadToken = candidateUrl.pathname.slice(uploadPathPrefix.length);

    if (
      candidateUrl.origin !== expectedBaseUrl.origin ||
      candidateUrl.username ||
      candidateUrl.password ||
      candidateUrl.search ||
      candidateUrl.hash ||
      !candidateUrl.pathname.startsWith(uploadPathPrefix) ||
      !/^[A-Za-z0-9_-]+$/u.test(uploadToken)
    ) {
      throw new Error(
        "Temporary file upload URL does not belong to the configured gateway.",
      );
    }
  }
}
