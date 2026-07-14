import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { basename, extname, join, resolve } from "node:path";
import { inspect } from "node:util";

import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME } from "./standalone-http.service";
import {
  type TelegramWebAppInitDataUnsafe,
  validateTelegramWebAppInitData,
} from "./src/app/webapp/auth";
import {
  captureVisibleTerminal,
  captureVisibleTerminalAnsi,
  getTerminalWindowSize,
  isTerminalUnavailableError,
  sendAllowedTerminalAction,
  sendTerminalLiteralText,
} from "./src/app/webapp/terminal";
import {
  isStreamableTerminalTarget,
  resizeForegroundTerminal,
  subscribeForegroundTerminal,
  type TerminalExitInfo,
} from "./src/shared/integrations/terminal/client";
import {
  hasLocalTargetSession,
  hasOutgoingDeliveryNotice,
} from "./gateway-loopback";
import { isGatewayAuthorizationValid } from "./src/shared/lib/gatewayAuth";
import { MAX_BODY_SIZE_BYTES } from "./src/shared/lib/bodyLimits";
import {
  TELLYMCP_CAPABILITIES,
  TELLYMCP_PROTOCOL_VERSION,
  evaluateVersionCompatibility,
  getTellyMcpPackageRoot,
  getTellyMcpPackageVersion,
  type TellyMcpCapability,
  type VersionCompatibility,
} from "./src/shared/lib/version/versionHandshake";
import type { PartnerArtifactRef } from "./src/entities/collaboration/model/types";

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
const TOOLS_SYNC_CHECK_INTERVAL_MS = 15000;
const WS_HEARTBEAT_INTERVAL_MS = 10000;
const HTTP_SERVER_WAIT_TIMEOUT_MS = 15000;
const HTTP_SERVER_WAIT_STEP_MS = 100;

function requireTelegramBotToken(
  runtime: ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>,
  purpose: string,
): string {
  const token = runtime.config.telegram.botToken?.trim();
  if (!token) {
    throw new Error(
      `Telegram bot token is unavailable on this node; cannot ${purpose}.`,
    );
  }

  return token;
}

function sanitizeArtifactName(value: string): string {
  const withoutControlChars = Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
    .join("");
  return withoutControlChars
    .trim()
    .replace(/[/\\]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^\.+$/u, "file")
    .slice(0, 180) || "file";
}

