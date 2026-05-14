import type { IncomingMessage, ServerResponse } from "node:http";

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
    const response = await this.callBroker<{
      node: {
        node_id: number;
        parent_id: number;
        public_url: string;
      };
      upload: {
        bucketName: string;
        objectName: string;
        storageRef: string;
      };
    }>(
      "minio.ingest",
      {
        files: [
          {
            fieldname: "file",
            originalname: normalizedRelativePath.split("/").pop() || "file.bin",
            encoding: "7bit",
            mimetype: mimeType,
            size: content.byteLength,
            buffer: content,
          },
        ],
        fields: {
          parent_id: String(targetDir.node_id),
          name: normalizedRelativePath.split("/").pop() || "file.bin",
        },
      },
      { meta: { internal_call: true } },
    );

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

  private async readXchangeFile(body: Record<string, unknown>): Promise<unknown> {
    const storageRef = String(body.storageRef || "").trim();
    const relativePath = normalizeRelativePath(String(body.relativePath || ""));

    if (!storageRef) {
      throw new Error("storageRef is required");
    }

    const resolved = await this.callBroker<{
      bucketName: string;
      objectName: string;
    }>(
      "minio.resolveFileRef",
      {
        ref: storageRef,
        name: relativePath.split("/").pop() || "file.bin",
      },
      { meta: { internal_call: true } },
    );

    const content = await this.callBroker<Uint8Array | Buffer>(
      "minio.getObject",
      {
        bucketName: resolved.bucketName,
        objectName: resolved.objectName,
      },
      { meta: { internal_call: true } },
    );

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
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
        writeJson(res, 200, sendPartnerNoteOutputSchema.parse(output));
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

    writeJson(res, 501, {
      error:
        "Distributed gateway relay is scaffolded but not implemented yet in this build.",
      mode: this.config.distributed.mode,
    });
    return true;
  }
}
