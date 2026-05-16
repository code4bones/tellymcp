import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";

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
import {
  hasLocalTargetSession,
  hasOutgoingDeliveryNotice,
} from "./gateway-loopback";

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
const API_SERVICE_NAME = "api";

const CLIENT_RECONNECT_DELAY_MS = 3000;
const LIVE_REQUEST_TIMEOUT_MS = 20000;
const TOOLS_SYNC_CHECK_INTERVAL_MS = 15000;

type GatewaySocketSessionTools = {
  local_session_id: string;
  session_label?: string;
  tools_hash?: string;
};

type GatewaySocketHello = {
  type: "hello";
  connection_id: string;
  role: "client" | "gateway";
  client_uuid?: string;
  project_name?: string;
  node_id?: string;
  session_tools?: GatewaySocketSessionTools[];
};

type GatewaySocketHelloAck = {
  type: "hello_ack";
  connection_id: string;
};

type GatewaySocketLiveRequest = {
  type: "live_request";
  request_id: string;
  request_type: "bootstrap" | "bootstrap_validate" | "view" | "action";
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

type GatewaySocketProjectEvent = {
  type: "project_event";
  event: "member_joined" | "member_left" | "project_deleted";
  payload: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  };
};

type GatewaySocketDeliveryArtifact = {
  artifact_uuid: string;
  original_name: string;
  mime_type?: string;
  size_bytes?: number;
  storage_ref?: string;
  relative_path?: string;
  content_base64?: string;
};

type GatewaySocketDelivery = {
  delivery_uuid: string;
  message_uuid: string;
  share_id: string;
  project_uuid?: string;
  project_name?: string;
  source_actor_label?: string;
  kind: string;
  summary: string;
  message: string;
  expected_reply?: string;
  requires_reply: boolean;
  in_reply_to?: string;
  source_session_uuid: string;
  source_session_label: string;
  source_local_session_id: string;
  target_session_uuid: string;
  target_local_session_id: string;
  target_session_label: string;
  created_at: string;
  note_relative_path: string;
  share_index_file_name: string;
  artifacts: GatewaySocketDeliveryArtifact[];
};

type GatewaySocketDeliveryEvent = {
  type: "delivery_event";
  event: "incoming_delivery";
  payload: GatewaySocketDelivery;
};

type GatewaySocketDeliveryStatus = {
  delivery_uuid: string;
  share_id: string;
  status: string;
  delivered_at?: string;
  acked_at?: string;
};

type GatewaySocketDeliveryStatusEvent = {
  type: "delivery_status_event";
  payload: GatewaySocketDeliveryStatus;
};

type GatewaySocketLiveApprovalPayload = {
  project_uuid?: string;
  project_name?: string;
  source_session_id: string;
  source_session_label: string;
  source_client_uuid: string;
  source_local_session_id: string;
  target_session_id: string;
  target_session_label: string;
  target_client_uuid: string;
  target_local_session_id: string;
};

type GatewaySocketLiveEvent = {
  type: "live_event";
  event: "approval_request" | "approval_granted" | "approval_denied";
  payload: GatewaySocketLiveApprovalPayload;
};

type GatewaySocketToolsEventPayload = {
  local_session_id: string;
  session_label?: string;
  client_tools_hash?: string;
  gateway_tools_hash: string;
  reason: "missing" | "outdated";
  instruction: string;
};

type GatewaySocketToolsEvent = {
  type: "tools_event";
  payload: GatewaySocketToolsEventPayload;
};

type GatewaySocketDeliveryAck = {
  type: "delivery_ack";
  delivery_ids: string[];
};

type GatewaySocketDeliveryFail = {
  type: "delivery_fail";
  delivery_ids: string[];
  error_text?: string;
};

type GatewaySocketMessage =
  | GatewaySocketHello
  | GatewaySocketHelloAck
  | GatewaySocketLiveRequest
  | GatewaySocketLiveResponse
  | GatewaySocketLiveEvent
  | GatewaySocketToolsEvent
  | GatewaySocketProjectEvent
  | GatewaySocketDeliveryEvent
  | GatewaySocketDeliveryStatusEvent
  | GatewaySocketDeliveryAck
  | GatewaySocketDeliveryFail;