function allocateArtifactRelativePath(
  shareId: string,
  preferredName: string,
  usedNames: Set<string>,
): string {
  const sanitized = sanitizeArtifactName(preferredName);
  const ext = extname(sanitized);
  const base = ext ? sanitized.slice(0, -ext.length) : sanitized;
  let candidate = sanitized;
  let index = 1;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}--${index}${ext}`;
    index += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return `shares/files/${shareId}/${candidate}`;
}

type GatewaySocketSessionTools = {
  local_session_id: string;
  session_label?: string;
  tools_hash?: string;
  cwd?: string;
};

type GatewaySocketHello = {
  type: "hello";
  connection_id: string;
  role: "client" | "gateway";
  client_uuid?: string;
  gateway_user_uuid?: string;
  client_label?: string;
  system_username?: string;
  project_name?: string;
  namespace?: string;
  node_id?: string;
  package_version?: string;
  protocol_version?: string;
  capabilities?: TellyMcpCapability[];
  session_tools?: GatewaySocketSessionTools[];
};

type GatewaySocketHelloAck = {
  type: "hello_ack";
  connection_id: string;
  package_version: string;
  protocol_version: string;
  capabilities: TellyMcpCapability[];
  compatibility: VersionCompatibility;
  reasons: string[];
  instruction: string;
};

type GatewaySocketHeartbeatPing = {
  type: "heartbeat_ping";
  ts: string;
};

type GatewaySocketHeartbeatPong = {
  type: "heartbeat_pong";
  ts: string;
};

type GatewaySocketLiveRequest = {
  type: "live_request";
  request_id: string;
  request_type:
    | "bootstrap"
    | "bootstrap_validate"
    | "view"
    | "action"
    | "resize"
    | "stream_subscribe"
    | "stream_unsubscribe";
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

type GatewaySocketActionRequest = {
  type: "action_request";
  request_id: string;
  action_name: string;
  payload: Record<string, unknown>;
};

type GatewaySocketActionResponse = {
  type: "action_response";
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
  route_mode?: "project" | "direct";
  project_uuid?: string;
  project_name?: string;
  source_actor_label?: string;
  source_client_uuid?: string;
  kind: string;
  summary: string;
  message: string;
  expected_reply?: string;
  requires_reply: boolean;
  in_reply_to?: string;
  source_session_uuid: string;
  source_session_label: string;
  source_local_session_id: string;
  target_client_uuid?: string;
  target_session_uuid: string;
  target_local_session_id: string;
  target_session_label: string;
  created_at: string;
  note_relative_path: string;
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

type GatewaySocketLiveStreamEvent = {
  type: "live_stream_event";
  stream_id: string;
  event: "snapshot" | "data" | "exit";
  payload: Record<string, unknown>;
};

type GatewaySocketTransportReplyPayload = {
  request_id: string;
  answer: string;
  received_at: string;
};

type GatewaySocketTransportEvent = {
  type: "transport_event";
  event: "request_reply";
  payload: GatewaySocketTransportReplyPayload;
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
  | GatewaySocketHeartbeatPing
  | GatewaySocketHeartbeatPong
  | GatewaySocketLiveRequest
  | GatewaySocketLiveResponse
  | GatewaySocketActionRequest
  | GatewaySocketActionResponse
  | GatewaySocketLiveEvent
  | GatewaySocketLiveStreamEvent
  | GatewaySocketTransportEvent
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

type ActionRequestPending = {
  clientUuid: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type LiveStreamHandler = {
  clientUuid: string;
  onEvent: (event: GatewaySocketLiveStreamEvent) => void;
};

type StandaloneHttpServiceCarrier = Service & {
  httpServer?: HttpServer | null;
};

type GatewaySocketCarrier = Service & {
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  standaloneHttpService?: StandaloneHttpServiceCarrier | null;
  wsServer?: any;
  wsClient?: any;
  wsReconnectTimer?: NodeJS.Timeout | null;
  wsIdentityRefreshTimer?: NodeJS.Timeout | null;
  wsToolsSyncTimer?: NodeJS.Timeout | null;
  wsHeartbeatTimer?: NodeJS.Timeout | null;
  wsAwaitingPong?: boolean;
  wsConnectionId?: string | null;
  wsHelloClientUuid?: string | null;
  wsHelloSessionTools?: GatewaySocketSessionTools[];
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
  pendingActionRequests?: Map<string, ActionRequestPending>;
  liveStreamHandlers?: Map<string, LiveStreamHandler>;
  localLiveStreamSubscriptions?: Map<string, () => void>;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  getHttpServerOrThrow?: () => HttpServer;
  waitForHttpServer?: () => Promise<HttpServer>;
  startGatewayWsServer?: () => Promise<void>;
  startGatewayWsClient?: () => Promise<void>;
  scheduleGatewayWsReconnect?: () => void;
  closeGatewayWsResources?: () => Promise<void>;
  ensureGatewayWsClientIsReusable?: () => boolean;
  collectSessionTools?: () => Promise<{
    sessionTools: GatewaySocketSessionTools[];
    snapshot: string;
  }>;
  getGatewayToolsHash?: () => string | null;
  notifyToolsMismatchForSocket?: (
    socket: any,
    hello: GatewaySocketHello,
  ) => Promise<number>;
  fetchGatewayToolsHashForClient?: () => Promise<string | null>;
  syncLocalToolsAgainstGateway?: (sessionId?: string) => Promise<number>;
  getLocalVersionInfo?: () => {
    packageVersion: string;
    protocolVersion: string;
    capabilities: TellyMcpCapability[];
  };
  findConnectedSessionTool?: (params: {
    clientUuid: string;
    localSessionId: string;
  }) => {
    session_label?: string;
    node_id?: string;
    package_version?: string;
  } | null;
  listConnectedSocketsForClient?: (clientUuid: string) => any[];
  findConnectedSocketForSession?: (params: {
    clientUuid: string;
    localSessionId: string;
  }) => any | null;
  sendClientHello?: (socket: any) => Promise<void>;
  sendDirectPartnerNote?: (params: {
    clientUuid: string;
    localSessionId: string;
    sourceActorLabel?: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    kind: string;
    summary: string;
    message: string;
    expectedReply?: string;
    requiresReply?: boolean;
    inReplyTo?: string;
    artifactRefs?: PartnerArtifactRef[];
  }) => Promise<Record<string, unknown>>;
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
    requestType:
      | "bootstrap"
      | "bootstrap_validate"
      | "view"
      | "action"
      | "resize"
      | "stream_subscribe"
      | "stream_unsubscribe";
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  openLiveRelayStream?: (params: {
    clientUuid: string;
    localSessionId: string;
    onEvent: (event: GatewaySocketLiveStreamEvent) => void;
  }) => Promise<{
    streamId: string;
    close: () => Promise<void>;
  }>;
  requestClientAction?: (params: {
    clientUuid: string;
    actionName: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  resolveConnectedSessionTarget?: (params: {
    sessionId: string;
  }) => Promise<
    | {
        client_uuid: string;
        local_session_id: string;
        session_label?: string;
      }
    | null
  >;
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
  notifyTransportReply?: (params: {
    clientUuid: string;
    payload: GatewaySocketTransportReplyPayload;
  }) => Promise<boolean>;
};

export type TelegramMcpGatewaySocketServiceInstance = GatewaySocketCarrier;

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

function formatTerminalRelayError(error: unknown): string {
  if (isTerminalUnavailableError(error)) {
    return "terminal runtime is unavailable";
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

function computePackageToolsHash(currentDir: string): string | null {
  const packageRoot = getTellyMcpPackageRoot(currentDir);
  if (!packageRoot) {
    return null;
  }

  return computeToolsHashForDir(packageRoot);
}

function isBackendErrorLike(
  value: unknown,
): value is { message?: string; statusCode: number; code: string; name?: string; data?: unknown } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { statusCode?: unknown }).statusCode === "number" &&
      typeof (value as { code?: unknown }).code === "string" &&
      (typeof (value as { name?: unknown }).name === "string" ||
        typeof (value as { message?: unknown }).message === "string"),
  );
}

function formatBackendErrorLike(
  value: { message?: string; statusCode: number; code: string; name?: string; data?: unknown },
): string {
  const details: string[] = [];

  if (typeof value.code === "string" && value.code.trim()) {
    details.push(`code=${value.code.trim()}`);
  }
  if (typeof value.statusCode === "number") {
    details.push(`statusCode=${value.statusCode}`);
  }
  if (value.data !== undefined) {
    try {
      details.push(`data=${JSON.stringify(value.data)}`);
    } catch {
      details.push(`data=${String(value.data)}`);
    }
  }

  const base =
    typeof value.message === "string" && value.message.trim()
      ? value.message.trim()
      : `${value.name ?? "BackendError"} (${value.code})`;

  return details.length > 0 ? `${base}\n${details.join("\n")}` : base;
}

function formatRemoteActionError(error: unknown): string {
  if (isBackendErrorLike(error)) {
    return formatBackendErrorLike(error);
  }
  if (!(error instanceof Error)) {
    return inspect(error, { depth: 6, breakLength: 140 });
  }

  const details: string[] = [];
  const named = error as Error & {
    code?: unknown;
    type?: unknown;
    data?: unknown;
    fields?: unknown;
  };
  const ownProps = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => [
      key,
      (error as unknown as Record<string, unknown>)[key],
    ]),
  );

  if (typeof named.code === "string" && named.code.trim()) {
    details.push(`code=${named.code.trim()}`);
  }
  if (typeof named.type === "string" && named.type.trim()) {
    details.push(`type=${named.type.trim()}`);
  }
  if (named.data !== undefined) {
    try {
      details.push(`data=${JSON.stringify(named.data)}`);
    } catch {
      details.push(`data=${String(named.data)}`);
    }
  }
  if (named.fields !== undefined) {
    try {
      details.push(`fields=${JSON.stringify(named.fields)}`);
    } catch {
      details.push(`fields=${String(named.fields)}`);
    }
  }
  if (Object.keys(ownProps).length > 0) {
    try {
      details.push(`props=${JSON.stringify(ownProps)}`);
    } catch {
      details.push(`props=${inspect(ownProps, { depth: 6, breakLength: 140 })}`);
    }
  }

  const baseMessage = error.stack ?? error.message;
  return details.length > 0
    ? `${baseMessage}\n${details.join("\n")}`
    : baseMessage;
}

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

function listConnectedSocketsForClient(
  carrier: Pick<GatewaySocketCarrier, "connectedClients" | "connectedClientsByUuid">,
  clientUuid: string,
): any[] {
  const sockets: any[] = [];
  for (const [socket, hello] of carrier.connectedClients?.entries() ?? []) {
    if (hello?.client_uuid !== clientUuid) {
      continue;
    }
    if (socket?.readyState !== undefined && socket.readyState !== 1) {
      continue;
    }
    sockets.push(socket);
  }
  return sockets;
}

function findConnectedSocketForSession(
  carrier: Pick<GatewaySocketCarrier, "connectedClients" | "connectedClientsByUuid">,
  params: { clientUuid: string; localSessionId: string },
): any | null {
  for (const [socket, hello] of carrier.connectedClients?.entries() ?? []) {
    if (
      hello?.client_uuid !== params.clientUuid ||
      (socket?.readyState !== undefined && socket.readyState !== 1)
    ) {
      continue;
    }

    const hasSession = Array.isArray(hello.session_tools)
      ? hello.session_tools.some(
          (item) => item.local_session_id === params.localSessionId,
        )
      : false;
    if (hasSession) {
      return socket;
    }
  }
  return null;
}

const TelegramMcpGatewaySocketService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME,
  ],

  actions: {
    refreshClientHello: {
      async handler(this: GatewaySocketCarrier) {
        if (!this.wsClient || this.wsClient.readyState !== 1) {
          return { sent: false };
        }

        await this.sendClientHello?.(this.wsClient);
        return { sent: true };
      },
    },
    requestLiveRelay: {
      params: {
        clientUuid: "string",
        localSessionId: "string",
        requestType: {
          type: "enum",
          values: [
            "bootstrap",
            "bootstrap_validate",
            "view",
            "action",
            "resize",
            "stream_subscribe",
            "stream_unsubscribe",
          ],
        },
        payload: { type: "object", optional: true },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            localSessionId: string;
            requestType:
              | "bootstrap"
              | "bootstrap_validate"
              | "view"
              | "action"
              | "resize"
              | "stream_subscribe"
              | "stream_unsubscribe";
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
    requestClientAction: {
      params: {
        clientUuid: "string",
        actionName: "string",
        params: { type: "object", optional: true },
      },
      async handler(this: GatewaySocketCarrier, ctx) {
        return await this.requestClientAction?.({
          clientUuid: String(ctx.params.clientUuid),
          actionName: String(ctx.params.actionName),
          payload:
            ctx.params.params && typeof ctx.params.params === "object"
              ? (ctx.params.params as Record<string, unknown>)
              : {},
        });
      },
    },
    resolveConnectedSessionTarget: {
      params: {
        sessionId: "string",
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: { params: { sessionId: string } },
      ) {
        return await this.resolveConnectedSessionTarget?.({
          sessionId: String(ctx.params.sessionId),
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
    notifyTransportReply: {
      params: {
        client_uuid: "string",
        request_id: "string",
        answer: "string",
        received_at: "string",
      },
      async handler(this: GatewaySocketCarrier, ctx) {
        return {
          delivered: await this.notifyTransportReply?.({
            clientUuid: String(ctx.params.client_uuid),
            payload: {
              request_id: String(ctx.params.request_id),
              answer: String(ctx.params.answer),
              received_at: String(ctx.params.received_at),
            },
          }),
        };
      },
    },
    sendDirectPartnerNote: {
      params: {
        clientUuid: "string",
        localSessionId: "string",
        sourceActorLabel: { type: "string", optional: true },
        targetClientUuid: "string",
        targetLocalSessionId: "string",
        kind: "string",
        summary: "string",
        message: "string",
        expectedReply: { type: "string", optional: true },
        requiresReply: { type: "boolean", optional: true },
        inReplyTo: { type: "string", optional: true },
        artifactRefs: { type: "array", optional: true, items: "object" },
      },
      async handler(
        this: GatewaySocketCarrier,
        ctx: {
          params: {
            clientUuid: string;
            localSessionId: string;
            sourceActorLabel?: string;
            targetClientUuid: string;
            targetLocalSessionId: string;
            kind: string;
            summary: string;
            message: string;
            expectedReply?: string;
            requiresReply?: boolean;
            inReplyTo?: string;
            artifactRefs?: PartnerArtifactRef[];
          };
        },
      ) {
        return await this.sendDirectPartnerNote?.(ctx.params);
      },
    },
  },

  created(this: GatewaySocketCarrier) {
    this.runtimeService = null;
    this.standaloneHttpService = null;
    this.wsServer = null;
    this.wsClient = null;
    this.wsReconnectTimer = null;
    this.wsIdentityRefreshTimer = null;
    this.wsToolsSyncTimer = null;
    this.wsHeartbeatTimer = null;
    this.wsAwaitingPong = false;
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
    this.pendingActionRequests = new Map();
    this.liveStreamHandlers = new Map();
    this.localLiveStreamSubscriptions = new Map();
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

    getHttpServerOrThrow(this: GatewaySocketCarrier): HttpServer {
      const standaloneHttpService =
        this.standaloneHttpService ??
        (this.broker.getLocalService(
          TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME,
        ) as StandaloneHttpServiceCarrier | null);

      if (!standaloneHttpService?.httpServer) {
        throw new Error(
          `Local Moleculer service '${TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME}' HTTP server is unavailable`,
        );
      }

      this.standaloneHttpService = standaloneHttpService;
      return standaloneHttpService.httpServer;
    },

    async waitForHttpServer(this: GatewaySocketCarrier): Promise<HttpServer> {
      const startedAt = Date.now();

      while (Date.now() - startedAt < HTTP_SERVER_WAIT_TIMEOUT_MS) {
        const standaloneHttpService =
          this.standaloneHttpService ??
          (this.broker.getLocalService(
            TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME,
          ) as StandaloneHttpServiceCarrier | null);

        if (standaloneHttpService?.httpServer) {
          this.standaloneHttpService = standaloneHttpService;
          return standaloneHttpService.httpServer;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, HTTP_SERVER_WAIT_STEP_MS),
        );
      }

      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME}' HTTP server is unavailable`,
      );
    },

    async collectSessionTools(this: GatewaySocketCarrier): Promise<{
      sessionTools: GatewaySocketSessionTools[];
      snapshot: string;
    }> {
      const runtime = this.getRuntimeOrThrow!();
      const sessionsForHello =
        runtime.config.distributed.mode === "client"
          ? await (async () => {
              const resolved = runtime.projectIdentityResolver.resolveSessionDefaults({
                cwd: process.cwd(),
              });
              const session =
                await runtime.sessionStore.getSession(resolved.sessionId);
              if (!session) {
                throw new Error(
                  `Current console '${resolved.sessionId}' is missing from session store during gateway hello.`,
                );
              }

              return [session];
            })()
          : (
            await Promise.all(
                (await runtime.sessionStore.listSessions()).map(async (session) =>
                  (await runtime.bindingStore.getBinding(session.sessionId))
                    ? session
                    : null,
                ),
              )
            ).filter(
              (
                session,
              ): session is Awaited<
                ReturnType<typeof runtime.sessionStore.listSessions>
              >[number] => Boolean(session),
            );
      const sessionTools = sessionsForHello
        .map((session) => {
          const effectiveHash = session.lastSeenToolsHash?.trim() ?? null;
          return {
            local_session_id: session.sessionId,
            ...(session.label ? { session_label: session.label } : {}),
            ...(effectiveHash ? { tools_hash: effectiveHash } : {}),
            ...(session.cwd ? { cwd: session.cwd } : {}),
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
      return computePackageToolsHash(__dirname);
    },

    getLocalVersionInfo(this: GatewaySocketCarrier) {
      return {
        packageVersion: getTellyMcpPackageVersion(__dirname),
        protocolVersion: TELLYMCP_PROTOCOL_VERSION,
        capabilities: [...TELLYMCP_CAPABILITIES],
      };
    },

    findConnectedSessionTool(
      this: GatewaySocketCarrier,
      params: { clientUuid: string; localSessionId: string },
    ) {
      for (const hello of this.connectedClients?.values() ?? []) {
        if (hello?.client_uuid !== params.clientUuid) {
          continue;
        }

        const sessionTool = Array.isArray(hello.session_tools)
          ? hello.session_tools.find(
              (item) => item.local_session_id === params.localSessionId,
            )
          : null;
        if (!sessionTool) {
          continue;
        }

        return {
          ...(sessionTool.session_label
            ? { session_label: sessionTool.session_label }
            : {}),
          ...(hello.node_id ? { node_id: hello.node_id } : {}),
          ...(hello.package_version
            ? { package_version: hello.package_version }
            : {}),
        };
      }

      return null;
    },

    async resolveConnectedSessionTarget(
      this: GatewaySocketCarrier,
      params: { sessionId: string },
    ): Promise<
      | {
          client_uuid: string;
          local_session_id: string;
          session_label?: string;
        }
      | null
    > {
      const sessionId = params.sessionId.trim();
      if (!sessionId || sessionId.startsWith("relay~")) {
        return null;
      }
      const resolved = await (this.broker.call as any)(
        "telegramMcp.gateway.resolveLiveConsole",
        { sessionId },
        { meta: { internal_call: true } },
      ) as {
        client_uuid: string;
        local_session_id: string;
        session_label?: string | null;
      } | null;

      if (!resolved) {
        return null;
      }

      return {
        client_uuid: resolved.client_uuid,
        local_session_id: resolved.local_session_id,
        ...(resolved.session_label ? { session_label: resolved.session_label } : {}),
      };
    },

    async sendDirectPartnerNote(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        localSessionId: string;
        sourceActorLabel?: string;
        targetClientUuid: string;
        targetLocalSessionId: string;
        kind: string;
        summary: string;
        message: string;
        expectedReply?: string;
        requiresReply?: boolean;
        inReplyTo?: string;
        artifactRefs?: PartnerArtifactRef[];
      },
    ): Promise<Record<string, unknown>> {
      const sourceInfo = this.findConnectedSessionTool?.({
        clientUuid: params.clientUuid,
        localSessionId: params.localSessionId,
      });
      const targetInfo = this.findConnectedSessionTool?.({
        clientUuid: params.targetClientUuid,
        localSessionId: params.targetLocalSessionId,
      });
      const targetIsLocal = await this.isLocalGatewayClientUuid?.(
        params.targetClientUuid,
      );

      if (!targetInfo && !targetIsLocal) {
        throw new Error(
          `Target gateway session '${params.targetClientUuid}/${params.targetLocalSessionId}' is not connected.`,
        );
      }

      const requiresReply =
        typeof params.requiresReply === "boolean"
          ? params.requiresReply
          : params.kind === "question" || params.kind === "request";
      const shareId = randomUUID();
      const messageUuid = randomUUID();
      const deliveryUuid = randomUUID();
      const createdAt = new Date().toISOString();
      const usedArtifactNames = new Set<string>();
      const artifacts = (Array.isArray(params.artifactRefs)
        ? params.artifactRefs
        : []
      ).map((artifact) => {
        const originalName =
          typeof artifact.original_name === "string" && artifact.original_name.trim()
            ? artifact.original_name.trim()
            : typeof artifact.relative_path === "string" &&
                artifact.relative_path.trim()
              ? artifact.relative_path.trim()
              : typeof artifact.file_path === "string" && artifact.file_path.trim()
                ? artifact.file_path.trim()
                : "file";
        return {
          artifact_uuid: randomUUID(),
          original_name: basename(originalName),
          ...(typeof artifact.mime_type === "string" && artifact.mime_type.trim()
            ? { mime_type: artifact.mime_type.trim() }
            : {}),
          ...(typeof artifact.size_bytes === "number"
            ? { size_bytes: artifact.size_bytes }
            : {}),
          ...(typeof artifact.storage_ref === "string" && artifact.storage_ref.trim()
            ? { storage_ref: artifact.storage_ref.trim() }
            : {}),
          relative_path: allocateArtifactRelativePath(
            shareId,
            basename(originalName),
            usedArtifactNames,
          ),
          ...(typeof artifact.content_base64 === "string" &&
          artifact.content_base64.trim()
            ? { content_base64: artifact.content_base64.trim() }
            : {}),
        };
      });

      const delivery: GatewaySocketDelivery = {
        delivery_uuid: deliveryUuid,
        message_uuid: messageUuid,
        share_id: shareId,
        route_mode: "direct",
        source_actor_label:
          params.sourceActorLabel?.trim() ||
          sourceInfo?.session_label ||
          params.localSessionId,
        source_client_uuid: params.clientUuid,
        target_client_uuid: params.targetClientUuid,
        kind: params.kind,
        summary: params.summary,
        message: params.message,
        ...(params.expectedReply ? { expected_reply: params.expectedReply } : {}),
        requires_reply: requiresReply,
        ...(params.inReplyTo ? { in_reply_to: params.inReplyTo } : {}),
        source_session_uuid: `${params.clientUuid}:${params.localSessionId}`,
        source_session_label:
          params.sourceActorLabel?.trim() ||
          sourceInfo?.session_label ||
          params.localSessionId,
        source_local_session_id: params.localSessionId,
        target_session_uuid: `${params.targetClientUuid}:${params.targetLocalSessionId}`,
        target_local_session_id: params.targetLocalSessionId,
        target_session_label:
          targetInfo?.session_label ?? params.targetLocalSessionId,
        created_at: createdAt,
        note_relative_path: `shares/${shareId}.md`,
        artifacts,
      };

      const delivered = await this.notifyDeliveryQueued?.({
        clientUuid: params.targetClientUuid,
        delivery,
      });
      if (!delivered) {
        throw new Error(
          `Target gateway session '${params.targetClientUuid}/${params.targetLocalSessionId}' is not connected.`,
        );
      }

      return {
        session_id: params.localSessionId,
        partner_session_id: `${params.targetClientUuid}:${params.targetLocalSessionId}`,
        target_client_uuid: params.targetClientUuid,
        target_local_session_id: params.targetLocalSessionId,
        target_session_label:
          targetInfo?.session_label ?? params.targetLocalSessionId,
        kind: params.kind,
        share_id: shareId,
        delivery_status: "delivered",
        note_path: `gateway://shares/${shareId}.md`,
        xchange_record_id: shareId,
        copied_artifacts: artifacts.map((artifact) => artifact.original_name),
        inbox_message_id: deliveryUuid,
        requires_reply: requiresReply,
        delivery_uuid: deliveryUuid,
      };
    },

    async fetchGatewayToolsHashForClient(
      this: GatewaySocketCarrier,
    ): Promise<string | null> {
      const runtime = this.getRuntimeOrThrow!();
      if (
        runtime.config.distributed.mode === "gateway" ||
        runtime.config.distributed.mode === "both"
      ) {
        return this.getGatewayToolsHash?.() ?? null;
      }

      const gatewayPublicUrl = runtime.config.distributed.gatewayPublicUrl;
      if (!gatewayPublicUrl) {
        return null;
      }

      const url = normalizeGatewayBaseUrl(gatewayPublicUrl);
      url.pathname = `${url.pathname}/tools-md`.replace(/\/{2,}/gu, "/");

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            ...(runtime.config.distributed.gatewayAuthToken
              ? { authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}` }
              : {}),
          },
        });

        if (!response.ok) {
          const message = await response.text();
          throw new Error(
            `Gateway TOOLS.md request failed with status ${response.status}: ${message || response.statusText}`,
          );
        }

        return createHash("sha256").update(await response.text()).digest("hex");
      } catch (error) {
        runtime.logger.debug("Gateway TOOLS.md self-check skipped", {
          gatewayPublicUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async syncLocalToolsAgainstGateway(
      this: GatewaySocketCarrier,
      sessionId?: string,
    ): Promise<number> {
      const runtime = this.getRuntimeOrThrow!();
      const gatewayToolsHash = await this.fetchGatewayToolsHashForClient?.();
      if (!gatewayToolsHash) {
        return 0;
      }

      const sessions = sessionId
        ? [await runtime.sessionStore.getSession(sessionId)].filter(
            (item): item is NonNullable<typeof item> => Boolean(item),
          )
        : await runtime.sessionStore.listSessions();
      const boundSessions = (
        await Promise.all(
          sessions.map(async (session) =>
            (await runtime.bindingStore.getBinding(session.sessionId))
              ? session
              : null,
          ),
        )
      ).filter((session): session is (typeof sessions)[number] => Boolean(session));

      let delivered = 0;
      for (const session of boundSessions) {
        const localHash = session.lastSeenToolsHash?.trim() ?? null;
        if (localHash === gatewayToolsHash) {
          continue;
        }
        if (
          session.lastSeenToolsHash?.trim() === gatewayToolsHash ||
          session.lastNotifiedToolsHash?.trim() === gatewayToolsHash
        ) {
          continue;
        }

        await runtime.telegramTransport.handleToolsUpdatedEvent({
          local_session_id: session.sessionId,
          ...(session.label ? { session_label: session.label } : {}),
          ...(localHash ? { client_tools_hash: localHash } : {}),
          gateway_tools_hash: gatewayToolsHash,
          reason: localHash ? "outdated" : "missing",
          instruction:
            "Call refresh_tools_markdown with the current known_hash for this session. If changed=true, read and apply the returned content before continuing.",
        });
        delivered += 1;
      }

      return delivered;
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
                "Call refresh_tools_markdown with the current known_hash for this session. If changed=true, read and apply the returned content before continuing.",
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
      const versionInfo = this.getLocalVersionInfo?.() ?? {
        packageVersion: "0.0.0-unknown",
        protocolVersion: TELLYMCP_PROTOCOL_VERSION,
        capabilities: [...TELLYMCP_CAPABILITIES],
      };
      const hello: GatewaySocketHello = {
        type: "hello",
        connection_id: this.wsConnectionId || randomUUID(),
        role: "client",
        ...(clientUuid ? { client_uuid: clientUuid } : {}),
        ...(runtime.config.distributed.gatewayUserUuid
          ? { gateway_user_uuid: runtime.config.distributed.gatewayUserUuid }
          : {}),
        ...(runtime.config.project.name
          ? { client_label: runtime.config.project.name }
          : {}),
        ...(process.env.USER?.trim()
          ? { system_username: process.env.USER.trim() }
          : process.env.LOGNAME?.trim()
            ? { system_username: process.env.LOGNAME.trim() }
            : {}),
        ...(runtime.config.project.name
          ? { project_name: runtime.config.project.name }
          : {}),
        ...(this.broker.namespace ? { namespace: this.broker.namespace } : {}),
        ...(this.broker.nodeID ? { node_id: this.broker.nodeID } : {}),
        package_version: versionInfo.packageVersion,
        protocol_version: versionInfo.protocolVersion,
        capabilities: versionInfo.capabilities,
        ...(sessionTools.length > 0 ? { session_tools: sessionTools } : {}),
      };
      this.wsHelloClientUuid = clientUuid ?? null;
      this.wsHelloSessionTools = sessionTools;
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
            requireTelegramBotToken(
              runtime,
              "validate Telegram WebApp relay bootstrap",
            ),
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
          let launchRecord: {
            telegramChatId?: number;
            telegramMessageId?: number;
          } | null = null;

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
              requireTelegramBotToken(
                runtime,
                "validate Telegram WebApp relay bootstrap",
              ),
              runtime.config.webapp.initDataTtlSeconds,
            );
            telegramUserId = validated.user.id;
            launchRecord = runtime.webAppLaunchRegistry.getByUserId(
              validated.user.id,
            );
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

          if (trustedTelegramUserId === null && telegramUserId !== null) {
            runtime.webAppLaunchRegistry.deleteByUserId(telegramUserId);
          }

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
              terminal_target: Boolean(session?.terminalTarget),
              telegram_user_id: telegramUserId,
            },
          };
        }

        if (request.request_type === "view") {
          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.terminalTarget) {
            throw new Error("terminal target is not configured for this session");
          }

          const terminalSize = await getTerminalWindowSize(
            runtime.config.terminal,
            session.terminalTarget,
          );
          const content = await captureVisibleTerminal(
            runtime.config.terminal,
            session.terminalTarget,
            runtime.config.terminal.captureLines,
            runtime.config.webapp.visibleScreens,
          );
          const ansi = await captureVisibleTerminalAnsi(
            runtime.config.terminal,
            session.terminalTarget,
            runtime.config.terminal.captureLines,
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
              ansi,
              ...(terminalSize ? terminalSize : {}),
            },
          };
        }

        if (request.request_type === "action") {
          const action =
            typeof request.payload?.action === "string"
              ? request.payload.action
              : "";
          const text =
            typeof request.payload?.text === "string"
              ? request.payload.text
              : "";
          if (!["up", "down", "enter", "slash", "delete", "tab", "escape", "interrupt", "text"].includes(action)) {
            throw new Error("Unsupported action");
          }
          if (action === "text" && (!text || text.length > 4000)) {
            throw new Error("Text payload is required and must be <= 4000 characters");
          }

          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.terminalTarget) {
            throw new Error("terminal target is not configured for this session");
          }

          if (action === "text") {
            await sendTerminalLiteralText(
              runtime.config.terminal,
              session.terminalTarget,
              text,
            );
          } else {
            await sendAllowedTerminalAction(
              runtime.config.terminal,
              session.terminalTarget,
              action as
                | "up"
                | "down"
                | "enter"
                | "slash"
                | "delete"
                | "tab"
                | "escape"
                | "interrupt",
            );
          }
          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              ok: true,
            },
          };
        }

        if (request.request_type === "resize") {
          const cols =
            typeof request.payload?.cols === "number" ? request.payload.cols : NaN;
          const rows =
            typeof request.payload?.rows === "number" ? request.payload.rows : NaN;
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
            throw new Error("Terminal cols and rows are required");
          }

          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.terminalTarget || !isStreamableTerminalTarget(session.terminalTarget)) {
            throw new Error("Terminal target does not support resize");
          }

          resizeForegroundTerminal(
            session.terminalTarget,
            Math.max(20, Math.min(400, Math.round(cols))),
            Math.max(5, Math.min(200, Math.round(rows))),
          );
          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: { ok: true },
          };
        }

        if (request.request_type === "stream_subscribe") {
          const streamId =
            typeof request.payload?.stream_id === "string"
              ? request.payload.stream_id.trim()
              : "";
          if (!streamId) {
            throw new Error("stream_id is required");
          }

          const sessionId = request.local_session_id.trim();
          const session = await runtime.sessionStore.getSession(sessionId);
          if (!session?.terminalTarget) {
            throw new Error("terminal target is not configured for this session");
          }
          if (!isStreamableTerminalTarget(session.terminalTarget)) {
            throw new Error("Live stream is supported only for PTY-backed terminals");
          }

          this.localLiveStreamSubscriptions?.get(streamId)?.();
          this.localLiveStreamSubscriptions?.delete(streamId);

          const terminalSize = await getTerminalWindowSize(
            runtime.config.terminal,
            session.terminalTarget,
          );
          const content = await captureVisibleTerminal(
            runtime.config.terminal,
            session.terminalTarget,
            runtime.config.terminal.captureLines,
            runtime.config.webapp.visibleScreens,
          );
          const ansi = await captureVisibleTerminalAnsi(
            runtime.config.terminal,
            session.terminalTarget,
            runtime.config.terminal.captureLines,
            runtime.config.webapp.visibleScreens,
          );

          this.wsClient?.send(
            JSON.stringify({
              type: "live_stream_event",
              stream_id: streamId,
              event: "snapshot",
              payload: {
                session_id: session.sessionId,
                session_label: session.label ?? null,
                captured_at: new Date().toISOString(),
                content,
                ansi,
                ...(terminalSize ? terminalSize : {}),
              },
            } satisfies GatewaySocketLiveStreamEvent),
          );

          const unsubscribe = subscribeForegroundTerminal(session.terminalTarget, {
            onData: (data) => {
              this.wsClient?.send(
                JSON.stringify({
                  type: "live_stream_event",
                  stream_id: streamId,
                  event: "data",
                  payload: { data },
                } satisfies GatewaySocketLiveStreamEvent),
              );
            },
            onExit: (info: TerminalExitInfo) => {
              this.wsClient?.send(
                JSON.stringify({
                  type: "live_stream_event",
                  stream_id: streamId,
                  event: "exit",
                  payload: {
                    exitCode:
                      typeof info.exitCode === "number" ? info.exitCode : null,
                    signal:
                      typeof info.signal === "number" ? info.signal : null,
                  },
                } satisfies GatewaySocketLiveStreamEvent),
              );
            },
          });
          this.localLiveStreamSubscriptions?.set(streamId, unsubscribe);

          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              ok: true,
              stream_id: streamId,
            },
          };
        }

        if (request.request_type === "stream_unsubscribe") {
          const streamId =
            typeof request.payload?.stream_id === "string"
              ? request.payload.stream_id.trim()
              : "";
          if (streamId) {
            this.localLiveStreamSubscriptions?.get(streamId)?.();
            this.localLiveStreamSubscriptions?.delete(streamId);
          }

          return {
            type: "live_response",
            request_id: request.request_id,
            ok: true,
            result: {
              ok: true,
              ...(streamId ? { stream_id: streamId } : {}),
            },
          };
        }

        throw new Error(`Unsupported live request type '${request.request_type}'`);
      } catch (error) {
        return {
          type: "live_response",
          request_id: request.request_id,
          ok: false,
          error: formatTerminalRelayError(error),
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
          ...(typeof parsed.client_label === "string" && parsed.client_label.trim()
            ? { client_label: parsed.client_label.trim() }
            : {}),
          ...(typeof parsed.gateway_user_uuid === "string" &&
          parsed.gateway_user_uuid.trim()
            ? { gateway_user_uuid: parsed.gateway_user_uuid.trim() }
            : {}),
          ...(typeof parsed.system_username === "string" &&
          parsed.system_username.trim()
            ? { system_username: parsed.system_username.trim() }
            : {}),
          ...(typeof parsed.project_name === "string" && parsed.project_name.trim()
            ? { project_name: parsed.project_name.trim() }
            : {}),
          ...(typeof parsed.node_id === "string" && parsed.node_id.trim()
            ? { node_id: parsed.node_id.trim() }
            : {}),
          ...(typeof parsed.package_version === "string" &&
          parsed.package_version.trim()
            ? { package_version: parsed.package_version.trim() }
            : {}),
          ...(typeof parsed.protocol_version === "string" &&
          parsed.protocol_version.trim()
            ? { protocol_version: parsed.protocol_version.trim() }
            : {}),
          ...(Array.isArray(parsed.capabilities)
            ? {
                capabilities: parsed.capabilities
                  .map((item) =>
                    typeof item === "string" && item.trim()
                      ? item.trim()
                      : null,
                  )
                  .filter((item): item is TellyMcpCapability => Boolean(item)),
              }
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
                          ...(typeof (item as { cwd?: unknown }).cwd === "string" &&
                          (item as { cwd: string }).cwd.trim()
                            ? {
                                cwd: (item as { cwd: string }).cwd.trim(),
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
        const previousByClientUuid =
          hello.client_uuid
            ? this.connectedClientsByUuid?.get(hello.client_uuid)
            : null;
        const previousHelloForClient =
          previousByClientUuid && previousByClientUuid !== socket
            ? this.connectedClients?.get(previousByClientUuid)
            : previous;
        if (previous?.client_uuid) {
          this.connectedClientsByUuid?.delete(previous.client_uuid);
        }
        this.connectedClients?.set(socket, hello);
        if (hello.client_uuid) {
          this.connectedClientsByUuid?.set(hello.client_uuid, socket);
        }
        runtime.logger.info("Gateway WS hello received", hello);
        if (hello.client_uuid) {
          await this.broker.call(
            "telegramMcp.gateway.syncLiveConsoles",
            {
              client_uuid: hello.client_uuid,
              connection_id: hello.connection_id,
              ...(hello.gateway_user_uuid
                ? { gateway_user_uuid: hello.gateway_user_uuid }
                : {}),
              ...(hello.client_label ? { client_label: hello.client_label } : {}),
              ...(hello.system_username
                ? { system_username: hello.system_username }
                : {}),
              ...(hello.namespace ? { namespace: hello.namespace } : {}),
              ...(hello.node_id ? { node_id: hello.node_id } : {}),
              ...(hello.package_version
                ? { package_version: hello.package_version }
                : {}),
              ...(hello.protocol_version
                ? { protocol_version: hello.protocol_version }
                : {}),
              session_tools: Array.isArray(hello.session_tools)
                ? hello.session_tools.map((sessionTool) => ({
                    local_session_id: sessionTool.local_session_id,
                    ...(sessionTool.session_label
                      ? { session_label: sessionTool.session_label }
                      : {}),
                    ...(sessionTool.tools_hash
                      ? { tools_hash: sessionTool.tools_hash }
                      : {}),
                    ...(sessionTool.cwd ? { cwd: sessionTool.cwd } : {}),
                  }))
                : [],
            },
            { meta: { internal_call: true } },
          );

          await runtime.telegramTransport.hydrateGatewayClientOwnerRoute({
            clientUuid: hello.client_uuid,
            ...(hello.gateway_user_uuid
              ? { gatewayUserUuid: hello.gateway_user_uuid }
              : {}),
          });
          runtime.telegramTransport.ensurePromptScanRunning();
        }
        const localVersionInfo = this.getLocalVersionInfo?.() ?? {
          packageVersion: "0.0.0-unknown",
          protocolVersion: TELLYMCP_PROTOCOL_VERSION,
          capabilities: [...TELLYMCP_CAPABILITIES],
        };
        const compatibility = evaluateVersionCompatibility({
          gatewayPackageVersion: localVersionInfo.packageVersion,
          gatewayProtocolVersion: localVersionInfo.protocolVersion,
          ...(hello.package_version
            ? { clientPackageVersion: hello.package_version }
            : {}),
          ...(hello.protocol_version
            ? { clientProtocolVersion: hello.protocol_version }
            : {}),
        });
        const ackInstruction =
          compatibility.compatibility === "reject"
            ? "Upgrade this client before continuing. Gateway transport is blocked until protocol major versions match."
            : compatibility.compatibility === "warn"
              ? "Client and gateway versions differ. Upgrade the older side and verify TOOLS.md before continuing sensitive work."
              : "Version handshake passed.";
        socket.send(
          JSON.stringify({
            type: "hello_ack",
            connection_id: hello.connection_id,
            package_version: localVersionInfo.packageVersion,
            protocol_version: localVersionInfo.protocolVersion,
            capabilities: localVersionInfo.capabilities,
            compatibility: compatibility.compatibility,
            reasons: compatibility.reasons,
            instruction: ackInstruction,
          } satisfies GatewaySocketHelloAck),
        );
        if (compatibility.compatibility === "reject") {
          runtime.logger.warn(
            "Rejecting gateway WS client due to protocol incompatibility",
            {
              clientUuid: hello.client_uuid,
              clientPackageVersion: hello.package_version ?? null,
              clientProtocolVersion: hello.protocol_version ?? null,
              gatewayPackageVersion: localVersionInfo.packageVersion,
              gatewayProtocolVersion: localVersionInfo.protocolVersion,
              reasons: compatibility.reasons,
            },
          );
          setTimeout(() => {
            try {
              socket.close?.(4002, "version_incompatible");
            } catch {
              socket.terminate?.();
            }
          }, 50);
          return;
        }
        if (hello.client_uuid) {
          const previousSessionIds = new Set(
            Array.isArray(previousHelloForClient?.session_tools)
              ? previousHelloForClient.session_tools
                  .map((session) => session.local_session_id)
                  .filter(
                    (sessionId): sessionId is string =>
                      typeof sessionId === "string" && sessionId.trim().length > 0,
                  )
              : [],
          );
          const currentSessions = Array.isArray(hello.session_tools)
            ? hello.session_tools.filter(
                (session): session is GatewaySocketSessionTools =>
                  typeof session?.local_session_id === "string" &&
                  session.local_session_id.trim().length > 0,
              )
            : [];
          const newSessions = currentSessions.filter(
            (session) => !previousSessionIds.has(session.local_session_id),
          );
          const isNewClient = !previousHelloForClient;

          if (isNewClient || newSessions.length > 0) {
            await runtime.telegramTransport.sendAdminGatewayRegistrationNotifications({
              clientUuid: hello.client_uuid,
              ...(hello.gateway_user_uuid
                ? { gatewayUserUuid: hello.gateway_user_uuid }
                : {}),
              ...(hello.node_id ? { nodeId: hello.node_id } : {}),
              ...(hello.package_version
                ? { packageVersion: hello.package_version }
                : {}),
              totalSessions: currentSessions.length,
              isNewClient,
              newSessions,
            });
          }
        }
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

      if (parsed.type === "heartbeat_ping") {
        socket.send(
          JSON.stringify({
            type: "heartbeat_pong",
            ts:
              typeof parsed.ts === "string" && parsed.ts.trim()
                ? parsed.ts.trim()
                : new Date().toISOString(),
          } satisfies GatewaySocketHeartbeatPong),
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
        return;
      }

      if (parsed.type === "live_stream_event") {
        const streamId =
          typeof parsed.stream_id === "string" ? parsed.stream_id.trim() : "";
        if (!streamId) {
          return;
        }
        const handler = this.liveStreamHandlers?.get(streamId);
        if (!handler) {
          return;
        }
        handler.onEvent(parsed as GatewaySocketLiveStreamEvent);
        return;
      }

      if (parsed.type === "action_response") {
        const requestId =
          typeof parsed.request_id === "string" ? parsed.request_id.trim() : "";
        if (!requestId) {
          return;
        }
        const pending = this.pendingActionRequests?.get(requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingActionRequests?.delete(requestId);
        runtime.logger.info("Gateway WS action response received", {
          requestId,
          clientUuid: pending.clientUuid,
          ok: parsed.ok === true,
          ...(parsed.ok === true
            ? {}
            : {
                error:
                  typeof parsed.error === "string" && parsed.error.trim()
                    ? parsed.error
                    : "Remote action request failed",
              }),
        });
        if (parsed.ok === true) {
          pending.resolve(parsed.result);
        } else {
          pending.reject(
            new Error(
              typeof parsed.error === "string" && parsed.error.trim()
                ? parsed.error
                : "Remote action request failed",
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
        const compatibility =
          parsed.compatibility === "warn" || parsed.compatibility === "reject"
            ? parsed.compatibility
            : "ok";
        const gatewayPackageVersion =
          typeof parsed.package_version === "string" && parsed.package_version.trim()
            ? parsed.package_version.trim()
            : "0.0.0-unknown";
        const gatewayProtocolVersion =
          typeof parsed.protocol_version === "string" && parsed.protocol_version.trim()
            ? parsed.protocol_version.trim()
            : TELLYMCP_PROTOCOL_VERSION;
        const reasons = Array.isArray(parsed.reasons)
          ? parsed.reasons
              .map((item) =>
                typeof item === "string" && item.trim() ? item.trim() : null,
              )
              .filter((item): item is string => Boolean(item))
          : [];
        const gatewayCapabilities = Array.isArray(parsed.capabilities)
          ? parsed.capabilities
              .map((item) =>
                typeof item === "string" && item.trim() ? item.trim() : null,
              )
              .filter((item): item is string => Boolean(item))
          : [];
        const localVersionInfo = this.getLocalVersionInfo?.() ?? {
          packageVersion: "0.0.0-unknown",
          protocolVersion: TELLYMCP_PROTOCOL_VERSION,
          capabilities: [...TELLYMCP_CAPABILITIES],
        };
        runtime.logger.info("Gateway WS hello acknowledged", {
          connectionId:
            typeof parsed.connection_id === "string" ? parsed.connection_id : null,
          clientUuid: this.wsHelloClientUuid,
          compatibility,
          gatewayPackageVersion,
          gatewayProtocolVersion,
        });
        if (compatibility !== "ok") {
          const sessionTools = Array.isArray(this.wsHelloSessionTools)
            ? this.wsHelloSessionTools
            : [];
          for (const sessionTool of sessionTools) {
            await runtime.telegramTransport.handleGatewayVersionCompatibilityEvent({
              local_session_id: sessionTool.local_session_id,
              ...(sessionTool.session_label
                ? { session_label: sessionTool.session_label }
                : {}),
              compatibility,
              gateway_package_version: gatewayPackageVersion,
              gateway_protocol_version: gatewayProtocolVersion,
              gateway_capabilities: gatewayCapabilities,
              client_package_version: localVersionInfo.packageVersion,
              client_protocol_version: localVersionInfo.protocolVersion,
              client_capabilities: localVersionInfo.capabilities,
              reasons,
              instruction:
                typeof parsed.instruction === "string" && parsed.instruction.trim()
                  ? parsed.instruction.trim()
                  : compatibility === "reject"
                    ? "Upgrade this client before continuing. Gateway transport is blocked until protocol major versions match."
                    : "Client and gateway versions differ. Upgrade the older side and verify TOOLS.md before continuing sensitive work.",
            });
          }
        }
        if (compatibility === "reject") {
          try {
            this.wsClient?.close?.(4002, "version_incompatible");
          } catch {
            this.wsClient?.terminate?.();
          }
          return;
        }
        await this.syncLocalToolsAgainstGateway?.();
        return;
      }

      if (parsed.type === "heartbeat_pong") {
        this.wsAwaitingPong = false;
        return;
      }

      if (parsed.type === "tools_event" && parsed.payload) {
        await runtime.telegramTransport.handleToolsUpdatedEvent(
          parsed.payload as GatewaySocketToolsEventPayload,
        );
        return;
      }

      if (parsed.type === "action_request") {
        const requestId =
          typeof parsed.request_id === "string" ? parsed.request_id.trim() : "";
        const actionName =
          typeof parsed.action_name === "string" ? parsed.action_name.trim() : "";
        if (!requestId || !actionName) {
          return;
        }

        runtime.logger.info("Gateway WS action request received on client", {
          requestId,
          actionName,
          sessionId:
            typeof parsed.payload?.session_id === "string"
              ? parsed.payload.session_id
              : null,
        });

        try {
          const result = await this.broker.call(
            actionName,
            parsed.payload ?? {},
            { meta: { internal_call: true } },
          );
          if (isBackendErrorLike(result)) {
            this.wsClient?.send(
              JSON.stringify({
                type: "action_response",
                request_id: requestId,
                ok: false,
                error: formatBackendErrorLike(result),
              } satisfies GatewaySocketActionResponse),
            );
            return;
          }
          runtime.logger.info("Gateway WS action request completed on client", {
            requestId,
            actionName,
          });
          this.wsClient?.send(
            JSON.stringify({
              type: "action_response",
              request_id: requestId,
              ok: true,
              result,
            } satisfies GatewaySocketActionResponse),
          );
        } catch (error) {
          const formattedError = formatRemoteActionError(error);
          runtime.logger.error("Gateway WS action request failed on client", {
            requestId,
            actionName,
            error: formattedError,
            payload:
              actionName === "telegramMcp.fileContent.uploadFileRemote"
                ? { ...(parsed.payload ?? {}), upload_url: "[redacted]" }
                : (parsed.payload ?? {}),
          });
          this.wsClient?.send(
            JSON.stringify({
              type: "action_response",
              request_id: requestId,
              ok: false,
              error: formattedError,
            } satisfies GatewaySocketActionResponse),
          );
        }
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

      if (parsed.type === "transport_event" && parsed.payload) {
        if (parsed.event === "request_reply") {
          await runtime.telegramTransport.handleGatewayTransportReplyEvent(
            parsed.payload as GatewaySocketTransportReplyPayload,
          );
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
        requestType:
          | "bootstrap"
          | "bootstrap_validate"
          | "view"
          | "action"
          | "resize"
          | "stream_subscribe"
          | "stream_unsubscribe";
        payload: Record<string, unknown>;
      },
    ): Promise<unknown> {
      const runtime = this.getRuntimeOrThrow!();
      const socket = findConnectedSocketForSession(this, {
        clientUuid: params.clientUuid,
        localSessionId: params.localSessionId,
      });
      if (!socket || socket.readyState !== 1) {
        throw new Error(
          `Gateway WS console '${params.clientUuid}/${params.localSessionId}' is not connected`,
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

    async openLiveRelayStream(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        localSessionId: string;
        onEvent: (event: GatewaySocketLiveStreamEvent) => void;
      },
    ): Promise<{
      streamId: string;
      close: () => Promise<void>;
    }> {
      const streamId = randomUUID();
      this.liveStreamHandlers?.set(streamId, {
        clientUuid: params.clientUuid,
        onEvent: params.onEvent,
      });

      try {
        await this.requestLiveRelay?.({
          clientUuid: params.clientUuid,
          localSessionId: params.localSessionId,
          requestType: "stream_subscribe",
          payload: { stream_id: streamId },
        });
      } catch (error) {
        this.liveStreamHandlers?.delete(streamId);
        throw error;
      }

      return {
        streamId,
        close: async () => {
          this.liveStreamHandlers?.delete(streamId);
          try {
            await this.requestLiveRelay?.({
              clientUuid: params.clientUuid,
              localSessionId: params.localSessionId,
              requestType: "stream_unsubscribe",
              payload: { stream_id: streamId },
            });
          } catch {
            // best-effort unsubscribe during stream shutdown
          }
        },
      };
    },

    async requestClientAction(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        actionName: string;
        payload: Record<string, unknown>;
      },
    ): Promise<unknown> {
      const localSessionId =
        typeof params.payload?.session_id === "string" && params.payload.session_id.trim()
          ? params.payload.session_id.trim()
          : null;
      const socket = localSessionId
        ? findConnectedSocketForSession(this, {
            clientUuid: params.clientUuid,
            localSessionId,
          })
        : (this.connectedClientsByUuid?.get(params.clientUuid) ?? null);
      if (!socket || socket.readyState !== 1) {
        throw new Error(
          localSessionId
            ? `Gateway WS console '${params.clientUuid}/${localSessionId}' is not connected`
            : `Gateway WS client '${params.clientUuid}' is not connected`,
        );
      }

      const requestId = randomUUID();
      return await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingActionRequests?.delete(requestId);
          reject(new Error("Remote action WS request timed out"));
        }, LIVE_REQUEST_TIMEOUT_MS);

        this.pendingActionRequests?.set(requestId, {
          clientUuid: params.clientUuid,
          resolve,
          reject,
          timeout,
        });

        this.getRuntimeOrThrow!().logger.info("Gateway WS action request sent", {
          requestId,
          clientUuid: params.clientUuid,
          actionName: params.actionName,
          localSessionId,
        });

        socket.send(
          JSON.stringify({
            type: "action_request",
            request_id: requestId,
            action_name: params.actionName,
            payload: params.payload ?? {},
          } satisfies GatewaySocketActionRequest),
        );
      });
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
        const sockets = listConnectedSocketsForClient(this, clientUuid);
        if (sockets.length === 0) {
          continue;
        }
        for (const socket of sockets) {
          socket.send(JSON.stringify(message));
          delivered += 1;
        }
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
        const sockets = listConnectedSocketsForClient(this, clientUuid);
        if (sockets.length === 0) {
          continue;
        }
        for (const socket of sockets) {
          socket.send(JSON.stringify(message));
          delivered += 1;
        }
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
        const sockets = listConnectedSocketsForClient(this, clientUuid);
        if (sockets.length === 0) {
          continue;
        }
        for (const socket of sockets) {
          socket.send(JSON.stringify(message));
          delivered += 1;
        }
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
      const runtime = this.getRuntimeOrThrow!();
      await runtime.telegramTransport.handleLiveViewApprovalRequestEvent(
        params.payload,
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
      const runtime = this.getRuntimeOrThrow!();
      await runtime.telegramTransport.handleLiveViewApprovalResolvedEvent({
        approved: params.approved,
        ...params.payload,
      });
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

      const socket = findConnectedSocketForSession(this, {
        clientUuid: params.clientUuid,
        localSessionId: params.delivery.target_local_session_id,
      });
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

      const sockets = listConnectedSocketsForClient(this, params.clientUuid);
      if (sockets.length === 0) {
        return false;
      }

      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            type: "delivery_status_event",
            payload: params.status,
          } satisfies GatewaySocketDeliveryStatusEvent),
        );
      }
      return true;
    },

    async notifyTransportReply(
      this: GatewaySocketCarrier,
      params: {
        clientUuid: string;
        payload: GatewaySocketTransportReplyPayload;
      },
    ): Promise<boolean> {
      if (await this.isLocalGatewayClientUuid?.(params.clientUuid)) {
        const runtime = this.getRuntimeOrThrow!();
        await runtime.telegramTransport.handleGatewayTransportReplyEvent(
          params.payload,
        );
        return true;
      }

      const sockets = listConnectedSocketsForClient(this, params.clientUuid);
      if (sockets.length === 0) {
        return false;
      }

      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            type: "transport_event",
            event: "request_reply",
            payload: params.payload,
          } satisfies GatewaySocketTransportEvent),
        );
      }
      return true;
    },

    async startGatewayWsServer(this: GatewaySocketCarrier): Promise<void> {
      const runtime = this.getRuntimeOrThrow!();
      if (!runtime || this.wsServer) {
        return;
      }

      const httpServer = await this.waitForHttpServer?.();
      const wsPath =
        runtime.config.distributed.gatewayWsPath.replace(/\/+$/u, "") || "/";
      const wsServer = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_BODY_SIZE_BYTES,
      });

      wsServer.on("connection", (socket: any, req: any) => {
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

        socket.on("error", (error: unknown) => {
          runtime.logger.warn("Gateway WS server socket error", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

        socket.on("close", () => {
          const hello = this.connectedClients?.get(socket);
          if (hello?.connection_id) {
            void this.broker
              .call(
                "telegramMcp.gateway.removeLiveConsoles",
                {
                  connection_id: hello.connection_id,
                  ...(hello.client_uuid ? { client_uuid: hello.client_uuid } : {}),
                },
                { meta: { internal_call: true } },
              )
              .catch((error: unknown) => {
                runtime.logger.warn("Failed to remove gateway live consoles on disconnect", {
                  connectionId: hello.connection_id,
                  clientUuid: hello?.client_uuid ?? null,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
          if (hello?.client_uuid) {
            if (this.connectedClientsByUuid?.get(hello.client_uuid) === socket) {
              const replacement =
                listConnectedSocketsForClient(this, hello.client_uuid).find(
                  (candidate) => candidate !== socket,
                ) ?? null;
              if (replacement) {
                this.connectedClientsByUuid?.set(hello.client_uuid, replacement);
              } else {
                this.connectedClientsByUuid?.delete(hello.client_uuid);
              }
            }
            for (const [streamId, handler] of this.liveStreamHandlers?.entries() ?? []) {
              if (handler.clientUuid === hello.client_uuid) {
                this.liveStreamHandlers?.delete(streamId);
              }
            }
          }
          if ((this.connectedClientsByUuid?.size ?? 0) === 0) {
            runtime.telegramTransport.pausePromptScan();
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

        if (
          !isGatewayAuthorizationValid(
            req.headers.authorization,
            runtime.config.distributed.gatewayAuthToken,
          )
        ) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n" +
              "\r\n",
          );
          socket.destroy();
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

    ensureGatewayWsClientIsReusable(this: GatewaySocketCarrier): boolean {
      if (!this.wsClient) {
        return true;
      }

      const readyState =
        typeof this.wsClient.readyState === "number"
          ? this.wsClient.readyState
          : null;

      // OPEN=1, CONNECTING=0 are still active; CLOSING=2 and CLOSED=3 are stale.
      if (readyState === 0 || readyState === 1) {
        return false;
      }

      this.wsClient = null;
      return true;
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
      if (!runtime) {
        return;
      }

      if (!this.ensureGatewayWsClientIsReusable?.()) {
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
        maxPayload: MAX_BODY_SIZE_BYTES,
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
        this.wsAwaitingPong = false;
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
        this.wsAwaitingPong = false;
        if (this.wsClient === socket && socket.readyState !== 1) {
          this.wsClient = null;
        }
        this.scheduleGatewayWsReconnect?.();
      });

      socket.on("close", () => {
        runtime.logger.warn("Gateway WS connection to gateway closed", {
          url: normalizedUrl,
          clientUuid: this.wsHelloClientUuid,
        });
        this.wsAwaitingPong = false;
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

      if (!this.wsHeartbeatTimer) {
        this.wsHeartbeatTimer = setInterval(() => {
          if (this.stopRequested) {
            return;
          }

          const activeSocket = this.wsClient;
          if (!activeSocket || activeSocket.readyState !== 1) {
            this.wsAwaitingPong = false;
            return;
          }

          if (this.wsAwaitingPong) {
            runtime.logger.warn("Gateway WS heartbeat timed out; terminating stale client socket", {
              url: normalizedUrl,
              clientUuid: this.wsHelloClientUuid,
            });
            this.wsAwaitingPong = false;
            if (this.wsClient === activeSocket) {
              this.wsClient = null;
            }
            activeSocket.terminate?.();
            this.scheduleGatewayWsReconnect?.();
            return;
          }

          this.wsAwaitingPong = true;
          try {
            activeSocket.send?.(
              JSON.stringify({
                type: "heartbeat_ping",
                ts: new Date().toISOString(),
              } satisfies GatewaySocketHeartbeatPing),
            );
          } catch (error) {
            this.wsAwaitingPong = false;
            runtime.logger.warn("Gateway WS heartbeat ping failed", {
              url: normalizedUrl,
              error:
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
            if (this.wsClient === activeSocket) {
              this.wsClient = null;
            }
            activeSocket.terminate?.();
            this.scheduleGatewayWsReconnect?.();
          }
        }, WS_HEARTBEAT_INTERVAL_MS);
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

      if (this.wsHeartbeatTimer) {
        clearInterval(this.wsHeartbeatTimer);
        this.wsHeartbeatTimer = null;
      }
      this.wsAwaitingPong = false;

      for (const pending of this.pendingLiveRequests?.values() ?? []) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Gateway WS transport is shutting down"));
      }
      this.pendingLiveRequests?.clear();
      for (const pending of this.pendingActionRequests?.values() ?? []) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Gateway WS transport is shutting down"));
      }
      this.pendingActionRequests?.clear();
      for (const unsubscribe of this.localLiveStreamSubscriptions?.values() ?? []) {
        unsubscribe();
      }
      this.localLiveStreamSubscriptions?.clear();
      this.liveStreamHandlers?.clear();

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
        const httpServer = this.standaloneHttpService?.httpServer;
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
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    this.runtimeService = runtimeService;
    const runtime = await runtimeService.waitUntilReady();
    const mode = runtime.config.distributed.mode;
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
