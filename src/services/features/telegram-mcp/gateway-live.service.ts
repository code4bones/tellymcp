import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  type TelegramWebAppInitDataUnsafe,
  validateTelegramWebAppInitData,
} from "./src/app/webapp/auth";
import {
  captureVisibleTmuxPane,
  isTmuxUnavailableError,
  sendAllowedTmuxAction,
} from "./src/app/webapp/tmux";

import CronMixin from "@r2d2bzh/moleculer-cron";

export const TELEGRAM_MCP_GATEWAY_LIVE_SERVICE_NAME = "telegramMcp.gatewayLive";
const TELEGRAM_MCP_GATEWAY_LIVE_TICK_EVENT = "telegramMcp.gatewayLive.tick";

const POLL_CRON_TIME = "* * * * * *";
const GATEWAY_LIVE_POLL_TIMEOUT_MS = 10000;
const GATEWAY_LIVE_RESPOND_TIMEOUT_MS = 10000;

type LiveRelayRequest = {
  request_id: string;
  type: "bootstrap" | "view" | "action";
  local_session_id: string;
  payload?: Record<string, unknown>;
};

type RuntimeCarrier = Service & {
  stopRequested?: boolean;
  pollTickInFlight?: Promise<void> | null;
  pollingEnabled?: boolean;
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  runPollIteration?: () => Promise<void>;
};

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

function formatTmuxRelayError(proxyUrl: string | undefined, error: unknown): string {
  if (isTmuxUnavailableError(error)) {
    return proxyUrl ? "TMUX bridge is unavailable" : "tmux is unavailable";
  }

  return error instanceof Error ? error.message : String(error);
}

async function processBootstrapRequest(
  runtime: ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>,
  request: LiveRelayRequest,
): Promise<{
  session_id: string;
  session_label: string | null;
  tmux_target: boolean;
  poll_interval_ms: number;
  telegram_user_id: number;
}> {
  const payload = request.payload ?? {};
  const initDataRaw =
    typeof payload.initDataRaw === "string" ? payload.initDataRaw : "";
  const initDataUnsafe =
    payload.initDataUnsafe && typeof payload.initDataUnsafe === "object"
      ? (payload.initDataUnsafe as TelegramWebAppInitDataUnsafe)
      : null;

  if (!initDataRaw || !initDataUnsafe) {
    throw new Error("initDataRaw and initDataUnsafe are required");
  }

  const validated = validateTelegramWebAppInitData(
    initDataRaw,
    initDataUnsafe,
    runtime.config.telegram.botToken,
    runtime.config.webapp.initDataTtlSeconds,
  );

  let sessionId = request.local_session_id.trim();
  const launchRecord = runtime.webAppLaunchRegistry.getByUserId(validated.user.id);

  if (!sessionId) {
    sessionId = launchRecord?.sessionId ?? "";
  }

  if (!sessionId) {
    throw new Error(
      "sessionId is missing and no pending Telegram WebApp launch was found",
    );
  }

  const binding = await runtime.bindingStore.getBinding(sessionId);
  if (!binding || binding.telegramUserId !== validated.user.id) {
    throw new Error("This Telegram user is not bound to the requested session.");
  }

  const session = await runtime.sessionStore.getSession(sessionId);
  runtime.webAppLaunchRegistry.deleteByUserId(validated.user.id);

  if (
    launchRecord?.telegramChatId !== undefined &&
    launchRecord?.telegramMessageId !== undefined
  ) {
    void runtime.telegramTransport
      .deleteMessage(
        launchRecord.telegramChatId,
        launchRecord.telegramMessageId,
      )
      .catch((error: unknown) => {
        runtime.logger.warn(
          "Telegram WebApp launcher message deletion failed",
          {
            sessionId,
            telegramUserId: validated.user.id,
            telegramChatId: launchRecord.telegramChatId,
            telegramMessageId: launchRecord.telegramMessageId,
            error:
              error instanceof Error ? (error.stack ?? error.message) : String(error),
          },
        );
      });
  }

  return {
    session_id: sessionId,
    session_label: session?.label ?? null,
    tmux_target: Boolean(session?.tmuxTarget),
    poll_interval_ms: runtime.config.webapp.pollIntervalMs,
    telegram_user_id: validated.user.id,
  };
}

