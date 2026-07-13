import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import {
  sendPartnerNoteInputSchema,
  sendPartnerNoteOutputSchema,
} from "../../../entities/request/model/schema";
import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { TelegramWebAppInitDataUnsafe } from "../../../app/webapp/auth";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import { isGatewayAuthorizationValid } from "../../../shared/lib/gatewayAuth";
import { getTellyMcpPackageRoot } from "../../../shared/lib/version/versionHandshake";

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

function isBackendErrorLike(
  value: unknown,
): value is { statusCode: number; code: string; name?: string; message?: string; data?: unknown } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { statusCode?: unknown }).statusCode === "number" &&
      typeof (value as { code?: unknown }).code === "string",
  );
}

function parseCanonicalGatewaySessionId(
  value: string | undefined,
): { clientUuid: string; localSessionId: string } | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  const clientUuid = trimmed.slice(0, separatorIndex).trim();
  const localSessionId = trimmed.slice(separatorIndex + 1).trim();
  if (!clientUuid || !localSessionId) {
    return null;
  }

  return { clientUuid, localSessionId };
}

type LiveRelayBootstrapResult = {
  session_id: string;
  session_label: string | null;
  terminal_target: boolean;
  telegram_user_id: number;
};

type LiveRelayViewResult = {
  session_id: string;
  session_label: string | null;
  captured_at: string;
  content: string;
  ansi?: string;
  cols?: number;
  rows?: number;
};

type LiveRelayActionResult = {
  ok: true;
};

type LiveRelayCaptureBufferResult = {
  session_id: string;
  session_label?: string;
  terminal_target: string;
  filename: string;
  markdown_content: string;
  capture_mode: "visible" | "full" | "lines";
  scope_description: string;
};

type RelayConsoleMessageResult = {
  ok: true;
  session_id: string;
  submitted_text: string;
  source_label?: string;
};

function unwrapLiveRelayResult<T>(response: unknown): T | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  if ("result" in response) {
    const wrapped = response as { result?: unknown };
    if (wrapped.result && typeof wrapped.result === "object") {
      return wrapped.result as T;
    }
  }

  return response as T;
}

function normalizeLiveRelayBootstrapResult(
  response: unknown,
): LiveRelayBootstrapResult | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  const sessionId =
    typeof record.session_id === "string" ? record.session_id.trim() : "";
  const telegramUserId =
    typeof record.telegram_user_id === "number"
      ? record.telegram_user_id
      : typeof record.telegram_user_id === "string" &&
          /^\d+$/u.test(record.telegram_user_id.trim())
        ? Number(record.telegram_user_id.trim())
        : NaN;

  if (!sessionId || !Number.isFinite(telegramUserId)) {
    return null;
  }

  return {
    session_id: sessionId,
    session_label:
      typeof record.session_label === "string" ? record.session_label : null,
    terminal_target: record.terminal_target === true,
    telegram_user_id: telegramUserId,
  };
}

function slugifyGatewayFilenamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