type LiveRequestPending = {
  clientUuid: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ApiServiceCarrier = Service & {
  server?: HttpServer;
};

type GatewaySocketCarrier = Service & {
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  apiService?: ApiServiceCarrier | null;
  wsServer?: any;
  wsClient?: any;
  wsReconnectTimer?: NodeJS.Timeout | null;
  wsIdentityRefreshTimer?: NodeJS.Timeout | null;
  wsToolsSyncTimer?: NodeJS.Timeout | null;
  wsConnectionId?: string | null;
  wsHelloClientUuid?: string | null;
  wsHelloSessionToolsSnapshot?: string | null;
  wsClientHasConnectedOnce?: boolean;
  wsUpgradeHandler?:
    | ((req: IncomingMessage, socket: Socket, head: Buffer) => void)
    | null;
  stopRequested?: boolean;
  connectedClients?: Map<any, GatewaySocketHello>;
  connectedClientsByUuid?: Map<string, any>;
  connectedClientToolsAlerts?: Map<any, Map<string, string>>;
  pendingLiveRequests?: Map<string, LiveRequestPending>;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  getApiServerOrThrow?: () => HttpServer;
  startGatewayWsServer?: () => Promise<void>;
  startGatewayWsClient?: () => Promise<void>;
  scheduleGatewayWsReconnect?: () => void;
  closeGatewayWsResources?: () => Promise<void>;
  collectSessionTools?: () => Promise<{
    sessionTools: GatewaySocketSessionTools[];
    snapshot: string;
  }>;
  getGatewayToolsHash?: () => string | null;
  notifyToolsMismatchForSocket?: (
    socket: any,
    hello: GatewaySocketHello,
  ) => Promise<number>;
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
    requestType: "bootstrap" | "bootstrap_validate" | "view" | "action";
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  notifyProjectMemberJoined?: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
    memberDisplayName?: string;
    memberTelegramUsername?: string;
  }) => Promise<number>;
  notifyProjectMemberLeft?: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
    memberDisplayName?: string;
    memberTelegramUsername?: string;
  }) => Promise<number>;
  notifyProjectDeleted?: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
  }) => Promise<number>;
  notifyLiveApprovalRequest?: (params: {
    clientUuid: string;
    payload: GatewaySocketLiveApprovalPayload;
  }) => Promise<boolean>;
  notifyLiveApprovalResolved?: (params: {
    clientUuid: string;
    approved: boolean;
    payload: GatewaySocketLiveApprovalPayload;
  }) => Promise<boolean>;
  isLocalGatewayClientUuid?: (clientUuid: string) => Promise<boolean>;
  handleLocalIncomingDelivery?: (params: {
    clientUuid: string;
    delivery: GatewaySocketDelivery;
  }) => Promise<boolean>;
  handleLocalDeliveryStatus?: (params: {
    clientUuid: string;
    status: GatewaySocketDeliveryStatus;
  }) => Promise<boolean>;
  notifyDeliveryQueued?: (params: {
    clientUuid: string;
    delivery: GatewaySocketDelivery;
  }) => Promise<boolean>;
  notifyDeliveryStatus?: (params: {
    clientUuid: string;
    status: GatewaySocketDeliveryStatus;
  }) => Promise<boolean>;
};