async function processViewRequest(
  runtime: ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>,
  request: LiveRelayRequest,
): Promise<{
  session_id: string;
  session_label: string | null;
  captured_at: string;
  content: string;
}> {
  const sessionId = request.local_session_id.trim();
  const session = await runtime.sessionStore.getSession(sessionId);
  if (!session?.tmuxTarget) {
    throw new Error("tmux target is not configured for this session");
  }

  try {
    const content = await captureVisibleTmuxPane(
      runtime.config.tmux,
      session.tmuxTarget,
      runtime.config.tmux.captureLines,
      runtime.config.webapp.visibleScreens,
    );
    return {
      session_id: session.sessionId,
      session_label: session.label ?? null,
      captured_at: new Date().toISOString(),
      content,
    };
  } catch (error) {
    throw new Error(
      formatTmuxRelayError(runtime.config.tmux.proxyUrl, error),
    );
  }
}

async function processActionRequest(
  runtime: ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>,
  request: LiveRelayRequest,
): Promise<{ ok: true }> {
  const action =
    typeof request.payload?.action === "string" ? request.payload.action : "";
  if (!["up", "down", "enter", "slash", "delete"].includes(action)) {
    throw new Error("Unsupported action");
  }

  const sessionId = request.local_session_id.trim();
  const session = await runtime.sessionStore.getSession(sessionId);
  if (!session?.tmuxTarget) {
    throw new Error("tmux target is not configured for this session");
  }

  try {
    await sendAllowedTmuxAction(
      runtime.config.tmux,
      session.tmuxTarget,
      action as "up" | "down" | "enter" | "slash" | "delete",
    );
    return { ok: true };
  } catch (error) {
    throw new Error(
      formatTmuxRelayError(runtime.config.tmux.proxyUrl, error),
    );
  }
}

