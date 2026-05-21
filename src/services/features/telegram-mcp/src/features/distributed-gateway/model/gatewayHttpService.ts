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

type LiveRelayBootstrapResult = {
  session_id: string;
  session_label: string | null;
  tmux_target: boolean;
  poll_interval_ms: number;
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
    tmux_target: record.tmux_target === true,
    poll_interval_ms:
      typeof record.poll_interval_ms === "number" && record.poll_interval_ms > 0
        ? record.poll_interval_ms
        : 2000,
    telegram_user_id: telegramUserId,
  };
}

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
    xchange_record_id:
      typeof outputRecord.xchange_record_id === "string"
        ? outputRecord.xchange_record_id
        : (typeof outputRecord.share_id === "string"
            ? outputRecord.share_id
            : `gateway-${Date.now()}`),
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

function slugifyGatewayFilenamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
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

  public async requestLiveRelayView(input: {
    clientUuid: string;
    localSessionId: string;
  }): Promise<LiveRelayViewResult> {
    const rawResponse = await this.callBroker<LiveRelayViewResult>(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      {
        clientUuid: input.clientUuid,
        localSessionId: input.localSessionId,
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
    if (!this.config.distributed.gatewayAuthToken) {
      return true;
    }

    const authorization = readHeader(req, "authorization");
    return authorization === `Bearer ${this.config.distributed.gatewayAuthToken}`;
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
        const toolsPath = join(
          getTellyMcpPackageRoot(__dirname) ?? process.cwd(),
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
        const useDirectGatewayDelivery =
          typeof (body as { client_uuid?: unknown })?.client_uuid === "string" &&
          typeof (body as { target_client_uuid?: unknown })?.target_client_uuid ===
            "string" &&
          typeof (body as { target_local_session_id?: unknown })
            ?.target_local_session_id === "string";
        const useQueuedGatewayDelivery =
          !useDirectGatewayDelivery &&
          typeof (body as { client_uuid?: unknown })?.client_uuid === "string" &&
          typeof input.target_session_id === "string" &&
          input.target_session_id.trim().length > 0;

        const output = useDirectGatewayDelivery
          ? await this.callBroker(
              "telegramMcp.gatewaySocket.sendDirectPartnerNote",
              {
                clientUuid: String(
                  (body as { client_uuid: string }).client_uuid,
                ).trim(),
                localSessionId: input.session_id?.trim() || "",
                targetClientUuid: String(
                  (body as { target_client_uuid: string }).target_client_uuid,
                ).trim(),
                targetLocalSessionId: String(
                  (
                    body as { target_local_session_id: string }
                  ).target_local_session_id,
                ).trim(),
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
          if (useQueuedGatewayDelivery) {
            writeJson(res, 500, {
              error: "Invalid queued gateway partner-note response",
              details: parsedOutput.error.issues,
              output,
            });
            return true;
          }

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

    if (pathname === "/gateway/pair-codes/register") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.pair.registerRemotePairCode",
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

    if (pathname === "/gateway/relay/inbox") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = await this.readJsonBody(req);
        const input = sendPartnerNoteInputSchema.parse(body);
        const clientUuid =
          typeof (body as { client_uuid?: unknown })?.client_uuid === "string"
            ? String((body as { client_uuid: string }).client_uuid).trim()
            : "";
        const localSessionId =
          typeof (body as { local_session_id?: unknown })?.local_session_id ===
          "string"
            ? String((body as { local_session_id: string }).local_session_id).trim()
            : "";
        const targetClientUuid =
          typeof (body as { target_client_uuid?: unknown })?.target_client_uuid ===
          "string"
            ? String((body as { target_client_uuid: string }).target_client_uuid).trim()
            : "";
        const targetLocalSessionId =
          typeof (body as { target_local_session_id?: unknown })
            ?.target_local_session_id === "string"
            ? String(
                (
                  body as { target_local_session_id: string }
                ).target_local_session_id,
              ).trim()
            : "";
        if (!clientUuid || !localSessionId || !targetClientUuid || !targetLocalSessionId) {
          writeText(
            res,
            400,
            "client_uuid, local_session_id, target_client_uuid, and target_local_session_id are required",
          );
          return true;
        }

        const output = await this.callBroker(
          "telegramMcp.gatewaySocket.sendDirectPartnerNote",
          {
            clientUuid,
            localSessionId,
            ...(typeof (body as { source_actor_label?: unknown })?.source_actor_label ===
            "string"
              ? {
                  sourceActorLabel: String(
                    (body as { source_actor_label: string }).source_actor_label,
                  ).trim(),
                }
              : {}),
            targetClientUuid,
            targetLocalSessionId,
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
        const result = await this.callBroker(
          "telegramMcp.gatewaySocket.listConnectedClients",
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

    if (pathname === "/gateway/clients/sessions") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.listClientSessions",
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
        const scopeFilterRequested =
          (typeof body.gateway_token === "string" && body.gateway_token.trim().length > 0) ||
          (typeof body.scope_key === "string" && body.scope_key.trim().length > 0);
        const connectedOnly = typeof body.connected_only === "boolean"
          ? body.connected_only
          : false;
        const [registeredResult, connectedResult, scopedClientsResult] = await Promise.all([
          this.callBroker(
            "telegramMcp.gateway.listAllSessions",
            body,
            { meta: { internal_call: true } },
          ) as Promise<{
            sessions?: Array<{
              session_uuid: string;
              client_uuid: string;
              local_session_id: string;
              label: string | null;
              status: string;
              client_label: string | null;
              telegram_username: string | null;
              telegram_display_name: string | null;
              bot_username: string | null;
              project_uuid?: string;
              project_name?: string | null;
            }>;
          }>,
          this.callBroker(
            "telegramMcp.gatewaySocket.listConnectedClients",
            {},
            { meta: { internal_call: true } },
          ) as Promise<{
            clients?: Array<{
              client_uuid: string;
              node_id?: string;
              package_version?: string;
              session_tools?: Array<{
                local_session_id: string;
                session_label?: string;
              }>;
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
        const allowedClientUuids = new Set(
          Array.isArray(scopedClientsResult.clients)
            ? scopedClientsResult.clients
                .map((client) => client.client_uuid)
                .filter((clientUuid): clientUuid is string => typeof clientUuid === "string")
            : [],
        );

        const merged = new Map<
          string,
          {
            session_id: string;
            client_uuid: string;
            local_session_id: string;
            session_label?: string | null;
            client_label?: string | null;
            telegram_username?: string | null;
            telegram_display_name?: string | null;
            bot_username?: string | null;
            node_id?: string;
            package_version?: string;
            project_uuids: string[];
            project_names: string[];
            connected: boolean;
            registered: boolean;
          }
        >();

        for (const session of Array.isArray(registeredResult.sessions)
          ? registeredResult.sessions
          : []) {
          const key = `${session.client_uuid}:${session.local_session_id}`;
          const current = merged.get(key);
          const projectUuids = new Set(current?.project_uuids ?? []);
          const projectNames = new Set(current?.project_names ?? []);
          if (session.project_uuid) {
            projectUuids.add(session.project_uuid);
          }
          if (session.project_name) {
            projectNames.add(session.project_name);
          }
          merged.set(key, {
            session_id: current?.session_id ?? session.session_uuid,
            client_uuid: session.client_uuid,
            local_session_id: session.local_session_id,
            session_label: current?.session_label ?? session.label,
            client_label: current?.client_label ?? session.client_label,
            telegram_username:
              current?.telegram_username ?? session.telegram_username,
            telegram_display_name:
              current?.telegram_display_name ?? session.telegram_display_name,
            bot_username: current?.bot_username ?? session.bot_username,
            ...(current?.node_id ? { node_id: current.node_id } : {}),
            ...(current?.package_version
              ? { package_version: current.package_version }
              : {}),
            project_uuids: Array.from(projectUuids),
            project_names: Array.from(projectNames),
            connected: current?.connected ?? false,
            registered: true,
          });
        }

        for (const client of Array.isArray(connectedResult.clients)
          ? connectedResult.clients
          : []) {
          if (
            scopeFilterRequested &&
            !connectedOnly &&
            !allowedClientUuids.has(client.client_uuid)
          ) {
            continue;
          }
          for (const sessionTool of Array.isArray(client.session_tools)
            ? client.session_tools
            : []) {
            const key = `${client.client_uuid}:${sessionTool.local_session_id}`;
            const current = merged.get(key);
            merged.set(key, {
              session_id:
                current?.session_id ??
                `${client.client_uuid}:${sessionTool.local_session_id}`,
              client_uuid: client.client_uuid,
              local_session_id: sessionTool.local_session_id,
              session_label:
                current?.session_label ?? sessionTool.session_label ?? null,
              ...(current?.client_label
                ? { client_label: current.client_label }
                : {}),
              ...(current?.telegram_username
                ? { telegram_username: current.telegram_username }
                : {}),
              ...(current?.telegram_display_name
                ? { telegram_display_name: current.telegram_display_name }
                : {}),
              ...(current?.bot_username
                ? { bot_username: current.bot_username }
                : {}),
              ...(client.node_id ? { node_id: client.node_id } : {}),
              ...(client.package_version
                ? { package_version: client.package_version }
                : {}),
              project_uuids: current?.project_uuids ?? [],
              project_names: current?.project_names ?? [],
              connected: true,
              registered: current?.registered ?? false,
            });
          }
        }

        const sessions = Array.from(merged.values())
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.joinProject",
          body,
          { meta: { internal_call: true } },
        );
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

    if (pathname === "/gateway/sessions/unregister") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker(
          "telegramMcp.gateway.unregisterSession",
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
