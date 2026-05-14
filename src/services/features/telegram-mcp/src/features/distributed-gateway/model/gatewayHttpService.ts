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

    if (pathname === "/gateway/partner-note") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      if (!this.partnerNoteRelayHandler) {
        writeJson(res, 503, {
          error: "Gateway partner relay handler is not configured.",
        });
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const input = sendPartnerNoteInputSchema.parse(body);
        const output = await this.partnerNoteRelayHandler(input);
        writeJson(res, 200, sendPartnerNoteOutputSchema.parse(output));
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

    if (this.config.distributed.gatewayAuthToken) {
      const authorization = readHeader(req, "authorization");
      if (
        authorization !== `Bearer ${this.config.distributed.gatewayAuthToken}`
      ) {
        writeText(res, 401, "Unauthorized");
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