const TelegramMcpGatewayLiveService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_LIVE_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],
  mixins: [CronMixin as ServiceSchema],
  crons: [
    {
      name: "GatewayLivePoll",
      cronTime: POLL_CRON_TIME,
      onTick(this: { emit: (eventName: string, payload?: unknown) => void }) {
        this.emit(TELEGRAM_MCP_GATEWAY_LIVE_TICK_EVENT);
      },
    },
  ],

  events: {
    [TELEGRAM_MCP_GATEWAY_LIVE_TICK_EVENT]: {
      async handler(this: RuntimeCarrier) {
        await this.runPollIteration?.();
      },
    },
  },

  methods: {
    getRuntimeOrThrow(this: RuntimeCarrier) {
      const runtimeService =
        this.runtimeService ??
        (this.broker.getLocalService(
          TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
        ) as TelegramMcpRuntimeServiceInstance | null);

      if (!runtimeService) {
        throw new Error(
          `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
        );
      }

      this.runtimeService = runtimeService;
      return runtimeService.getRuntime();
    },

    async runPollIteration(this: RuntimeCarrier): Promise<void> {
      if (this.stopRequested || !this.pollingEnabled) {
        return;
      }

      if (this.pollTickInFlight) {
        return this.pollTickInFlight;
      }

      this.pollTickInFlight = (async () => {
        const runtime = this.getRuntimeOrThrow?.();
        if (!runtime?.config.distributed.gatewayPublicUrl) {
          return;
        }
        if (runtime.config.distributed.gatewayWsUrl) {
          return;
        }

        try {
          const clientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
          if (!clientUuid) {
            return;
          }

          const baseUrl = normalizeGatewayBaseUrl(
            runtime.config.distributed.gatewayPublicUrl,
          );
          const pollUrl = new URL(baseUrl);
          pollUrl.pathname = `${pollUrl.pathname}/live/poll`.replace(
            /\/{2,}/gu,
            "/",
          );

          const response = await fetch(pollUrl, {
            method: "POST",
            signal: AbortSignal.timeout(GATEWAY_LIVE_POLL_TIMEOUT_MS),
            headers: {
              "content-type": "application/json",
              ...(runtime.config.distributed.gatewayAuthToken
                ? {
                    authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}`,
                  }
                : {}),
            },
            body: JSON.stringify({
              client_uuid: clientUuid,
              limit: 20,
            }),
          });

          if (!response.ok) {
            throw new Error(
              `Gateway live poll failed with status ${response.status}: ${await response.text()}`,
            );
          }

          const payload = (await response.json()) as { requests?: LiveRelayRequest[] };
          const requests = Array.isArray(payload.requests) ? payload.requests : [];
          if (requests.length === 0) {
            return;
          }

          const responses: Array<{
            request_id: string;
            ok: boolean;
            result?: unknown;
            error?: string;
          }> = [];

          for (const request of requests) {
            try {
              let result: unknown;
              if (request.type === "bootstrap") {
                result = await processBootstrapRequest(runtime, request);
              } else if (request.type === "view") {
                result = await processViewRequest(runtime, request);
              } else if (request.type === "action") {
                result = await processActionRequest(runtime, request);
              } else {
                throw new Error(`Unsupported live relay request type '${request.type}'`);
              }

              responses.push({
                request_id: request.request_id,
                ok: true,
                result,
              });
            } catch (error) {
              responses.push({
                request_id: request.request_id,
                ok: false,
                error:
                  error instanceof Error ? error.message : String(error),
              });
            }
          }

          const respondUrl = new URL(baseUrl);
          respondUrl.pathname = `${respondUrl.pathname}/live/respond`.replace(
            /\/{2,}/gu,
            "/",
          );
          const respondResponse = await fetch(respondUrl, {
            method: "POST",
            signal: AbortSignal.timeout(GATEWAY_LIVE_RESPOND_TIMEOUT_MS),
            headers: {
              "content-type": "application/json",
              ...(runtime.config.distributed.gatewayAuthToken
                ? {
                    authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}`,
                  }
                : {}),
            },
            body: JSON.stringify({
              client_uuid: clientUuid,
              responses,
            }),
          });

          if (!respondResponse.ok) {
            throw new Error(
              `Gateway live respond failed with status ${respondResponse.status}: ${await respondResponse.text()}`,
            );
          }
        } catch (error) {
          if (!this.stopRequested) {
            runtime.logger.warn("telegram_mcp gateway live poll iteration failed", {
              gatewayUrl: runtime.config.distributed.gatewayPublicUrl,
              error:
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
          }
        }
      })().finally(() => {
        this.pollTickInFlight = null;
      });

      await this.pollTickInFlight;
    },
  },

  created(this: RuntimeCarrier) {
    this.stopRequested = false;
    this.pollTickInFlight = null;
    this.pollingEnabled = false;
    this.runtimeService = null;
  },

  async started(this: RuntimeCarrier) {
    const runtime = this.getRuntimeOrThrow?.();
    this.pollingEnabled = Boolean(
      runtime?.config.distributed.gatewayPublicUrl &&
        !runtime.config.distributed.gatewayWsUrl &&
        (runtime.config.distributed.mode === "client" ||
          runtime.config.distributed.mode === "both"),
    );

    if (!this.pollingEnabled) {
      this.logger.info("telegram_mcp gateway live polling is disabled", {
        mode: runtime?.config.distributed.mode,
        gatewayPublicUrlConfigured: Boolean(
          runtime?.config.distributed.gatewayPublicUrl,
        ),
      });
      return;
    }

    this.logger.info("telegram_mcp gateway live polling started", {
      cronTime: POLL_CRON_TIME,
    });
    await this.runPollIteration?.();
  },

  async stopped(this: RuntimeCarrier) {
    this.stopRequested = true;
    this.pollingEnabled = false;
    await this.pollTickInFlight;
  },
};

export default TelegramMcpGatewayLiveService;