type ResolvedConnectedConsoleTarget = {
  clientUuid: string;
  localSessionId: string;
};

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

  public async requestLiveRelayBootstrap(input: {
    clientUuid: string;
    localSessionId: string;
    telegramUserId?: number;
    allowForeignBinding?: boolean;
    initDataRaw: string;
    initDataUnsafe: TelegramWebAppInitDataUnsafe;
  }): Promise<LiveRelayBootstrapResult> {
    const payload =
      typeof input.telegramUserId === "number"
        ? {
            telegramUserId: input.telegramUserId,
            ...(input.allowForeignBinding ? { allowForeignBinding: true } : {}),
          }
        : {
            initDataRaw: input.initDataRaw,
            initDataUnsafe: input.initDataUnsafe,
        };
    const rawResponse = await this.callBroker<LiveRelayBootstrapResult>(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      {
        clientUuid: input.clientUuid,
        localSessionId: input.localSessionId,
        requestType: "bootstrap",
        payload,
      },
      { meta: { internal_call: true } },
    );
    const response = normalizeLiveRelayBootstrapResult(
      unwrapLiveRelayResult<LiveRelayBootstrapResult>(rawResponse),
    );

    if (!response) {
      throw new Error(
        `Invalid live relay bootstrap response: ${JSON.stringify(rawResponse)}`,
      );
    }

    return response;
  }

  public async requestLiveRelayBootstrapValidation(input: {
    clientUuid: string;
    initDataRaw: string;
    initDataUnsafe: TelegramWebAppInitDataUnsafe;
  }): Promise<{ telegram_user_id: number }> {
    const rawResponse = await this.callBroker<{ telegram_user_id: number }>(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      {
        clientUuid: input.clientUuid,
        localSessionId: "",
        requestType: "bootstrap_validate",
        payload: {
          initDataRaw: input.initDataRaw,
          initDataUnsafe: input.initDataUnsafe,
        },
      },
      { meta: { internal_call: true } },
    );
    const response = unwrapLiveRelayResult<{ telegram_user_id: number }>(rawResponse);

    if (
      !response ||
      typeof response !== "object" ||
      typeof (response as { telegram_user_id?: unknown }).telegram_user_id !== "number"
    ) {
      throw new Error(
        `Invalid live relay bootstrap validation response: ${JSON.stringify(rawResponse)}`,
      );
    }

    return response;
  }

  public async requestLiveRelayAction(input: {
    clientUuid: string;
    localSessionId: string;
    action:
      | "up"
      | "down"
      | "enter"
      | "slash"
      | "delete"
      | "tab"
      | "escape"
      | "interrupt"
      | "text";
    text?: string;
  }): Promise<LiveRelayActionResult> {
    const rawResponse = await this.callBroker<LiveRelayActionResult>(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      {
        clientUuid: input.clientUuid,
        localSessionId: input.localSessionId,
        requestType: "action",
        payload: {
          action: input.action,
          ...(input.action === "text" ? { text: input.text ?? "" } : {}),
        },
      },
      { meta: { internal_call: true } },
    );
    const response = unwrapLiveRelayResult<LiveRelayActionResult>(rawResponse);

    if (
      !response ||
      typeof response !== "object" ||
      (response as { ok?: unknown }).ok !== true
    ) {
      throw new Error("Invalid live relay action response");
    }

    return response;
  }
  private isAuthorized(req: IncomingMessage): boolean {
    const authorization = readHeader(req, "authorization");
    return isGatewayAuthorizationValid(
      authorization,
      this.config.distributed.gatewayAuthToken,
    );
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

  private async resolveConnectedConsoleTarget(
    sessionId: string,
  ): Promise<ResolvedConnectedConsoleTarget> {
    const relayTarget = parseLiveRelaySessionId(sessionId);
    if (relayTarget) {
      return {
        clientUuid: relayTarget.clientUuid,
        localSessionId: relayTarget.localSessionId,
      };
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
      throw new Error("relay or canonical session_id is required");
    }

    const resolved = await this.callBroker<{
      client_uuid: string;
      local_session_id: string;
    } | null>(
      "telegramMcp.gatewaySocket.resolveConnectedSessionTarget",
      { sessionId: trimmedSessionId },
      { meta: { internal_call: true } },
    );

    if (!resolved) {
      throw new Error(
        `Could not resolve live console target for session_id '${trimmedSessionId}'.`,
      );
    }

    return {
      clientUuid: resolved.client_uuid,
      localSessionId: resolved.local_session_id,
    };
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
        service: "tellymcp-gateway",
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

    if (pathname === "/gateway/tools-md") {
      if (req.method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const packageRoot = getTellyMcpPackageRoot(__dirname);
        if (!packageRoot) {
          throw new Error("Could not resolve installed package root for TOOLS.md.");
        }
        const toolsPath = join(
          packageRoot,
          "TOOLS.md",
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/markdown; charset=utf-8");
        res.end(readFileSync(toolsPath, "utf8"));
        return true;
      } catch (error) {
        writeJson(res, 404, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/partner-note") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const input = sendPartnerNoteInputSchema.parse(body);
        const canonicalSource = parseCanonicalGatewaySessionId(input.session_id);
        const relaySource = parseLiveRelaySessionId(input.session_id);
        const resolvedSourceClientUuid =
          canonicalSource?.clientUuid ||
          relaySource?.clientUuid ||
          (typeof (body as { client_uuid?: unknown })?.client_uuid === "string"
            ? String((body as { client_uuid: string }).client_uuid).trim()
            : "");
        const resolvedSourceLocalSessionId =
          canonicalSource?.localSessionId ||
          relaySource?.localSessionId ||
          input.session_id?.trim() ||
          "";
        const explicitTargetClientUuid =
          typeof (body as { target_client_uuid?: unknown })?.target_client_uuid ===
          "string"
            ? String((body as { target_client_uuid: string }).target_client_uuid).trim()
            : "";
        const explicitTargetLocalSessionId =
          typeof (body as { target_local_session_id?: unknown })
            ?.target_local_session_id === "string"
            ? String(
                (body as { target_local_session_id: string }).target_local_session_id,
              ).trim()
            : "";
        const canonicalTarget = parseCanonicalGatewaySessionId(input.target_session_id);
        const resolvedTargetClientUuid =
          explicitTargetClientUuid || canonicalTarget?.clientUuid || "";
        const resolvedTargetLocalSessionId =
          explicitTargetLocalSessionId || canonicalTarget?.localSessionId || "";
        const useDirectGatewayDelivery =
          Boolean(resolvedSourceClientUuid) &&
          Boolean(resolvedSourceLocalSessionId) &&
          Boolean(resolvedTargetClientUuid) &&
          Boolean(resolvedTargetLocalSessionId);
        const useQueuedGatewayDelivery =
          !useDirectGatewayDelivery &&
          Boolean(resolvedSourceClientUuid) &&
          Boolean(resolvedSourceLocalSessionId) &&
          typeof input.target_session_id === "string" &&
          input.target_session_id.trim().length > 0;

        const output = useDirectGatewayDelivery
          ? await this.callBroker(
              "telegramMcp.gatewaySocket.sendDirectPartnerNote",
              {
                clientUuid: resolvedSourceClientUuid,
                localSessionId: resolvedSourceLocalSessionId,
                targetClientUuid: resolvedTargetClientUuid,
                targetLocalSessionId: resolvedTargetLocalSessionId,
                kind: input.kind,
                summary: input.summary,
                message: input.message,
                ...(input.expected_reply?.trim()
                  ? { expectedReply: input.expected_reply.trim() }
                  : {}),
                ...(typeof input.requires_reply === "boolean"
                  ? { requiresReply: input.requires_reply }
                  : {}),
                ...(input.in_reply_to?.trim()
                  ? { inReplyTo: input.in_reply_to.trim() }
                  : {}),
                ...(Array.isArray(input.artifact_refs)
                  ? { artifactRefs: input.artifact_refs }
                  : {}),
              },
              { meta: { internal_call: true } },
            )
          : useQueuedGatewayDelivery
          ? await this.callBroker(
              "telegramMcp.gateway.sendPartnerNote",
              {
                ...(body as Record<string, unknown>),
                client_uuid: resolvedSourceClientUuid,
                session_id: resolvedSourceLocalSessionId,
              },
              { meta: { internal_call: true } },
            )
          : this.partnerNoteRelayHandler
            ? await this.partnerNoteRelayHandler(input)
            : (() => {
                throw new Error(
                  "Gateway partner relay handler is not configured.",
                );
              })();
        if (isBackendErrorLike(output)) {
          const detail =
            typeof output.data !== "undefined"
              ? (() => {
                  try {
                    return JSON.stringify(output.data);
                  } catch {
                    return String(output.data);
                  }
                })()
              : "";
          throw new Error(
            [
              typeof output.message === "string" && output.message.trim()
                ? output.message.trim()
                : `${output.name ?? "BackendError"} (${output.code})`,
              `code=${output.code}`,
              `statusCode=${output.statusCode}`,
              ...(detail ? [`data=${detail}`] : []),
            ].join("\n"),
          );
        }
        if (
          useQueuedGatewayDelivery &&
          output &&
          typeof output === "object" &&
          typeof (output as { target_client_uuid?: unknown }).target_client_uuid ===
            "string" &&
          (output as { delivery?: unknown }).delivery &&
          typeof (output as { delivery?: unknown }).delivery === "object"
        ) {
          const publishResult = await this.callBroker<{ published?: boolean }>(
            "telegramMcp.gatewayRmq.publishDeliveryQueued",
            {
              clientUuid: (output as { target_client_uuid: string }).target_client_uuid,
              delivery: (output as { delivery: Record<string, unknown> }).delivery,
            },
            { meta: { internal_call: true } },
          );
          if (!publishResult?.published) {
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyDeliveryQueued",
              {
                clientUuid: (output as { target_client_uuid: string }).target_client_uuid,
                delivery: (output as { delivery: Record<string, unknown> }).delivery,
              },
              { meta: { internal_call: true } },
            );
          }
        }
        const parsedOutput = sendPartnerNoteOutputSchema.safeParse(output);
        if (!parsedOutput.success) {
          writeJson(res, 500, {
            error: useQueuedGatewayDelivery
              ? "Invalid queued gateway partner-note response"
              : "Invalid direct gateway partner-note response",
            details: parsedOutput.error.issues,
            output,
          });
          return true;
        }
        writeJson(res, 200, parsedOutput.data);
        return true;
      } catch (error) {
        console.error("Gateway partner-note request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/live/request-approval") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const clientUuid =
          typeof body.client_uuid === "string" ? body.client_uuid.trim() : "";
        const payload =
          body.payload && typeof body.payload === "object"
            ? (body.payload as Record<string, unknown>)
            : null;
        if (!clientUuid || !payload) {
          writeJson(res, 400, { error: "client_uuid and payload are required" });
          return true;
        }

        const result = await this.callBroker<{ delivered?: boolean }>(
          "telegramMcp.gatewaySocket.notifyLiveApprovalRequest",
          {
            clientUuid,
            payload,
          },
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, { delivered: Boolean(result?.delivered) });
        return true;
      } catch (error) {
        console.error("Gateway live approval request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/storage/list") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const source =
          typeof body.source === "string" ? body.source.trim() : "";
        const target = await this.resolveConnectedConsoleTarget(sessionId);
        const output = await this.callBroker<unknown>(
          "telegramMcp.gatewaySocket.requestClientAction",
          {
            clientUuid: target.clientUuid,
            actionName: "telegramMcp.xchange.listFileMetasRemote",
            params: {
              session_id: target.localSessionId,
              ...(source ? { source } : {}),
            },
          },
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(output)) {
          throw new Error(this.extractActionErrorMessage(output, "Storage list failed"));
        }
        writeJson(res, 200, output);
        return true;
      } catch (error) {
        console.error("Gateway storage list request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/storage/meta") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const filePath =
          typeof body.file_path === "string" ? body.file_path.trim() : "";
        const target = await this.resolveConnectedConsoleTarget(sessionId);
        const output = await this.callBroker<unknown>(
          "telegramMcp.gatewaySocket.requestClientAction",
          {
            clientUuid: target.clientUuid,
            actionName: "telegramMcp.xchange.getFileMetaRemote",
            params: {
              session_id: target.localSessionId,
              file_path: filePath,
            },
          },
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(output)) {
          throw new Error(this.extractActionErrorMessage(output, "Storage meta fetch failed"));
        }
        writeJson(res, 200, output);
        return true;
      } catch (error) {
        console.error("Gateway storage meta request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/storage/delete-meta") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const filePath =
          typeof body.file_path === "string" ? body.file_path.trim() : "";
        const target = await this.resolveConnectedConsoleTarget(sessionId);
        const output = await this.callBroker<unknown>(
          "telegramMcp.gatewaySocket.requestClientAction",
          {
            clientUuid: target.clientUuid,
            actionName: "telegramMcp.xchange.deleteFileMetaRemote",
            params: {
              session_id: target.localSessionId,
              file_path: filePath,
            },
          },
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(output)) {
          throw new Error(this.extractActionErrorMessage(output, "Storage meta delete failed"));
        }
        writeJson(res, 200, output);
        return true;
      } catch (error) {
        console.error("Gateway storage delete-meta request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/live/resolve-approval") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const clientUuid =
          typeof body.client_uuid === "string" ? body.client_uuid.trim() : "";
        const approved = body.approved === true;
        const payload =
          body.payload && typeof body.payload === "object"
            ? (body.payload as Record<string, unknown>)
            : null;
        if (!clientUuid || !payload) {
          writeJson(res, 400, { error: "client_uuid and payload are required" });
          return true;
        }

        const result = await this.callBroker<{ delivered?: boolean }>(
          "telegramMcp.gatewaySocket.notifyLiveApprovalResolved",
          {
            clientUuid,
            approved,
            payload,
          },
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, { delivered: Boolean(result?.delivered) });
        return true;
      } catch (error) {
        console.error("Gateway live approval resolution failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/live/capture-buffer") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const relayTarget = parseLiveRelaySessionId(sessionId);
        const scope =
          body.scope && typeof body.scope === "object"
            ? (body.scope as Record<string, unknown>)
            : null;

        if (!relayTarget || !scope) {
          writeJson(res, 400, {
            error: "relay session_id and scope are required",
          });
          return true;
        }

        if (scope.mode === "visible") {
          const rawResponse = await this.callBroker<LiveRelayViewResult>(
            "telegramMcp.gatewaySocket.requestLiveRelay",
            {
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              requestType: "view",
              payload: {},
            },
            { meta: { internal_call: true } },
          );
          const response = unwrapLiveRelayResult<LiveRelayViewResult>(rawResponse);

          if (
            !response ||
            typeof response !== "object" ||
            typeof (response as { content?: unknown }).content !== "string"
          ) {
            throw new Error("Invalid live relay view response");
          }

          const capturedAt = new Date().toISOString();
          const titleBase =
            typeof response.session_label === "string" && response.session_label.trim()
              ? response.session_label.trim()
              : relayTarget.localSessionId;
          const filenameBase =
            slugifyGatewayFilenamePart(titleBase) || "session-buffer";
          const timestamp = capturedAt.replace(/[:.]/g, "-");
          writeJson(res, 200, {
            session_id: sessionId,
            ...(typeof response.session_label === "string" &&
            response.session_label.trim()
              ? { session_label: response.session_label.trim() }
              : {}),
            terminal_target: `relay:${relayTarget.clientUuid}/${relayTarget.localSessionId}`,
            filename: `${filenameBase}-${timestamp}.md`,
            markdown_content: [
              "# Terminal Buffer",
              "",
              `- Session: ${titleBase}`,
              `- Session ID: ${sessionId}`,
              `- terminal target: relay:${relayTarget.clientUuid}/${relayTarget.localSessionId}`,
              "- Capture scope: visible pane",
              `- Captured at: ${capturedAt}`,
              "",
              "```text",
              response.content.replaceAll("\u0000", ""),
              "```",
              "",
            ].join("\n"),
            capture_mode: "visible",
            scope_description: "visible pane",
          } satisfies LiveRelayCaptureBufferResult);
          return true;
        }

        const result = await this.callBroker<LiveRelayCaptureBufferResult>(
          "telegramMcp.gatewaySocket.requestClientAction",
          {
            clientUuid: relayTarget.clientUuid,
            actionName: "telegramMcp.terminalBuffer.captureBufferRemote",
            params: {
              session_id: relayTarget.localSessionId,
              scope,
            },
          },
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error:
            error instanceof Error
              ? error.message
              : `Failed to capture remote buffer. Update the client agent if it is not on the latest build. Cause: ${String(error)}`,
        });
        return true;
      }
    }

    if (pathname === "/gateway/live/action") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const action =
          typeof body.action === "string" ? body.action.trim() : "";
        const text =
          typeof body.text === "string" ? body.text : "";
        const relayTarget = parseLiveRelaySessionId(sessionId);

        if (!relayTarget) {
          writeJson(res, 400, {
            error: "relay session_id is required",
          });
          return true;
        }

        if (!["enter", "escape", "text"].includes(action)) {
          writeJson(res, 400, {
            error: "action must be one of: enter, escape, text",
          });
          return true;
        }

        if (action === "text" && (!text || text.length > 16)) {
          writeJson(res, 400, {
            error: "text payload is required and must be <= 16 characters",
          });
          return true;
        }

        await this.requestLiveRelayAction({
          clientUuid: relayTarget.clientUuid,
          localSessionId: relayTarget.localSessionId,
          action: action as "enter" | "escape" | "text",
          ...(action === "text" ? { text } : {}),
        });
        writeJson(res, 200, { ok: true });
        return true;
      } catch (error) {
        console.error("Gateway live action request failed", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
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

    if (pathname === "/gateway/user/auth") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.upsertGatewayUser",
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

    if (pathname === "/gateway/user/route") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.resolveGatewayUserRoute",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, result ?? {});
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/admin/prune-state") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const result = await this.callBroker(
          "telegramMcp.gateway.pruneGatewayState",
          {},
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

    if (pathname === "/gateway/relay/console-message") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const targetClientUuid =
          typeof body.target_client_uuid === "string"
            ? body.target_client_uuid.trim()
            : "";
        const targetLocalSessionId =
          typeof body.target_local_session_id === "string"
            ? body.target_local_session_id.trim()
            : "";
        const text =
          typeof body.message === "string" ? body.message.trim() : "";
        const attachments = Array.isArray(body.attachments)
          ? body.attachments.filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
          : [];
        const sourceLabel =
          typeof body.source_actor_label === "string"
            ? body.source_actor_label.trim()
            : undefined;

        if (!targetClientUuid || !targetLocalSessionId || !text) {
          writeJson(res, 400, {
            error:
              "target_client_uuid, target_local_session_id, and message are required",
          });
          return true;
        }

        const submittedText =
          attachments.length > 0
            ? `${text} [attachments saved: ${attachments.join(", ")}]`.trim()
            : text;

        await this.requestLiveRelayAction({
          clientUuid: targetClientUuid,
          localSessionId: targetLocalSessionId,
          action: "text",
          text: submittedText,
        });
        await this.requestLiveRelayAction({
          clientUuid: targetClientUuid,
          localSessionId: targetLocalSessionId,
          action: "enter",
        });

        writeJson(res, 200, {
          ok: true,
          session_id: targetLocalSessionId,
          submitted_text: submittedText,
          ...(sourceLabel ? { source_label: sourceLabel } : {}),
        } satisfies RelayConsoleMessageResult);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/transport/notify") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const output = await this.callBroker(
          "telegramMcp.notify.sendForGatewaySession",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, output);
      } catch (error) {
        writeText(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    }

    if (pathname === "/gateway/transport/document") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const output = await this.callBroker(
          "telegramMcp.notify.sendDocumentForGatewaySession",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, output);
      } catch (error) {
        writeText(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    }

    if (pathname === "/gateway/transport/send-file") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const sessionId =
          typeof body.session_id === "string" ? body.session_id.trim() : "";
        const filePath =
          typeof body.file_path === "string" ? body.file_path.trim() : "";
        const caption =
          typeof body.caption === "string" && body.caption.trim()
            ? body.caption.trim()
            : undefined;
        const target = await this.resolveConnectedConsoleTarget(sessionId);
        const output = await this.callBroker<unknown>(
          "telegramMcp.gatewaySocket.requestClientAction",
          {
            clientUuid: target.clientUuid,
            actionName: "telegramMcp.notify.sendDocumentRemote",
            params: {
              session_id: target.localSessionId,
              file_path: filePath,
              ...(caption ? { caption } : {}),
            },
          },
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(output)) {
          throw new Error(this.extractActionErrorMessage(output, "Storage file send failed"));
        }
        writeJson(res, 200, output);
      } catch (error) {
        writeText(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    }

    if (pathname === "/gateway/transport/request") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const output = await this.callBroker(
          "telegramMcp.notify.sendRequestForGatewaySession",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, output);
      } catch (error) {
        writeText(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    }

    if (pathname === "/gateway/transport/reply") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const output = await this.callBroker(
          "telegramMcp.gatewaySocket.notifyTransportReply",
          body,
          { meta: { internal_call: true } },
        );
        writeJson(res, 200, output);
      } catch (error) {
        writeText(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    }

    if (pathname === "/gateway/clients/list") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listClients",
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

    if (pathname === "/gateway/clients/connected") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listLiveClients",
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

    if (pathname === "/gateway/sessions/known") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const filterClientUuid =
          typeof body.client_uuid === "string" && body.client_uuid.trim()
            ? body.client_uuid.trim()
            : null;
        const ownerUserUuid =
          typeof body.owner_user_uuid === "string" && body.owner_user_uuid.trim()
            ? body.owner_user_uuid.trim()
            : null;
        const telegramUserId =
          typeof body.telegram_user_id === "number"
            ? String(body.telegram_user_id)
            : typeof body.telegram_user_id === "string" && body.telegram_user_id.trim()
              ? body.telegram_user_id.trim()
              : null;
        const connectedOnly = typeof body.connected_only === "boolean"
          ? body.connected_only
          : false;
        const [liveResult, scopedClientsResult] = await Promise.all([
          this.callBroker(
            "telegramMcp.gateway.listLiveConsoles",
            body,
            { meta: { internal_call: true } },
          ) as Promise<{
            sessions?: Array<{
              session_id: string;
              client_uuid: string;
              local_session_id: string;
              cwd?: string | null;
              session_label?: string | null;
              client_label?: string | null;
              system_username?: string | null;
              telegram_username?: string | null;
              telegram_display_name?: string | null;
              bot_username?: string | null;
              node_id?: string | null;
              package_version?: string | null;
              project_uuids: string[];
              project_names: string[];
              connected: boolean;
              registered: boolean;
            }>;
          }>,
          this.callBroker(
            "telegramMcp.gateway.listClients",
            body,
            { meta: { internal_call: true } },
          ) as Promise<{
            clients?: Array<{
              client_uuid: string;
            }>;
          }>,
        ]);
        const allowedClientUuids =
          ownerUserUuid || telegramUserId
            ? new Set(
                (Array.isArray(scopedClientsResult.clients)
                  ? scopedClientsResult.clients
                  : []
                )
                  .map((client) =>
                    typeof client.client_uuid === "string"
                      ? client.client_uuid.trim()
                      : "",
                  )
                  .filter(Boolean),
              )
            : null;

        const sessions = (Array.isArray(liveResult.sessions) ? liveResult.sessions : [])
          .filter((session) =>
            allowedClientUuids ? allowedClientUuids.has(session.client_uuid) : true,
          )
          .filter((session) =>
            filterClientUuid ? session.client_uuid === filterClientUuid : true,
          )
          .filter((session) => (connectedOnly ? session.connected : true))
          .sort((left, right) => {
            const leftLabel = left.session_label?.trim() || left.local_session_id;
            const rightLabel =
              right.session_label?.trim() || right.local_session_id;
            return `${left.client_uuid}:${leftLabel}`.localeCompare(
              `${right.client_uuid}:${rightLabel}`,
            );
          });

        writeJson(res, 200, {
          total: sessions.length,
          sessions,
        });
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.createProject",
          body,
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(result)) {
          throw new Error(
            result.message
              ? `${result.message}${result.code ? ` [${result.code}]` : ""}`
              : `Gateway createProject failed [${result.code}]`,
          );
        }
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.joinProject",
          body,
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(result)) {
          throw new Error(
            result.message
              ? `${result.message}${result.code ? ` [${result.code}]` : ""}`
              : `Gateway joinProject failed [${result.code}]`,
          );
        }
        if (
          Array.isArray(result.notify_client_uuids) &&
          result.notify_client_uuids.length > 0 &&
          typeof result.project_uuid === "string" &&
          typeof result.name === "string"
        ) {
          const publishResult = await this.callBroker<{ published?: boolean }>(
            "telegramMcp.gatewayRmq.publishProjectMemberJoined",
            {
              clientUuids: result.notify_client_uuids,
              projectUuid: result.project_uuid,
              projectName: result.name,
              memberDisplayName:
                typeof result.member_display_name === "string"
                  ? result.member_display_name
                  : undefined,
              memberTelegramUsername:
                typeof result.member_telegram_username === "string"
                  ? result.member_telegram_username
                  : undefined,
            },
            { meta: { internal_call: true } },
          );
          if (!publishResult?.published) {
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyProjectMemberJoined",
              {
                clientUuids: result.notify_client_uuids,
                projectUuid: result.project_uuid,
                projectName: result.name,
                memberDisplayName:
                  typeof result.member_display_name === "string"
                    ? result.member_display_name
                    : undefined,
                memberTelegramUsername:
                  typeof result.member_telegram_username === "string"
                    ? result.member_telegram_username
                    : undefined,
              },
              { meta: { internal_call: true } },
            );
          }
        }
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.registerSession",
          body,
          { meta: { internal_call: true } },
        );
        if (isBackendErrorLike(result)) {
          throw new Error(
            result.message
              ? `${result.message}${result.code ? ` [${result.code}]` : ""}`
              : `Gateway registerSession failed [${result.code}]`,
          );
        }
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

    if (pathname === "/gateway/history/list") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listSessionHistory",
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.leaveProject",
          body,
          { meta: { internal_call: true } },
        );
        if (
          result.left === true &&
          Array.isArray(result.notify_client_uuids) &&
          result.notify_client_uuids.length > 0 &&
          typeof result.project_uuid === "string" &&
          typeof result.project_name === "string"
        ) {
          const publishResult = await this.callBroker<{ published?: boolean }>(
            "telegramMcp.gatewayRmq.publishProjectMemberLeft",
            {
              clientUuids: result.notify_client_uuids,
              projectUuid: result.project_uuid,
              projectName: result.project_name,
              memberDisplayName:
                typeof result.member_display_name === "string"
                  ? result.member_display_name
                  : undefined,
              memberTelegramUsername:
                typeof result.member_telegram_username === "string"
                  ? result.member_telegram_username
                  : undefined,
            },
            { meta: { internal_call: true } },
          );
          if (!publishResult?.published) {
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyProjectMemberLeft",
              {
                clientUuids: result.notify_client_uuids,
                projectUuid: result.project_uuid,
                projectName: result.project_name,
                memberDisplayName:
                  typeof result.member_display_name === "string"
                    ? result.member_display_name
                    : undefined,
                memberTelegramUsername:
                  typeof result.member_telegram_username === "string"
                    ? result.member_telegram_username
                    : undefined,
              },
              { meta: { internal_call: true } },
            );
          }
        }
        writeJson(res, 200, result);
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/projects/delete") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.deleteProject",
          body,
          { meta: { internal_call: true } },
        );
        if (
          result.deleted === true &&
          Array.isArray(result.notify_client_uuids) &&
          result.notify_client_uuids.length > 0 &&
          typeof result.project_uuid === "string" &&
          typeof result.project_name === "string"
        ) {
          const publishResult = await this.callBroker<{ published?: boolean }>(
            "telegramMcp.gatewayRmq.publishProjectDeleted",
            {
              clientUuids: result.notify_client_uuids,
              projectUuid: result.project_uuid,
              projectName: result.project_name,
            },
            { meta: { internal_call: true } },
          );
          if (!publishResult?.published) {
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyProjectDeleted",
              {
                clientUuids: result.notify_client_uuids,
                projectUuid: result.project_uuid,
                projectName: result.project_name,
              },
              { meta: { internal_call: true } },
            );
          }
        }
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

    writeJson(res, 501, {
      error:
        "Distributed gateway relay is scaffolded but not implemented yet in this build.",
      mode: this.config.distributed.mode,
    });
    return true;
  }
}
