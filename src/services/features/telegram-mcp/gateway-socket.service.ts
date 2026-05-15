import { randomUUID } from "node:crypto";

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

const wsLib = require("ws") as {
  WebSocket: new (
    url: string,
    options?: Record<string, unknown>,
  ) => any;
  WebSocketServer: new (options: Record<string, unknown>) => any;
};
const WebSocketServer = wsLib.WebSocketServer;

export const TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME =
  "telegramMcp.gatewaySocket";

const CLIENT_RECONNECT_DELAY_MS = 3000;
const LIVE_REQUEST_TIMEOUT_MS = 20000;

type GatewaySocketHello = {
  type: "hello";
  connection_id: string;
  role: "client" | "gateway";
  client_uuid?: string;
  project_name?: string;
  node_id?: string;
};

type GatewaySocketHelloAck = {
  type: "hello_ack";
  connection_id: string;
};

type GatewaySocketLiveRequest = {
  type: "live_request";
  request_id: string;
  request_type: "bootstrap" | "view" | "action";
  local_session_id: string;
  payload: Record<string, unknown>;
};

type GatewaySocketLiveResponse = {
  type: "live_response";
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type GatewaySocketMessage =
  | GatewaySocketHello
  | GatewaySocketHelloAck
  | GatewaySocketLiveRequest
  | GatewaySocketLiveResponse;

type LiveRequestPending = {
  clientUuid: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type GatewaySocketCarrier = Service & {
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  wsServer?: any;
  wsClient?: any;
  wsReconnectTimer?: NodeJS.Timeout | null;
  wsIdentityRefreshTimer?: NodeJS.Timeout | null;
  wsConnectionId?: string | null;
  wsHelloClientUuid?: string | null;
  stopRequested?: boolean;
  connectedClients?: Map<any, GatewaySocketHello>;
  connectedClientsByUuid?: Map<string, any>;
  pendingLiveRequests?: Map<string, LiveRequestPending>;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  startGatewayWsServer?: () => Promise<void>;
  startGatewayWsClient?: () => Promise<void>;
  scheduleGatewayWsReconnect?: () => void;
  closeGatewayWsResources?: () => Promise<void>;
  sendClientHello?: (socket: any) => Promise<void>;
  handleGatewayWsServerMessage?: (
    socket: any,
    raw: unknown,
  ) => Promise<void>;
  handleGatewayWsClientMessage?: (raw: unknown) => Promise<void>;
  processLiveRequest?: (
    request: GatewaySocketLiveRequest,
  ) => Promise<GatewaySocketLiveResponse>;
  requestLiveRelay?: (params: {
    clientUuid: string;
    localSessionId: string;
    requestType: "bootstrap" | "view" | "action";
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
};

function normalizeWebSocketUrl(value: string, defaultPath: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = defaultPath;
  }
  return url.toString();
}

function formatTmuxRelayError(proxyUrl: string | undefined, error: unknown): string {
  if (isTmuxUnavailableError(error)) {
    return proxyUrl ? "TMUX bridge is unavailable" : "tmux is unavailable";
  }

  return error instanceof Error ? error.message : String(error);
}

const TelegramMcpGatewaySocketService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    requestLiveRelay: {
      params: {
        clientUuid: "string",
        localSessionId: "string",
        requestType: {
          type: "enum",
          values: ["bootstrap", "view", "action"],
        },
        payload: { type: "object", optional: true },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            localSessionId: string;
            requestType: "bootstrap" | "view" | "action";
            payload?: Record<string, unknown>;
          };
        },
      ) {
        return await this.requestLiveRelay?.({
          clientUuid: ctx.params.clientUuid,
          localSessionId: ctx.params.localSessionId,
          requestType: ctx.params.requestType,
          payload: ctx.params.payload ?? {},
        });
      },
    },
  },

  created(this: GatewaySocketCarrier) {
    this.runtimeService = null;
    this.wsServer = null;
    this.wsClient = null;
    this.wsReconnectTimer = null;
    this.wsIdentityRefreshTimer = null;
    this.wsConnectionId = null;
    this.wsHelloClientUuid = null;
    this.stopRequested = false;
    this.connectedClients = new Map();
    this.connectedClientsByUuid = new Map();
    this.pendingLiveRequests = new Map();
  },

  methods: {
    getRuntimeOrThrow(this: GatewaySocketCarrier) {
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

    async sendClientHello(this: GatewaySocketCarrier, socket: any): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      if (!runtime || !socket || socket.readyState !== 1) {
        return;
      }

      const clientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
      const hello: GatewaySocketHello = {
        type: "hello",
        connection_id: this.wsConnectionId || randomUUID(),
        role: "client",
        ...(clientUuid ? { client_uuid: clientUuid } : {}),
        ...(runtime.config.project.name
          ? { project_name: runtime.config.project.name }
          : {}),
        ...(this.broker.nodeID ? { node_id: this.broker.nodeID } : {}),
      };
      this.wsHelloClientUuid = clientUuid ?? null;
      socket.send(JSON.stringify(hello));
    },

    async processLiveRequest(
      this: GatewaySocketCarrier,
      request: GatewaySocketLiveRequest,
    ): Promise<GatewaySocketLiveResponse> {
      const runtime = this.getRuntimeOrThrow!();
      try {
        if (request.request_type === "bootstrap") {
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
          const launchRecord =
            runtime.webAppLaunchRegistry.getByUserId(validated.user.id);
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
            throw new Error(
              "This Telegram user is not bound to the requested session.",
            );
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
              .catch(() => undefined);
          }

          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              session_id: sessionId,
              session_label: session?.label ?? null,
              tmux_target: Boolean(session?.tmuxTarget),
              poll_interval_ms: runtime.config.webapp.pollIntervalMs,
              telegram_user_id: validated.user.id,
            },
          };
        }

        if (request.request_type === "view") {
          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.tmuxTarget) {
            throw new Error("tmux target is not configured for this session");
          }

          const content = await captureVisibleTmuxPane(
            runtime.config.tmux,
            session.tmuxTarget,
            runtime.config.tmux.captureLines,
            runtime.config.webapp.visibleScreens,
          );
          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              session_id: session.sessionId,
              session_label: session.label ?? null,
              captured_at: new Date().toISOString(),
              content,
            },
          };
        }

        if (request.request_type === "action") {
          const action =
            typeof request.payload?.action === "string"
              ? request.payload.action
              : "";
          if (!["up", "down", "enter", "slash", "delete"].includes(action)) {
            throw new Error("Unsupported action");
          }

          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.tmuxTarget) {
            throw new Error("tmux target is not configured for this session");
          }

          await sendAllowedTmuxAction(
            runtime.config.tmux,
            session.tmuxTarget,
            action as "up" | "down" | "enter" | "slash" | "delete",
          );
          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              ok: true,
            },
          };
        }

        throw new Error(`Unsupported live request type '${request.request_type}'`);
      } catch (error) {
        return {
          type: "live_response",
          request_id: request.request_id,
          ok: false,
          error: formatTmuxRelayError(runtime?.config.tmux.proxyUrl, error),
        };
      }
    },

    async handleGatewayWsServerMessage(
      this: GatewaySocketCarrier,
      socket: any,
      raw: unknown,
    ): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      const parsed = JSON.parse(String(raw)) as Partial<GatewaySocketMessage>;

      if (parsed.type === "hello") {
        const hello: GatewaySocketHello = {
          type: "hello",
          connection_id:
            typeof parsed.connection_id === "string" && parsed.connection_id.trim()
              ? parsed.connection_id.trim()
              : randomUUID(),
          role: parsed.role === "gateway" ? "gateway" : "client",
          ...(typeof parsed.client_uuid === "string" && parsed.client_uuid.trim()
            ? { client_uuid: parsed.client_uuid.trim() }
            : {}),
          ...(typeof parsed.project_name === "string" && parsed.project_name.trim()
            ? { project_name: parsed.project_name.trim() }
            : {}),
          ...(typeof parsed.node_id === "string" && parsed.node_id.trim()
            ? { node_id: parsed.node_id.trim() }
            : {}),
        };
        const previous = this.connectedClients?.get(socket);
        if (previous?.client_uuid) {
          this.connectedClientsByUuid?.delete(previous.client_uuid);
        }
        this.connectedClients?.set(socket, hello);
        if (hello.client_uuid) {
          this.connectedClientsByUuid?.set(hello.client_uuid, socket);
        }
        runtime.logger.info("Gateway WS hello received", hello);
        socket.send(
          JSON.stringify({
            type: "hello_ack",
            connection_id: hello.connection_id,
          } satisfies GatewaySocketHelloAck),
        );
        return;
      }

      if (parsed.type === "live_response") {
        const requestId =
          typeof parsed.request_id === "string" ? parsed.request_id.trim() : "";
        if (!requestId) {
          return;
        }
        const pending = this.pendingLiveRequests?.get(requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingLiveRequests?.delete(requestId);
        if (parsed.ok === true) {
          pending.resolve(parsed.result);
        } else {
          pending.reject(
            new Error(
              typeof parsed.error === "string" && parsed.error.trim()
                ? parsed.error
                : "Live relay request failed",
            ),
          );
        }
      }
    },

    async handleGatewayWsClientMessage(
      this: GatewaySocketCarrier,
      raw: unknown,
    ): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      const parsed = JSON.parse(String(raw)) as Partial<GatewaySocketMessage>;

      if (parsed.type === "hello_ack") {
        runtime.logger.info("Gateway WS hello acknowledged", {
          connectionId:
            typeof parsed.connection_id === "string" ? parsed.connection_id : null,
          clientUuid: this.wsHelloClientUuid,
        });
        return;
      }

      if (parsed.type === "live_request") {
        const request = parsed as GatewaySocketLiveRequest;
        const response = await this.processLiveRequest?.(request);
        this.wsClient?.send(JSON.stringify(response));
        return;
      }

      runtime.logger.debug("Gateway WS client message received", {
        payload: String(raw),
      });
    },

    async requestLiveRelay(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        localSessionId: string;
        requestType: "bootstrap" | "view" | "action";
        payload: Record<string, unknown>;
      },
    ): Promise<unknown> {
      const runtime = this.getRuntimeOrThrow!();
      const socket = this.connectedClientsByUuid?.get(params.clientUuid);
      if (!socket || socket.readyState !== 1) {
        throw new Error(
          `Gateway WS client '${params.clientUuid}' is not connected`,
        );
      }

      const requestId = randomUUID();
      const response = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingLiveRequests?.delete(requestId);
          reject(new Error("Live relay WS request timed out"));
        }, LIVE_REQUEST_TIMEOUT_MS);

        this.pendingLiveRequests?.set(requestId, {
          clientUuid: params.clientUuid,
          resolve,
          reject,
          timeout,
        });

        const request: GatewaySocketLiveRequest = {
          type: "live_request",
          request_id: requestId,
          request_type: params.requestType,
          local_session_id: params.localSessionId,
          payload: params.payload,
        };
        socket.send(JSON.stringify(request));
      });

      runtime.logger.debug("Gateway WS live relay completed", {
        clientUuid: params.clientUuid,
        localSessionId: params.localSessionId,
        requestType: params.requestType,
      });
      return response;
    },

    async startGatewayWsServer(this: GatewaySocketCarrier): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      if (!runtime || this.wsServer) {
        return;
      }

      const wsServer = new WebSocketServer({
        host: runtime.config.distributed.gatewayWsBindHost,
        port: runtime.config.distributed.gatewayWsBindPort,
        path: runtime.config.distributed.gatewayWsPath,
      });

      wsServer.on("connection", (socket: any, req: any) => {
        if (runtime.config.distributed.gatewayAuthToken) {
          const authorization = req.headers?.authorization;
          if (
            authorization !==
            `Bearer ${runtime.config.distributed.gatewayAuthToken}`
          ) {
            socket.close(1008, "Unauthorized");
            return;
          }
        }

        runtime.logger.info("Gateway WS client connected", {
          remoteAddress: req.socket.remoteAddress,
          path: req.url,
        });

        socket.on("message", (raw: unknown) => {
          void this.handleGatewayWsServerMessage?.(socket, raw).catch((error) => {
            runtime.logger.warn("Gateway WS server message parse failed", {
              error:
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
          });
        });

        socket.on("close", () => {
          const hello = this.connectedClients?.get(socket);
          if (hello?.client_uuid) {
            this.connectedClientsByUuid?.delete(hello.client_uuid);
          }
          this.connectedClients?.delete(socket);
          runtime.logger.info("Gateway WS client disconnected", {
            connectionId: hello?.connection_id ?? null,
            clientUuid: hello?.client_uuid ?? null,
          });
        });
      });

      wsServer.on("listening", () => {
        runtime.logger.info("Gateway WS server started", {
          host: runtime.config.distributed.gatewayWsBindHost,
          port: runtime.config.distributed.gatewayWsBindPort,
          path: runtime.config.distributed.gatewayWsPath,
        });
      });

      this.wsServer = wsServer;
    },

    scheduleGatewayWsReconnect(this: GatewaySocketCarrier): void {
      if (this.stopRequested || this.wsReconnectTimer) {
        return;
      }

      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        void this.startGatewayWsClient?.();
      }, CLIENT_RECONNECT_DELAY_MS);
    },

    async startGatewayWsClient(this: GatewaySocketCarrier): Promise<void> {
      const runtime = this.getRuntimeOrThrow?.();
      if (!runtime || this.wsClient) {
        return;
      }

      const wsUrl = runtime.config.distributed.gatewayWsUrl;
      if (!wsUrl) {
        runtime.logger.info("Gateway WS client is disabled", {
          reason: "GATEWAY_WS_URL is not configured",
        });
        return;
      }

      const normalizedUrl = normalizeWebSocketUrl(
        wsUrl,
        runtime.config.distributed.gatewayWsPath,
      );
      this.wsConnectionId = randomUUID();

      const socket = new wsLib.WebSocket(normalizedUrl, {
        headers: runtime.config.distributed.gatewayAuthToken
          ? {
              authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}`,
            }
          : undefined,
      });

      socket.on("open", () => {
        runtime.logger.info("Gateway WS client connected", {
          url: normalizedUrl,
        });
        void this.sendClientHello?.(socket);
      });

      socket.on("message", (raw: unknown) => {
        void this.handleGatewayWsClientMessage?.(raw).catch((error) => {
          runtime.logger.warn("Gateway WS client message handling failed", {
            error:
              error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        });
      });

      socket.on("error", (error: unknown) => {
        runtime.logger.warn("Gateway WS client error", {
          url: normalizedUrl,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      });

      socket.on("close", () => {
        runtime.logger.info("Gateway WS client disconnected", {
          url: normalizedUrl,
          clientUuid: this.wsHelloClientUuid,
        });
        if (this.wsClient === socket) {
          this.wsClient = null;
        }
        this.scheduleGatewayWsReconnect?.();
      });

      this.wsClient = socket;

      if (!this.wsIdentityRefreshTimer) {
        this.wsIdentityRefreshTimer = setInterval(() => {
          if (this.stopRequested || !this.wsClient || this.wsClient.readyState !== 1) {
            return;
          }

          void (async () => {
            const currentClientUuid =
              await runtime.maintenanceStore.getGatewayClientUuid();
            if ((currentClientUuid ?? null) === this.wsHelloClientUuid) {
              return;
            }

            await this.sendClientHello?.(this.wsClient);
          })().catch((error: unknown) => {
            runtime.logger.warn("Gateway WS hello refresh failed", {
              error:
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
          });
        }, 5000);
      }
    },

    async closeGatewayWsResources(this: GatewaySocketCarrier): Promise<void> {
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }

      if (this.wsIdentityRefreshTimer) {
        clearInterval(this.wsIdentityRefreshTimer);
        this.wsIdentityRefreshTimer = null;
      }

      for (const pending of this.pendingLiveRequests?.values() ?? []) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Gateway WS transport is shutting down"));
      }
      this.pendingLiveRequests?.clear();

      if (this.wsClient) {
        const socket = this.wsClient;
        this.wsClient = null;
        socket.removeAllListeners();
        socket.close();
      }

      if (this.wsServer) {
        const server = this.wsServer;
        this.wsServer = null;
        await new Promise<void>((resolve, reject) => {
          server.close((error: unknown) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  },

  async started(this: GatewaySocketCarrier) {
    const runtime = this.getRuntimeOrThrow?.();
    const mode = runtime?.config.distributed.mode;
    const gatewayEnabled = mode === "gateway" || mode === "both";
    const clientEnabled = mode === "client" || mode === "both";

    if (gatewayEnabled) {
      await this.startGatewayWsServer?.();
    }

    if (clientEnabled) {
      await this.startGatewayWsClient?.();
    }
  },

  async stopped(this: GatewaySocketCarrier) {
    this.stopRequested = true;
    await this.closeGatewayWsResources?.();
  },
};

export default TelegramMcpGatewaySocketService;
