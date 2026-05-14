import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../../../app/config/env";
import {
  sendPartnerNoteInputSchema,
  sendPartnerNoteOutputSchema,
} from "../../../entities/request/model/schema";
import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { ExchangeFileSource } from "../../../shared/integrations/object-storage/minioExchangeStore";

function readHeader(
  req: IncomingMessage,
  headerName: string,
): string | undefined {
  const value = req.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

function sanitizePathSegment(value: string): string {
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
  const normalized = String(relativePath || "")
    .split(/[\/\\]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  if (!normalized) {
    throw new Error("Relative exchange path is required.");
  }

  return normalized;
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

type GatewayRequestUploadResponse = {
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

type GatewayCompleteUploadResponse = {
  node?: {
    node_id: number;
    parent_id: number;
    public_url: string;
    name: string;
    hash: string;
  } | null;
  upload?: {
    bucketName: string;
    objectName: string;
    storageRef: string;
  } | null;
};

type GatewayVfsNodeExistsResult = {
  error?: boolean;
  message?: string;
};

function buildPartnerNoteOutputFallback(
  input: SendPartnerNoteInput,
  rawOutput: unknown,
): SendPartnerNoteOutput {
  const outputRecord =
    rawOutput && typeof rawOutput === "object"
      ? (rawOutput as Record<string, unknown>)
      : {};

  return {
    session_id:
      typeof outputRecord.session_id === "string"
        ? outputRecord.session_id
        : input.session_id ?? "unknown-session",
    partner_session_id:
      typeof outputRecord.partner_session_id === "string"
        ? outputRecord.partner_session_id
        : input.target_session_id ?? "unknown-partner-session",
    kind:
      typeof outputRecord.kind === "string"
        ? (outputRecord.kind as SendPartnerNoteOutput["kind"])
        : input.kind,
    share_id:
      typeof outputRecord.share_id === "string"
        ? outputRecord.share_id
        : `gateway-${Date.now()}`,
    delivery_status:
      outputRecord.delivery_status === "delivered" ? "delivered" : "queued",
    note_path:
      typeof outputRecord.note_path === "string"
        ? outputRecord.note_path
        : "gateway://shares/pending.md",
    share_index_path:
      typeof outputRecord.share_index_path === "string"
        ? outputRecord.share_index_path
        : "gateway://SHARED_INDEX.md",
    copied_artifacts: Array.isArray(outputRecord.copied_artifacts)
      ? outputRecord.copied_artifacts.filter(
          (item): item is string => typeof item === "string",
        )
      : [
          ...(input.artifact_refs?.map(
            (item) => item.original_name ?? item.relative_path ?? item.file_path,
          ) ?? []),
          ...(input.artifacts ?? []),
        ],
    inbox_message_id:
      typeof outputRecord.inbox_message_id === "string"
        ? outputRecord.inbox_message_id
        : `gateway-${Date.now()}`,
    requires_reply:
      typeof outputRecord.requires_reply === "boolean"
        ? outputRecord.requires_reply
        : Boolean(input.requires_reply ?? (input.kind === "question" || input.kind === "request")),
  };
}

export class GatewayHttpService {
  public constructor(
    private readonly config: AppConfig,
    private readonly callBroker: <T>(
      actionName: string,
      params?: unknown,
      options?: { meta?: Record<string, unknown> },
    ) => Promise<T>,
  ) {}

  private partnerNoteRelayHandler:
    | ((input: SendPartnerNoteInput) => Promise<SendPartnerNoteOutput>)
    | null = null;

  public setPartnerNoteRelayHandler(
    handler: (input: SendPartnerNoteInput) => Promise<SendPartnerNoteOutput>,
  ): void {
    this.partnerNoteRelayHandler = handler;
  }

  public isEnabled(): boolean {
    return (
      this.config.distributed.mode === "gateway" ||
      this.config.distributed.mode === "both"
    );
  }

  public matches(pathname: string): boolean {
    return pathname === "/gateway/healthz" || pathname.startsWith("/gateway/");
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.config.distributed.gatewayAuthToken) {
      return true;
    }

    const authorization = readHeader(req, "authorization");
    return authorization === `Bearer ${this.config.distributed.gatewayAuthToken}`;
  }

  private async storeXchangeFile(body: Record<string, unknown>): Promise<unknown> {
    const ownerSegment = sanitizePathSegment(String(body.ownerSegment || ""));
    const sessionSegment = sanitizePathSegment(String(body.sessionSegment || ""));
    const source = String(body.source || "") as ExchangeFileSource;
    const relativePath = normalizeRelativePath(String(body.relativePath || ""));
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType.trim()
        ? body.mimeType.trim()
        : "application/octet-stream";
    const contentBase64 = String(body.contentBase64 || "");
    const vfsScope =
      typeof body.vfsScope === "string" && body.vfsScope.trim()
        ? body.vfsScope.trim()
        : this.config.mcp.vfsScope;

    if (!ownerSegment || !sessionSegment) {
      throw new Error("ownerSegment and sessionSegment are required");
    }

    if (
      source !== "telegram-upload" &&
      source !== "browser-screenshot" &&
      source !== "partner-artifact"
    ) {
      throw new Error("Invalid exchange file source");
    }

    if (!contentBase64) {
      throw new Error("contentBase64 is required");
    }

    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const kindSegment = getXchangeKind(source);
    const relativeDir = normalizedRelativePath.includes("/")
      ? normalizedRelativePath.slice(0, normalizedRelativePath.lastIndexOf("/"))
      : ".";
    const targetDirPath =
      source === "partner-artifact"
        ? relativeDir === "." ? kindSegment : relativeDir
        : relativeDir === "." ? kindSegment : `${kindSegment}/${relativeDir}`;

    const targetDir = await this.callBroker<{
      node_id: number;
    }>(
      "vfs.vfsCreateDir",
      {
        scope: vfsScope,
        node: {
          name: `xchange/${ownerSegment}/${sessionSegment}/${targetDirPath}`,
        },
      },
      { meta: { internal_call: true } },
    );

    const content = Buffer.from(contentBase64, "base64");
    const requestedFileName = normalizedRelativePath.split("/").pop() || "file.bin";
    const fileName = await this.ensureUniqueFileName(
      targetDir.node_id,
      requestedFileName,
      vfsScope,
    );
    const ownerSub = randomUUID();
    const request = await this.callBroker<GatewayRequestUploadResponse>(
      "minio.requestUpload",
      {
        name: fileName,
        contentType: mimeType,
        parent_id: targetDir.node_id,
        size: content.byteLength,
      },
      { meta: { internal_call: true, user: { sub: ownerSub } } },
    );

    const uploadHeaders = new Headers();
    Object.entries(request.headers || {}).forEach(([key, value]) => {
      if (value != null && value !== "") {
        uploadHeaders.set(key, value);
      }
    });

    const uploadResponse = await fetch(request.uploadUrl, {
      method: request.method || "PUT",
      headers: uploadHeaders,
      body: content,
    });
    if (!uploadResponse.ok) {
      const message = await uploadResponse.text().catch(() => "");
      throw new Error(
        `Managed upload PUT failed with status ${uploadResponse.status}: ${message || uploadResponse.statusText}`,
      );
    }

    const response = await this.callBroker<GatewayCompleteUploadResponse>(
      "minio.completeUpload",
      {
        uploadId: request.uploadId,
        storageRef: request.storageRef,
        name: fileName,
        parent_id: targetDir.node_id,
      },
      { meta: { internal_call: true, user: { sub: ownerSub } } },
    );
    if (!response.node?.node_id || !response.upload?.storageRef) {
      throw new Error(
        this.extractActionErrorMessage(
          response,
          "Managed upload completed without VFS node metadata.",
        ),
      );
    }

    return {
      filePath: `vfs://${response.node.public_url}`,
      relativePath: normalizedRelativePath,
      storageRef: response.upload.storageRef,
      bucketName: response.upload.bucketName,
      objectName: response.upload.objectName,
      vfsNodeId: response.node.node_id,
      vfsPublicUrl: response.node.public_url,
      vfsParentId: response.node.parent_id,
      sizeBytes: content.byteLength,
    };
  }

  private async ensureUniqueFileName(
    parentNodeId: number,
    requestedFileName: string,
    vfsScope: string,
  ): Promise<string> {
    const ext = path.extname(requestedFileName);
    const baseName = path.basename(requestedFileName, ext) || "file";
    let candidate = requestedFileName;
    let index = 1;

    while (await this.vfsFileExists(parentNodeId, candidate, vfsScope)) {
      candidate = `${baseName}--${index}${ext}`;
      index += 1;
    }

    return candidate;
  }

  private async vfsFileExists(
    parentNodeId: number,
    fileName: string,
    vfsScope: string,
  ): Promise<boolean> {
    const result = await this.callBroker<GatewayVfsNodeExistsResult>(
      "vfs.vfsNodeExists",
      {
        node: {
          parent_id: parentNodeId,
          name: fileName,
          type: "FILE",
          scope: vfsScope,
        },
        throw: false,
      },
      { meta: { internal_call: true } },
    );
    return Boolean(result?.error);
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

  private async readXchangeFile(body: Record<string, unknown>): Promise<unknown> {
    const storageRef = String(body.storageRef || "").trim();
    const relativePath = normalizeRelativePath(String(body.relativePath || ""));

    if (!storageRef) {
      throw new Error("storageRef is required");
    }

    const resolved = await this.callBroker<{
      bucketName: string;
      objectName: string;
    } | unknown>(
      "minio.resolveFileRef",
      {
        ref: storageRef,
        name: relativePath.split("/").pop() || "file.bin",
      },
      { meta: { internal_call: true } },
    );
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

    const content = await this.callBroker<Uint8Array | Buffer>(
      "minio.getObject",
      {
        bucketName: (resolved as { bucketName: string }).bucketName,
        objectName: (resolved as { objectName: string }).objectName,
      },
      { meta: { internal_call: true } },
    );
    const buffer = Buffer.isBuffer(content)
      ? content
      : content instanceof Uint8Array
        ? Buffer.from(content)
        : (() => {
            throw new Error(
              this.extractActionErrorMessage(
                content,
                "Failed to read stored file content.",
              ),
            );
          })();
    return {
      contentBase64: buffer.toString("base64"),
    };
  }

  private async deleteXchangeFile(body: Record<string, unknown>): Promise<unknown> {
    const vfsNodeId =
      typeof body.vfsNodeId === "number" && Number.isFinite(body.vfsNodeId)
        ? body.vfsNodeId
        : undefined;
    const storageRef =
      typeof body.storageRef === "string" && body.storageRef.trim()
        ? body.storageRef.trim()
        : undefined;

    if (typeof vfsNodeId === "number" && vfsNodeId > 0) {
      try {
        await this.callBroker(
          "vfs.vfsDeleteNode",
          {
            node_id: [vfsNodeId],
          },
          { meta: { internal_call: true } },
        );
        return { deleted: true };
      } catch {
        // fallback to direct object deletion below
      }
    }

    if (storageRef) {
      await this.callBroker(
        "minio.deleteByRef",
        {
          ref: storageRef,
        },
        { meta: { internal_call: true } },
      );
      return { deleted: true };
    }

    return { deleted: false };
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const knownBody = (req as IncomingMessage & { body?: unknown }).body;
    if (knownBody !== undefined) {
      return knownBody;
    }

    const knownParams = (
      req as IncomingMessage & { $params?: Record<string, unknown> }
    ).$params;
    if (
      knownParams &&
      typeof knownParams === "object" &&
      ("kind" in knownParams ||
        "summary" in knownParams ||
        "message" in knownParams ||
        "session_id" in knownParams)
    ) {
      return knownParams;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
      return undefined;
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return undefined;
    }

    return JSON.parse(raw) as unknown;
  }

  public async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!this.isEnabled() || !this.matches(pathname)) {
      return false;
    }

    if (pathname === "/gateway/healthz") {
      writeJson(res, 200, {
        ok: true,
        service: "telegram-human-mcp-gateway",
        mode: this.config.distributed.mode,
        databaseConfigured: Boolean(process.env.DB_HOST && process.env.DB_NAME),
        s3Configured: Boolean(this.config.distributed.gatewayS3Bucket),
      });
      return true;
    }

    if (!this.isAuthorized(req)) {
      writeText(res, 401, "Unauthorized");
      return true;
    }

    if (pathname === "/gateway/partner-note") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const input = sendPartnerNoteInputSchema.parse(body);
        const useQueuedGatewayDelivery =
          typeof (body as { client_uuid?: unknown })?.client_uuid === "string" &&
          typeof input.target_session_id === "string" &&
          input.target_session_id.trim().length > 0;

        const output = useQueuedGatewayDelivery
          ? await this.callBroker(
              "telegramMcp.gateway.sendPartnerNote",
              body,
              { meta: { internal_call: true } },
            )
          : this.partnerNoteRelayHandler
            ? await this.partnerNoteRelayHandler(input)
            : (() => {
                throw new Error(
                  "Gateway partner relay handler is not configured.",
                );
              })();
        const parsedOutput = sendPartnerNoteOutputSchema.safeParse(output);
        if (!parsedOutput.success) {
          const fallback = buildPartnerNoteOutputFallback(input, output);
          writeJson(res, 200, fallback);
          return true;
        }
        writeJson(res, 200, parsedOutput.data);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/xchange/store") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.storeXchangeFile(body);
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/xchange/read") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.readXchangeFile(body);
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/xchange/delete") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.deleteXchangeFile(body);
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/client/register") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.registerClient",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/create") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.createProject",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/join") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.joinProject",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/sessions/register") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.registerSession",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/list") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listProjects",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/leave") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.leaveProject",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/sessions") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listProjectSessions",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/deliveries/poll") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.pollDeliveries",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/deliveries/ack") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.ackDeliveries",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/deliveries/status") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.getDeliveryStatuses",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    writeJson(res, 501, {
      error:
        "Distributed gateway relay is scaffolded but not implemented yet in this build.",
      mode: this.config.distributed.mode,
    });
    return true;
  }
}
