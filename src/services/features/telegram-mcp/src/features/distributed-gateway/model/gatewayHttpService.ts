import type { IncomingMessage, ServerResponse } from "node:http";
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
import type { TelegramWebAppInitDataUnsafe } from "../../../app/webapp/auth";

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

type LiveRelayRequestType = "bootstrap" | "view" | "action";

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
};

type LiveRelayActionResult = {
  ok: true;
};

type LiveRelayQueueItem = {
  requestId: string;
  clientUuid: string;
  localSessionId: string;
  type: LiveRelayRequestType;
  payload: Record<string, unknown>;
  createdAtMs: number;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type LiveRelayPollResponseItem = {
  request_id: string;
  type: LiveRelayRequestType;
  local_session_id: string;
  payload: Record<string, unknown>;
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
  private readonly liveRelayQueue = new Map<string, LiveRelayQueueItem[]>();

  private readonly liveRelayPending = new Map<string, LiveRelayQueueItem>();

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
    initDataRaw: string;
    initDataUnsafe: TelegramWebAppInitDataUnsafe;
  }): Promise<LiveRelayBootstrapResult> {
    const payload = {
      initDataRaw: input.initDataRaw,
      initDataUnsafe: input.initDataUnsafe,
    };
    const rawResponse = await this.requestLiveRelayWithFallback<LiveRelayBootstrapResult>({
      clientUuid: input.clientUuid,
      localSessionId: input.localSessionId,
      type: "bootstrap",
      payload,
    });
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

  public async requestLiveRelayView(input: {
    clientUuid: string;
    localSessionId: string;
  }): Promise<LiveRelayViewResult> {
    const rawResponse = await this.requestLiveRelayWithFallback<LiveRelayViewResult>({
      clientUuid: input.clientUuid,
      localSessionId: input.localSessionId,
      type: "view",
      payload: {},
    });
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
    action: "up" | "down" | "enter" | "slash" | "delete";
  }): Promise<LiveRelayActionResult> {
    const rawResponse = await this.requestLiveRelayWithFallback<LiveRelayActionResult>({
      clientUuid: input.clientUuid,
      localSessionId: input.localSessionId,
      type: "action",
      payload: {
        action: input.action,
      },
    });
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

  private async requestLiveRelayWithFallback<T>(input: {
    clientUuid: string;
    localSessionId: string;
    type: LiveRelayRequestType;
    payload: Record<string, unknown>;
  }): Promise<T> {
    try {
      return await this.callBroker<T>(
        "telegramMcp.gatewaySocket.requestLiveRelay",
        {
          clientUuid: input.clientUuid,
          localSessionId: input.localSessionId,
          requestType: input.type,
          payload: input.payload,
        },
        { meta: { internal_call: true } },
      );
    } catch (error) {
      if (this.config.logging.level === "debug" || this.config.logging.level === "trace") {
        console.debug("Falling back to HTTP live relay queue", {
          clientUuid: input.clientUuid,
          localSessionId: input.localSessionId,
          requestType: input.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return await this.enqueueLiveRelayRequest<T>(input);
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.config.distributed.gatewayAuthToken) {
      return true;
    }

    const authorization = readHeader(req, "authorization");
    return authorization === `Bearer ${this.config.distributed.gatewayAuthToken}`;
  }

  private async enqueueLiveRelayRequest<T>(input: {
    clientUuid: string;
    localSessionId: string;
    type: LiveRelayRequestType;
    payload: Record<string, unknown>;
  }): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        this.liveRelayPending.delete(requestId);
        const queue = this.liveRelayQueue.get(input.clientUuid);
        if (queue) {
          this.liveRelayQueue.set(
            input.clientUuid,
            queue.filter((item) => item.requestId !== requestId),
          );
        }
        reject(new Error("Live relay request timed out"));
      }, 20000);

      const item: LiveRelayQueueItem = {
        requestId,
        clientUuid: input.clientUuid,
        localSessionId: input.localSessionId,
        type: input.type,
        payload: input.payload,
        createdAtMs: Date.now(),
        timeout,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      };

      const queue = this.liveRelayQueue.get(input.clientUuid) ?? [];
      queue.push(item);
      this.liveRelayQueue.set(input.clientUuid, queue);
      this.liveRelayPending.set(requestId, item);
    });
  }

  private dequeueLiveRelayRequests(
    clientUuid: string,
    limit: number,
  ): LiveRelayPollResponseItem[] {
    const queue = this.liveRelayQueue.get(clientUuid) ?? [];
    if (queue.length === 0) {
      return [];
    }

    const count = Math.max(1, Math.min(limit, queue.length));
    const items = queue.splice(0, count);
    if (queue.length > 0) {
      this.liveRelayQueue.set(clientUuid, queue);
    } else {
      this.liveRelayQueue.delete(clientUuid);
    }

    return items.map((item) => ({
      request_id: item.requestId,
      type: item.type,
      local_session_id: item.localSessionId,
      payload: item.payload,
    }));
  }

  private resolveLiveRelayResponses(
    clientUuid: string,
    responses: unknown,
  ): { resolved: number } {
    if (!Array.isArray(responses)) {
      throw new Error("responses must be an array");
    }

    let resolved = 0;

    for (const response of responses) {
      if (!response || typeof response !== "object") {
        continue;
      }

      const requestId =
        typeof (response as { request_id?: unknown }).request_id === "string"
          ? (response as { request_id: string }).request_id
          : null;
      if (!requestId) {
        continue;
      }

      const item = this.liveRelayPending.get(requestId);
      if (!item || item.clientUuid !== clientUuid) {
        continue;
      }

      clearTimeout(item.timeout);
      this.liveRelayPending.delete(requestId);

      const ok =
        typeof (response as { ok?: unknown }).ok === "boolean"
          ? Boolean((response as { ok: boolean }).ok)
          : false;
      if (ok) {
        item.resolve((response as { result?: unknown }).result);
      } else {
        const errorMessage =
          typeof (response as { error?: unknown }).error === "string"
            ? (response as { error: string }).error
            : "Live relay request failed";
        item.reject(new Error(errorMessage));
      }
      resolved += 1;
    }

    return { resolved };
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
        if (
          useQueuedGatewayDelivery &&
          output &&
          typeof output === "object" &&
          typeof (output as { target_client_uuid?: unknown }).target_client_uuid ===
            "string" &&
          (output as { delivery?: unknown }).delivery &&
          typeof (output as { delivery?: unknown }).delivery === "object"
        ) {
          await this.callBroker(
            "telegramMcp.gatewaySocket.notifyDeliveryQueued",
            {
              clientUuid: (output as { target_client_uuid: string }).target_client_uuid,
              delivery: (output as { delivery: Record<string, unknown> }).delivery,
            },
            { meta: { internal_call: true } },
          );
        }
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
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.ackDeliveries",
          body,
          { meta: { internal_call: true } },
        );
        if (Array.isArray(result.deliveries)) {
          for (const status of result.deliveries) {
            if (
              !status ||
              typeof status !== "object" ||
              typeof (status as { source_client_uuid?: unknown }).source_client_uuid !==
                "string"
            ) {
              continue;
            }
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyDeliveryStatus",
              {
                clientUuid: (status as { source_client_uuid: string }).source_client_uuid,
                status,
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

    if (pathname === "/gateway/deliveries/fail") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const result = await this.callBroker<Record<string, unknown>>(
          "telegramMcp.gateway.failDeliveries",
          body,
          { meta: { internal_call: true } },
        );
        if (Array.isArray(result.deliveries)) {
          for (const status of result.deliveries) {
            if (
              !status ||
              typeof status !== "object" ||
              typeof (status as { source_client_uuid?: unknown }).source_client_uuid !==
                "string"
            ) {
              continue;
            }
            await this.callBroker(
              "telegramMcp.gatewaySocket.notifyDeliveryStatus",
              {
                clientUuid: (status as { source_client_uuid: string }).source_client_uuid,
                status,
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

    if (pathname === "/gateway/live/poll") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const clientUuid =
          typeof body.client_uuid === "string" ? body.client_uuid.trim() : "";
        if (!clientUuid) {
          throw new Error("client_uuid is required");
        }

        const limit =
          typeof body.limit === "number" && Number.isFinite(body.limit)
            ? body.limit
            : 10;
        writeJson(res, 200, {
          requests: this.dequeueLiveRelayRequests(clientUuid, limit),
        });
        return true;
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    if (pathname === "/gateway/live/respond") {
      if (req.method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      try {
        const body = (await this.readJsonBody(req)) as Record<string, unknown>;
        const clientUuid =
          typeof body.client_uuid === "string" ? body.client_uuid.trim() : "";
        if (!clientUuid) {
          throw new Error("client_uuid is required");
        }

        writeJson(res, 200, this.resolveLiveRelayResponses(clientUuid, body.responses));
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