function normalizeWebSocketUrl(value: string, defaultPath: string): string {
  const url = new URL(value);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
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

function computeToolsHashForDir(workspaceDir: string): string | null {
  const toolsPath = join(resolve(workspaceDir), "TOOLS.md");
  if (!existsSync(toolsPath)) {
    return null;
  }

  const content = readFileSync(toolsPath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

const TelegramMcpGatewaySocketService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME, API_SERVICE_NAME],

  actions: {
    requestLiveRelay: {
      params: {
        clientUuid: "string",
        localSessionId: "string",
        requestType: {
          type: "enum",
          values: ["bootstrap", "bootstrap_validate", "view", "action"],
        },
        payload: { type: "object", optional: true },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            localSessionId: string;
            requestType: "bootstrap" | "bootstrap_validate" | "view" | "action";
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
    notifyProjectMemberJoined: {
      params: {
        clientUuids: { type: "array", items: "string" },
        projectUuid: "string",
        projectName: "string",
        memberDisplayName: { type: "string", optional: true },
        memberTelegramUsername: { type: "string", optional: true },
      },
      async handler(this: GatewaySocketCarrier, ctx: { params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
        memberDisplayName?: string;
        memberTelegramUsername?: string;
      }}) {
        return await this.notifyProjectMemberJoined?.(ctx.params);
      },
    },
    notifyProjectMemberLeft: {
      params: {
        clientUuids: { type: "array", items: "string" },
        projectUuid: "string",
        projectName: "string",
        memberDisplayName: { type: "string", optional: true },
        memberTelegramUsername: { type: "string", optional: true },
      },
      async handler(this: GatewaySocketCarrier, ctx: { params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
        memberDisplayName?: string;
        memberTelegramUsername?: string;
      }}) {
        return await this.notifyProjectMemberLeft?.(ctx.params);
      },
    },
    notifyProjectDeleted: {
      params: {
        clientUuids: { type: "array", items: "string" },
        projectUuid: "string",
        projectName: "string",
      },
      async handler(this: GatewaySocketCarrier, ctx: { params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
      }}) {
        return await this.notifyProjectDeleted?.(ctx.params);
      },
    },
    notifyLiveApprovalRequest: {
      params: {
        clientUuid: "string",
        payload: { type: "object" },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            payload: GatewaySocketLiveApprovalPayload;
          };
        },
      ) {
        return {
          delivered: await this.notifyLiveApprovalRequest?.(ctx.params),
        };
      },
    },
    notifyLiveApprovalResolved: {
      params: {
        clientUuid: "string",
        approved: "boolean",
        payload: { type: "object" },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            approved: boolean;
            payload: GatewaySocketLiveApprovalPayload;
          };
        },
      ) {
        return {
          delivered: await this.notifyLiveApprovalResolved?.(ctx.params),
        };
      },
    },
    notifyDeliveryQueued: {
      params: {
        clientUuid: "string",
        delivery: { type: "object" },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: { params: { clientUuid: string; delivery: GatewaySocketDelivery } },
      ) {
        return await this.notifyDeliveryQueued?.(ctx.params);
      },
    },
    notifyDeliveryStatus: {
      params: {
        clientUuid: "string",
        status: { type: "object" },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: { params: { clientUuid: string; status: GatewaySocketDeliveryStatus } },
      ) {
        return await this.notifyDeliveryStatus?.(ctx.params);
      },
    },
  },

  created(this: GatewaySocketCarrier) {
    this.runtimeService = null;
    this.apiService = null;
    this.wsServer = null;
    this.wsClient = null;
    this.wsReconnectTimer = null;
    this.wsIdentityRefreshTimer = null;
    this.wsToolsSyncTimer = null;
    this.wsConnectionId = null;
    this.wsHelloClientUuid = null;
    this.wsHelloSessionToolsSnapshot = null;
    this.wsClientHasConnectedOnce = false;
    this.wsUpgradeHandler = null;
    this.stopRequested = false;
    this.connectedClients = new Map();
    this.connectedClientsByUuid = new Map();
    this.connectedClientToolsAlerts = new Map();
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

    getApiServerOrThrow(this: GatewaySocketCarrier): HttpServer {
      const apiService =
        this.apiService ??
        (this.broker.getLocalService(API_SERVICE_NAME) as ApiServiceCarrier | null);

      if (!apiService?.server) {
        throw new Error(
          `Local Moleculer service '${API_SERVICE_NAME}' HTTP server is unavailable`,
        );
      }

      this.apiService = apiService;
      return apiService.server;
    },

    async collectSessionTools(this: GatewaySocketCarrier): Promise<{
      sessionTools: GatewaySocketSessionTools[];
      snapshot: string;
    }> {
      const runtime = this.getRuntimeOrThrow!();
      const sessions = await runtime.sessionStore.listSessions();
      const sessionTools = sessions
        .map((session) => {
          const toolsHash = session.cwd
            ? computeToolsHashForDir(session.cwd)
            : null;
          return {
            local_session_id: session.sessionId,
            ...(session.label ? { session_label: session.label } : {}),
            ...(toolsHash ? { tools_hash: toolsHash } : {}),
          } satisfies GatewaySocketSessionTools;
        })
        .sort((left, right) =>
          left.local_session_id.localeCompare(right.local_session_id),
        );

      return {
        sessionTools,
        snapshot: JSON.stringify(sessionTools),
      };
    },

    getGatewayToolsHash(this: GatewaySocketCarrier): string | null {
      return computeToolsHashForDir(process.cwd());
    },

    async notifyToolsMismatchForSocket(
      this: GatewaySocketCarrier,
      socket: any,
      hello: GatewaySocketHello,
    ): Promise<number> {
      const gatewayToolsHash = this.getGatewayToolsHash?.();
      if (!gatewayToolsHash || !socket || socket.readyState !== 1) {
        return 0;
      }

      const sessionTools = Array.isArray(hello.session_tools)
        ? hello.session_tools
        : [];
      if (sessionTools.length === 0) {
        return 0;
      }

      const alerted =
        this.connectedClientToolsAlerts?.get(socket) ?? new Map<string, string>();
      this.connectedClientToolsAlerts?.set(socket, alerted);

      let delivered = 0;
      for (const sessionTool of sessionTools) {
        const clientToolsHash =
          typeof sessionTool.tools_hash === "string" && sessionTool.tools_hash.trim()
            ? sessionTool.tools_hash.trim()
            : null;
        if (clientToolsHash === gatewayToolsHash) {
          alerted.delete(sessionTool.local_session_id);
          continue;
        }

        if (alerted.get(sessionTool.local_session_id) === gatewayToolsHash) {
          continue;
        }

        socket.send(
          JSON.stringify({
            type: "tools_event",
            payload: {
              local_session_id: sessionTool.local_session_id,
              ...(sessionTool.session_label
                ? { session_label: sessionTool.session_label }
                : {}),
              ...(clientToolsHash ? { client_tools_hash: clientToolsHash } : {}),
              gateway_tools_hash: gatewayToolsHash,
              reason: clientToolsHash ? "outdated" : "missing",
              instruction:
                "Call refresh_tools_markdown for this session, then re-read the local TOOLS.md and apply it before continuing.",
            },
          } satisfies GatewaySocketToolsEvent),
        );
        alerted.set(sessionTool.local_session_id, gatewayToolsHash);
        delivered += 1;
      }

      return delivered;
    },

    async sendClientHello(this: GatewaySocketCarrier, socket: any): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      if (!runtime || !socket || socket.readyState !== 1) {
        return;
      }

      const clientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
      const { sessionTools, snapshot } = await this.collectSessionTools?.() ?? {
        sessionTools: [],
        snapshot: "[]",
      };
      const hello: GatewaySocketHello = {
        type: "hello",
        connection_id: this.wsConnectionId || randomUUID(),
        role: "client",
        ...(clientUuid ? { client_uuid: clientUuid } : {}),
        ...(runtime.config.project.name
          ? { project_name: runtime.config.project.name }
          : {}),
        ...(this.broker.nodeID ? { node_id: this.broker.nodeID } : {}),
        ...(sessionTools.length > 0 ? { session_tools: sessionTools } : {}),
      };
      this.wsHelloClientUuid = clientUuid ?? null;
      this.wsHelloSessionToolsSnapshot = snapshot;
      socket.send(JSON.stringify(hello));
    },

    async isLocalGatewayClientUuid(
      this: GatewaySocketCarrier,
      clientUuid: string,
    ): Promise<boolean> {
      const runtime = this.getRuntimeOrThrow!();
      const localClientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
      return Boolean(localClientUuid && localClientUuid === clientUuid);
    },

    async handleLocalIncomingDelivery(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        delivery: GatewaySocketDelivery;
      },
    ): Promise<boolean> {
      const runtime = this.getRuntimeOrThrow!();
      const localTargetSession = await runtime.sessionStore.getSession(
        params.delivery.target_local_session_id,
      );
      if (!hasLocalTargetSession(localTargetSession)) {
        return false;
      }

      try {
        await this.broker.call(
          "telegramMcp.gatewayDelivery.materializeIncomingDelivery",
          {
            delivery: params.delivery,
          },
          { meta: { internal_call: true } },
        );
      } catch (error) {
        const result = await (this.broker.call as any)(
          "telegramMcp.gateway.failDeliveries",
          {
            client_uuid: params.clientUuid,
            delivery_ids: [params.delivery.delivery_uuid],
            error_text: error instanceof Error ? error.message : String(error),
          },
          { meta: { internal_call: true } },
        ) as {
          deliveries?: Array<GatewaySocketDeliveryStatus & { source_client_uuid?: string }>;
        };

        for (const status of Array.isArray(result.deliveries)
          ? result.deliveries
          : []) {
          if (!status.source_client_uuid) {
            continue;
          }
          const published = await this.notifyDeliveryStatus?.({
            clientUuid: status.source_client_uuid,
            status,
          });
          if (!published && (await this.isLocalGatewayClientUuid?.(status.source_client_uuid))) {
            await this.handleLocalDeliveryStatus?.({
              clientUuid: status.source_client_uuid,
              status,
            });
          }
        }
        throw error;
      }

      const result = await (this.broker.call as any)(
        "telegramMcp.gateway.ackDeliveries",
        {
          client_uuid: params.clientUuid,
          delivery_ids: [params.delivery.delivery_uuid],
        },
        { meta: { internal_call: true } },
      ) as {
        deliveries?: Array<GatewaySocketDeliveryStatus & { source_client_uuid?: string }>;
      };

      for (const status of Array.isArray(result.deliveries)
        ? result.deliveries
        : []) {
        if (!status.source_client_uuid) {
          continue;
        }
        const published = await this.notifyDeliveryStatus?.({
          clientUuid: status.source_client_uuid,
          status,
        });
        if (!published && (await this.isLocalGatewayClientUuid?.(status.source_client_uuid))) {
          await this.handleLocalDeliveryStatus?.({
            clientUuid: status.source_client_uuid,
            status,
          });
        }
      }

      return true;
    },

    async handleLocalDeliveryStatus(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        status: GatewaySocketDeliveryStatus;
      },
    ): Promise<boolean> {
      const runtime = this.getRuntimeOrThrow!();
      const notices = await runtime.maintenanceStore.listOutgoingDeliveryNotices();
      if (!hasOutgoingDeliveryNotice(notices, params.status.delivery_uuid)) {
        return false;
      }

      await this.broker.call(
        "telegramMcp.gatewayDelivery.applyOutgoingDeliveryStatus",
        {
          status: params.status,
        },
        { meta: { internal_call: true } },
      );
      return true;
    },

    async processLiveRequest(
      this: GatewaySocketCarrier,
      request: GatewaySocketLiveRequest,
    ): Promise<GatewaySocketLiveResponse> {
      const runtime = this.getRuntimeOrThrow!();
      try {
        if (request.request_type === "bootstrap_validate") {
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
          const launchRecord =
            runtime.webAppLaunchRegistry.getByUserId(validated.user.id);
          if (!launchRecord) {
            throw new Error("No pending Telegram WebApp launch was found");
          }
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
              telegram_user_id: validated.user.id,
            },
          };
        }

        if (request.request_type === "bootstrap") {
          const payload = request.payload ?? {};
          const allowForeignBinding = payload.allowForeignBinding === true;
          const trustedTelegramUserId =
            typeof payload.telegramUserId === "number"
              ? payload.telegramUserId
              : typeof payload.telegramUserId === "string" &&
                  payload.telegramUserId.trim()
                ? Number(payload.telegramUserId)
                : null;

          let telegramUserId = trustedTelegramUserId;
          if (
            telegramUserId !== null &&
            (!Number.isFinite(telegramUserId) || telegramUserId <= 0)
          ) {
            telegramUserId = null;
          }

          if (telegramUserId === null) {
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
            telegramUserId = validated.user.id;
          }

          const sessionId = request.local_session_id.trim();
          if (!sessionId) {
            throw new Error("sessionId is missing for relay bootstrap");
          }

          const binding = await runtime.bindingStore.getBinding(sessionId);
          if (
            !allowForeignBinding &&
            (!binding || binding.telegramUserId !== telegramUserId)
          ) {
            throw new Error(
              "This Telegram user is not bound to the requested session.",
            );
          }

          const session = await runtime.sessionStore.getSession(sessionId);

          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              session_id: sessionId,
              session_label: session?.label ?? null,
              tmux_target: Boolean(session?.tmuxTarget),
              poll_interval_ms: runtime.config.webapp.pollIntervalMs,
              telegram_user_id: telegramUserId,
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
          ...(Array.isArray(parsed.session_tools)
            ? {
                session_tools: parsed.session_tools
                  .map((item) =>
                    item && typeof item === "object"
                      ? {
                          local_session_id:
                            typeof (item as { local_session_id?: unknown }).local_session_id ===
                              "string" &&
                            (item as { local_session_id: string }).local_session_id.trim()
                              ? (item as { local_session_id: string }).local_session_id.trim()
                              : null,
                          ...(typeof (item as { session_label?: unknown }).session_label ===
                            "string" &&
                          (item as { session_label: string }).session_label.trim()
                            ? {
                                session_label: (
                                  item as { session_label: string }
                                ).session_label.trim(),
                              }
                            : {}),
                          ...(typeof (item as { tools_hash?: unknown }).tools_hash ===
                            "string" &&
                          (item as { tools_hash: string }).tools_hash.trim()
                            ? {
                                tools_hash: (
                                  item as { tools_hash: string }
                                ).tools_hash.trim(),
                              }
                            : {}),
                        }
                      : null,
                  )
                  .filter(
                    (item): item is GatewaySocketSessionTools =>
                      Boolean(item?.local_session_id),
                  ),
              }
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
        await this.notifyToolsMismatchForSocket?.(socket, hello);
        if (hello.client_uuid) {
          const queued = await (this.broker.call as any)(
            "telegramMcp.gateway.pollDeliveries",
            {
              client_uuid: hello.client_uuid,
              limit: 50,
            },
            { meta: { internal_call: true } },
          ) as { deliveries?: GatewaySocketDelivery[] };
          for (const delivery of Array.isArray(queued.deliveries)
            ? queued.deliveries
            : []) {
            socket.send(
              JSON.stringify({
                type: "delivery_event",
                event: "incoming_delivery",
                payload: delivery,
              } satisfies GatewaySocketDeliveryEvent),
            );
          }

          const statuses = await (this.broker.call as any)(
            "telegramMcp.gateway.listSenderDeliveryStatuses",
            {
              client_uuid: hello.client_uuid,
              limit: 100,
            },
            { meta: { internal_call: true } },
          ) as { deliveries?: GatewaySocketDeliveryStatus[] };
          for (const status of Array.isArray(statuses.deliveries)
            ? statuses.deliveries
            : []) {
            socket.send(
              JSON.stringify({
                type: "delivery_status_event",
                payload: status,
              } satisfies GatewaySocketDeliveryStatusEvent),
            );
          }
        }
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
        return;
      }

      if (parsed.type === "delivery_ack" || parsed.type === "delivery_fail") {
        const hello = this.connectedClients?.get(socket);
        const clientUuid = hello?.client_uuid?.trim();
        if (!clientUuid) {
          throw new Error("Gateway WS delivery update requires hello client_uuid");
        }

        const deliveryIds = Array.isArray(parsed.delivery_ids)
          ? parsed.delivery_ids
              .map((item) =>
                typeof item === "string" && item.trim() ? item.trim() : null,
              )
              .filter((item): item is string => Boolean(item))
          : [];
        if (deliveryIds.length === 0) {
          return;
        }

        const result = await (this.broker.call as any)(
          parsed.type === "delivery_ack"
            ? "telegramMcp.gateway.ackDeliveries"
            : "telegramMcp.gateway.failDeliveries",
          {
            client_uuid: clientUuid,
            delivery_ids: deliveryIds,
            ...(parsed.type === "delivery_fail" &&
            typeof parsed.error_text === "string" &&
            parsed.error_text.trim()
              ? { error_text: parsed.error_text.trim() }
              : {}),
          },
          { meta: { internal_call: true } },
        ) as {
          deliveries?: Array<GatewaySocketDeliveryStatus & { source_client_uuid?: string }>;
        };

        for (const status of Array.isArray(result.deliveries)
          ? result.deliveries
          : []) {
          if (!status.source_client_uuid) {
            continue;
          }
          const publishResult = await (this.broker.call as any)(
            "telegramMcp.gatewayRmq.publishDeliveryStatus",
            {
              clientUuid: status.source_client_uuid,
              status,
            },
            { meta: { internal_call: true } },
          ) as { published?: boolean };

          if (!publishResult?.published) {
            await this.notifyDeliveryStatus?.({
              clientUuid: status.source_client_uuid,
              status,
            });
          }
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

      if (parsed.type === "tools_event" && parsed.payload) {
        await runtime.telegramTransport.handleToolsUpdatedEvent(
          parsed.payload as GatewaySocketToolsEventPayload,
        );
        return;
      }

      if (parsed.type === "project_event") {
        if (
          parsed.event === "member_joined" &&
          parsed.payload &&
          typeof parsed.payload === "object"
        ) {
          await runtime.telegramTransport.handleProjectMemberJoinedEvent(
            parsed.payload as {
              project_uuid: string;
              project_name: string;
              member_display_name?: string;
              member_telegram_username?: string;
            },
          );
          return;
        }
        if (
          parsed.event === "member_left" &&
          parsed.payload &&
          typeof parsed.payload === "object"
        ) {
          await runtime.telegramTransport.handleProjectMemberLeftEvent(
            parsed.payload as {
              project_uuid: string;
              project_name: string;
              member_display_name?: string;
              member_telegram_username?: string;
            },
          );
          return;
        }
        if (
          parsed.event === "project_deleted" &&
          parsed.payload &&
          typeof parsed.payload === "object"
        ) {
          await runtime.telegramTransport.handleProjectDeletedEvent(
            parsed.payload as {
              project_uuid: string;
              project_name: string;
            },
          );
          return;
        }
      }

      if (parsed.type === "live_event" && parsed.payload) {
        if (parsed.event === "approval_request") {
          await runtime.telegramTransport.handleLiveViewApprovalRequestEvent(
            parsed.payload as GatewaySocketLiveApprovalPayload,
          );
          return;
        }
        if (
          parsed.event === "approval_granted" ||
          parsed.event === "approval_denied"
        ) {
          await runtime.telegramTransport.handleLiveViewApprovalResolvedEvent({
            approved: parsed.event === "approval_granted",
            ...(parsed.payload as GatewaySocketLiveApprovalPayload),
          });
          return;
        }
      }

      if (parsed.type === "delivery_event") {
        const delivery = parsed.payload;
        if (!delivery) {
          return;
        }
        try {
          await this.broker.call(
            "telegramMcp.gatewayDelivery.materializeIncomingDelivery",
            {
              delivery,
            },
            { meta: { internal_call: true } },
          );

          this.wsClient?.send(
            JSON.stringify({
              type: "delivery_ack",
              delivery_ids: [delivery.delivery_uuid],
            } satisfies GatewaySocketDeliveryAck),
          );
        } catch (error) {
          this.wsClient?.send(
            JSON.stringify({
              type: "delivery_fail",
              delivery_ids: [delivery.delivery_uuid],
              error_text:
                error instanceof Error ? error.message : String(error),
            } satisfies GatewaySocketDeliveryFail),
          );
          throw error;
        }
        return;
      }

      if (parsed.type === "delivery_status_event") {
        await this.broker.call(
          "telegramMcp.gatewayDelivery.applyOutgoingDeliveryStatus",
          {
            status: parsed.payload,
          },
          { meta: { internal_call: true } },
        );
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
        requestType: "bootstrap" | "bootstrap_validate" | "view" | "action";
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

    async notifyProjectMemberJoined(
      this: GatewaySocketCarrier,
      params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
        memberDisplayName?: string;
        memberTelegramUsername?: string;
      },
    ): Promise<number> {
      const message: GatewaySocketProjectEvent = {
        type: "project_event",
        event: "member_joined",
        payload: {
          project_uuid: params.projectUuid,
          project_name: params.projectName,
          ...(params.memberDisplayName
            ? { member_display_name: params.memberDisplayName }
            : {}),
          ...(params.memberTelegramUsername
            ? { member_telegram_username: params.memberTelegramUsername }
            : {}),
        },
      };
      let delivered = 0;
      for (const clientUuid of params.clientUuids) {
        if (await this.isLocalGatewayClientUuid?.(clientUuid)) {
          const runtime = this.getRuntimeOrThrow!();
          await runtime.telegramTransport.handleProjectMemberJoinedEvent(
            message.payload,
          );
          delivered += 1;
          continue;
        }
        const socket = this.connectedClientsByUuid?.get(clientUuid);
        if (!socket || socket.readyState !== 1) {
          continue;
        }
        socket.send(JSON.stringify(message));
        delivered += 1;
      }
      return delivered;
    },

    async notifyProjectMemberLeft(
      this: GatewaySocketCarrier,
      params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
        memberDisplayName?: string;
        memberTelegramUsername?: string;
      },
    ): Promise<number> {
      const message: GatewaySocketProjectEvent = {
        type: "project_event",
        event: "member_left",
        payload: {
          project_uuid: params.projectUuid,
          project_name: params.projectName,
          ...(params.memberDisplayName
            ? { member_display_name: params.memberDisplayName }
            : {}),
          ...(params.memberTelegramUsername
            ? { member_telegram_username: params.memberTelegramUsername }
            : {}),
        },
      };

      let delivered = 0;
      for (const clientUuid of params.clientUuids) {
        if (await this.isLocalGatewayClientUuid?.(clientUuid)) {
          const runtime = this.getRuntimeOrThrow!();
          await runtime.telegramTransport.handleProjectMemberLeftEvent(
            message.payload,
          );
          delivered += 1;
          continue;
        }
        const socket = this.connectedClientsByUuid?.get(clientUuid);
        if (!socket || socket.readyState !== 1) {
          continue;
        }
        socket.send(JSON.stringify(message));
        delivered += 1;
      }

      return delivered;
    },

    async notifyProjectDeleted(
      this: GatewaySocketCarrier,
      params: {
        clientUuids: string[];
        projectUuid: string;
        projectName: string;
      },
    ): Promise<number> {
      const message: GatewaySocketProjectEvent = {
        type: "project_event",
        event: "project_deleted",
        payload: {
          project_uuid: params.projectUuid,
          project_name: params.projectName,
        },
      };

      let delivered = 0;
      for (const clientUuid of params.clientUuids) {
        if (await this.isLocalGatewayClientUuid?.(clientUuid)) {
          const runtime = this.getRuntimeOrThrow!();
          await runtime.telegramTransport.handleProjectDeletedEvent(
            message.payload,
          );
          delivered += 1;
          continue;
        }
        const socket = this.connectedClientsByUuid?.get(clientUuid);
        if (!socket || socket.readyState !== 1) {
          continue;
        }
        socket.send(JSON.stringify(message));
        delivered += 1;
      }

      return delivered;
    },

    async notifyLiveApprovalRequest(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        payload: GatewaySocketLiveApprovalPayload;
      },
    ): Promise<boolean> {
      if (await this.isLocalGatewayClientUuid?.(params.clientUuid)) {
        const runtime = this.getRuntimeOrThrow!();
        await runtime.telegramTransport.handleLiveViewApprovalRequestEvent(
          params.payload,
        );
        return true;
      }

      const socket = this.connectedClientsByUuid?.get(params.clientUuid);
      if (!socket || socket.readyState !== 1) {
        return false;
      }

      socket.send(
        JSON.stringify({
          type: "live_event",
          event: "approval_request",
          payload: params.payload,
        } satisfies GatewaySocketLiveEvent),
      );
      return true;
    },

    async notifyLiveApprovalResolved(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        approved: boolean;
        payload: GatewaySocketLiveApprovalPayload;
      },
    ): Promise<boolean> {
      if (await this.isLocalGatewayClientUuid?.(params.clientUuid)) {
        const runtime = this.getRuntimeOrThrow!();
        await runtime.telegramTransport.handleLiveViewApprovalResolvedEvent({
          approved: params.approved,
          ...params.payload,
        });
        return true;
      }

      const socket = this.connectedClientsByUuid?.get(params.clientUuid);
      if (!socket || socket.readyState !== 1) {
        return false;
      }

      socket.send(
        JSON.stringify({
          type: "live_event",
          event: params.approved ? "approval_granted" : "approval_denied",
          payload: params.payload,
        } satisfies GatewaySocketLiveEvent),
      );
      return true;
    },

    async notifyDeliveryQueued(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        delivery: GatewaySocketDelivery;
      },
    ): Promise<boolean> {
      if (await this.handleLocalIncomingDelivery?.(params)) {
        return true;
      }

      const socket = this.connectedClientsByUuid?.get(params.clientUuid);
      if (!socket || socket.readyState !== 1) {
        return false;
      }

      socket.send(
        JSON.stringify({
          type: "delivery_event",
          event: "incoming_delivery",
          payload: params.delivery,
        } satisfies GatewaySocketDeliveryEvent),
      );
      return true;
    },

    async notifyDeliveryStatus(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        status: GatewaySocketDeliveryStatus;
      },
    ): Promise<boolean> {
      if (await this.handleLocalDeliveryStatus?.(params)) {
        return true;
      }

      const socket = this.connectedClientsByUuid?.get(params.clientUuid);
      if (!socket || socket.readyState !== 1) {
        return false;
      }

      socket.send(
        JSON.stringify({
          type: "delivery_status_event",
          payload: params.status,
        } satisfies GatewaySocketDeliveryStatusEvent),
      );
      return true;
    },

    async startGatewayWsServer(this: GatewaySocketCarrier): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      if (!runtime || this.wsServer) {
        return;
      }

      const httpServer = this.getApiServerOrThrow?.();
      const wsPath =
        runtime.config.distributed.gatewayWsPath.replace(/\/+$/u, "") || "/";
      const wsServer = new WebSocketServer({ noServer: true });

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

        runtime.logger.warn("Gateway WS client connected", {
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
          this.connectedClientToolsAlerts?.delete(socket);
          this.connectedClients?.delete(socket);
          runtime.logger.warn("Gateway WS client disconnected", {
            connectionId: hello?.connection_id ?? null,
            clientUuid: hello?.client_uuid ?? null,
          });
        });
      });

      const upgradeHandler = (
        req: IncomingMessage,
        socket: Socket,
        head: Buffer,
      ) => {
        const requestUrl = new URL(req.url ?? "/", "http://gateway.local");
        const requestPath = requestUrl.pathname.replace(/\/+$/u, "") || "/";
        if (requestPath !== wsPath) {
          return;
        }

        wsServer.handleUpgrade(req, socket, head, (clientSocket: any) => {
          wsServer.emit("connection", clientSocket, req);
        });
      };

      httpServer?.on("upgrade", upgradeHandler);

      this.wsServer = wsServer;
      this.wsUpgradeHandler = upgradeHandler;
      runtime.logger.warn("Gateway WS server attached", {
        path: runtime.config.distributed.gatewayWsPath,
      });
    },

    scheduleGatewayWsReconnect(this: GatewaySocketCarrier): void {
      if (this.stopRequested || this.wsReconnectTimer) {
        return;
      }

      const runtime = this.getRuntimeOrThrow?.();
      runtime?.logger.warn("Gateway WS reconnect scheduled", {
        delayMs: CLIENT_RECONNECT_DELAY_MS,
      });

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
        runtime.logger.warn(
          this.wsClientHasConnectedOnce
            ? "Gateway WS connected to gateway again"
            : "Gateway WS connected to gateway",
          {
          url: normalizedUrl,
          },
        );
        this.wsClientHasConnectedOnce = true;
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
        runtime.logger.warn("Gateway WS connection to gateway closed", {
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
            const currentSessionTools =
              await this.collectSessionTools?.() ?? {
                sessionTools: [],
                snapshot: "[]",
              };
            if (
              (currentClientUuid ?? null) === this.wsHelloClientUuid &&
              currentSessionTools.snapshot === this.wsHelloSessionToolsSnapshot
            ) {
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

      if (!this.wsToolsSyncTimer) {
        this.wsToolsSyncTimer = setInterval(() => {
          if (this.stopRequested) {
            return;
          }

          void (async () => {
            for (const [clientSocket, hello] of this.connectedClients?.entries() ?? []) {
              if (!clientSocket || clientSocket.readyState !== 1) {
                continue;
              }
              await this.notifyToolsMismatchForSocket?.(clientSocket, hello);
            }
          })().catch((error: unknown) => {
            runtime.logger.warn("Gateway WS tools sync check failed", {
              error:
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
          });
        }, TOOLS_SYNC_CHECK_INTERVAL_MS);
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

      if (this.wsToolsSyncTimer) {
        clearInterval(this.wsToolsSyncTimer);
        this.wsToolsSyncTimer = null;
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

      this.wsHelloSessionToolsSnapshot = null;

      if (this.wsServer) {
        const server = this.wsServer;
        this.wsServer = null;
        const httpServer = this.apiService?.server;
        if (httpServer && this.wsUpgradeHandler) {
          httpServer.removeListener("upgrade", this.wsUpgradeHandler);
        }
        this.wsUpgradeHandler = null;
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

      this.connectedClientToolsAlerts?.clear();
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
