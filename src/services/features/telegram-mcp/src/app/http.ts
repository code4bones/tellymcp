import { randomUUID } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Update } from "grammy/types";
import ws from "ws";

import type { AppRuntime } from "./bootstrap/runtime";
import { createOAuthFacade, type OAuthFacade } from "./oauthFacade";
import {
  type TelegramWebAppInitDataUnsafe,
  WebAppSessionRegistry,
  validateTelegramWebAppInitData,
} from "./webapp/auth";
import { parseLiveRelaySessionId } from "./webapp/relay";
import {
  WEBAPP_APP_JS,
  WEBAPP_STYLES_CSS,
  renderWebAppHtml,
} from "./webapp/assets";
import {
  isStreamableTerminalTarget,
  resizeForegroundTerminal,
  sendForegroundTerminalInput,
  subscribeForegroundTerminal,
} from "../shared/integrations/terminal/client";
import {
  captureVisibleTerminal,
  captureVisibleTerminalAnsi,
  getTerminalWindowSize,
  isTerminalUnavailableError,
  sendAllowedTerminalAction,
  sendTerminalLiteralText,
} from "./webapp/terminal";
import {
  assertSerializedBodySize,
  isBodySizeLimitError,
  MAX_BODY_SIZE,
  MAX_BODY_SIZE_BYTES,
  readLimitedJsonBody,
} from "../shared/lib/bodyLimits";

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
};

export type McpHttpHandler = {
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => Promise<void>;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    pathname: string,
  ) => Promise<boolean>;
  close: () => Promise<void>;
};

function formatTerminalHttpError(error: unknown, fallback: string): string {
  if (isTerminalUnavailableError(error)) {
    return "terminal runtime is unavailable";
  }

  return fallback;
}

function requireTelegramBotToken(
  runtime: AppRuntime,
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

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const method = Reflect.get(body, "method");
  return method === "initialize";
}

function readMcpRpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const method = Reflect.get(body, "method");
  return typeof method === "string" ? method : undefined;
}

function readHeader(
  req: IncomingMessage,
  headerName: string,
): string | undefined {
  const value = req.headers[headerName];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const knownParams = (
    req as IncomingMessage & { $params?: Record<string, unknown> }
  ).$params;
  if (
    knownParams &&
    typeof knownParams === "object" &&
    Object.keys(knownParams).length > 0
  ) {
    assertSerializedBodySize(knownParams);
    return knownParams;
  }

  const knownBody = (req as IncomingMessage & { body?: unknown }).body;
  if (knownBody !== undefined) {
    assertSerializedBodySize(knownBody);
    return knownBody;
  }
  return readLimitedJsonBody(req);
}

function ignoreInvalidJsonBody(error: unknown): undefined {
  if (isBodySizeLimitError(error)) {
    throw error;
  }
  return undefined;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body);
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

function writeHtml(
  res: ServerResponse,
  statusCode: number,
  html: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function writeJavaScript(
  res: ServerResponse,
  statusCode: number,
  source: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/javascript; charset=utf-8");
  res.end(source);
}

function writeCss(
  res: ServerResponse,
  statusCode: number,
  source: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/css; charset=utf-8");
  res.end(source);
}

function isAuthorized(
  req: IncomingMessage,
  expectedBearerToken?: string,
): boolean {
  if (!expectedBearerToken) {
    return true;
  }

  const header = readHeader(req, "authorization");
  return header === `Bearer ${expectedBearerToken}`;
}

function readBearerToken(req: IncomingMessage): string | null {
  const header = readHeader(req, "authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length).trim() || null;
}

export type McpHttpAuthorizationMode = "public" | "internal_bearer" | "oauth";

export function resolveMcpHttpAuthorization(
  req: IncomingMessage,
  internalBearerToken: string | undefined,
  oauthFacade: Pick<OAuthFacade, "verifyAccessToken"> | null,
): McpHttpAuthorizationMode | null {
  if (!internalBearerToken && !oauthFacade) {
    return "public";
  }
  if (internalBearerToken && isAuthorized(req, internalBearerToken)) {
    return "internal_bearer";
  }

  const token = readBearerToken(req);
  return token && oauthFacade?.verifyAccessToken(token) ? "oauth" : null;
}

export function isMcpHttpRequestAuthorized(
  req: IncomingMessage,
  internalBearerToken: string | undefined,
  oauthFacade: Pick<OAuthFacade, "verifyAccessToken"> | null,
): boolean {
  return resolveMcpHttpAuthorization(req, internalBearerToken, oauthFacade) !== null;
}

function isDuplicateSseStreamError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.includes("Only one SSE stream is allowed per session");
}

function normalizePrefixedPathname(pathname: string): string {
  const rootPrefix = process.env.ROOT_PREFIX || "/api";
  const normalizedRootPrefix =
    rootPrefix !== "/" ? rootPrefix.replace(/\/+$/u, "") : "/";

  if (
    normalizedRootPrefix === "/" ||
    !pathname.startsWith(normalizedRootPrefix)
  ) {
    return pathname || "/";
  }

  const stripped = pathname.slice(normalizedRootPrefix.length);
  return stripped.startsWith("/") ? stripped : `/${stripped || ""}`;
}

function resolveLaunchModeOverride(
  value: string | null,
): "default" | "expand" | "fullscreen" | null {
  return value === "default" || value === "expand" || value === "fullscreen"
    ? value
    : null;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readWebhookSecretHeader(req: IncomingMessage): string | undefined {
  const value = req.headers["x-telegram-bot-api-secret-token"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isRelayTerminalUnavailableMessage(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("terminal runtime is unavailable");
}

export function createMcpHttpHandler(
  runtime: AppRuntime,
  input: {
    createMcpServer: () => McpServer;
    getGatewaySocketService?: () => {
      openLiveRelayStream?: (params: {
        clientUuid: string;
        localSessionId: string;
        onEvent: (event: {
          event: "snapshot" | "data" | "exit";
          payload: Record<string, unknown>;
        }) => void;
      }) => Promise<{
        close: () => Promise<void>;
      }>;
      requestLiveRelay?: (params: {
        clientUuid: string;
        localSessionId: string;
        requestType: "action" | "resize";
        payload: Record<string, unknown>;
      }) => Promise<unknown>;
    } | null;
  },
): McpHttpHandler {
  const transports = new Map<string, SessionEntry>();
  const webAppSessions = new WebAppSessionRegistry();
  const liveWsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY_SIZE_BYTES,
  });
  const webAppBasePath =
    runtime.config.webapp.basePath.replace(/\/+$/u, "") || "/webapp";
  const rootPrefix = normalizeBasePath(process.env.ROOT_PREFIX || "/api");
  const publicWebAppBasePath =
    rootPrefix === "/"
      ? webAppBasePath
      : `${rootPrefix}${normalizeBasePath(webAppBasePath)}`;
  const publicLiveWsPath =
    rootPrefix === "/" ? "/gateway/live/ws" : `${rootPrefix}/gateway/live/ws`;
  const webAppLivePrefix = `${webAppBasePath}/live/`;
  const telegramWebhookPath =
    runtime.config.telegram.webhook.path.replace(/\/+$/u, "") ||
    "/telegram/webhook";
  const mcpHttpPath =
    runtime.config.mcp.httpPath.replace(/\/+$/u, "") || "/mcp";
  const oauthFacade = runtime.config.oauth
    ? createOAuthFacade(
        runtime.config.oauth,
        mcpHttpPath,
        runtime.logger,
      )
    : null;

  if (oauthFacade?.ephemeralSigningKey) {
    runtime.logger.warn(
      "OAuth connector is using an ephemeral signing key; access tokens will stop working after restart",
    );
  }

  const closeSessionEntry = async (entry: SessionEntry): Promise<void> => {
    await entry.close();
  };

  const resolveAuthorizedWebAppSession = async (token: string) => {
    const webAppSession = token ? webAppSessions.get(token) : null;
    if (!webAppSession) {
      return null;
    }

    const relayTarget = parseLiveRelaySessionId(webAppSession.sessionId);
    if (relayTarget) {
      return {
        webAppSession,
        relayTarget,
        session: null,
      };
    }

    const binding = await runtime.bindingStore.getBinding(webAppSession.sessionId);
    if (!binding || binding.telegramUserId !== webAppSession.telegramUserId) {
      return null;
    }

    const session = await runtime.sessionStore.getSession(webAppSession.sessionId);
    if (!session?.terminalTarget) {
      return null;
    }

    return {
      webAppSession,
      relayTarget: null,
      session,
    };
  };

  liveWsServer.on("connection", (socket: LiveWebSocket, req: IncomingMessage) => {
    const requestUrl = new URL(req.url ?? "/", "http://gateway.local");
    const token = requestUrl.searchParams.get("token")?.trim() ?? "";

    void (async () => {
      const resolved = await resolveAuthorizedWebAppSession(token);
      if (!resolved) {
        socket.close(1008, "Unauthorized");
        return;
      }

      let closed = false;
      let relayStreamClose: (() => Promise<void>) | null = null;
      let localUnsubscribe: (() => void) | null = null;

      const cleanup = async () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          localUnsubscribe?.();
        } catch {
          // ignore cleanup errors during socket shutdown
        }
        localUnsubscribe = null;
        if (relayStreamClose) {
          await relayStreamClose().catch(() => undefined);
          relayStreamClose = null;
        }
      };

      const sendJson = (payload: Record<string, unknown>) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(payload));
        }
      };

      socket.on("close", () => {
        void cleanup();
      });

      socket.on("error", (error: unknown) => {
        runtime.logger.warn("Telegram WebApp live WS socket error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      socket.on("message", (raw: unknown) => {
        void (async () => {
          const parsed =
            raw && typeof raw === "string"
              ? JSON.parse(raw)
              : JSON.parse(String(raw)) as Record<string, unknown>;
          const type =
            parsed && typeof parsed === "object" && typeof parsed.type === "string"
              ? parsed.type
              : "";

          if (type === "input") {
            const data =
              typeof parsed.data === "string" ? parsed.data : "";
            if (!data) {
              return;
            }

            if (resolved.relayTarget) {
              const gatewaySocketService = input.getGatewaySocketService?.();
              await gatewaySocketService?.requestLiveRelay?.({
                clientUuid: resolved.relayTarget.clientUuid,
                localSessionId: resolved.relayTarget.localSessionId,
                requestType: "action",
                payload: {
                  action: "text",
                  text: data,
                },
              });
              return;
            }

            if (resolved.session?.terminalTarget && isStreamableTerminalTarget(resolved.session.terminalTarget)) {
              sendForegroundTerminalInput(resolved.session.terminalTarget, data);
            }
            return;
          }

          if (type === "action") {
            const action =
              typeof parsed.action === "string" ? parsed.action : "";
            if (
              ![
                "up",
                "down",
                "enter",
                "slash",
                "delete",
                "tab",
                "escape",
                "interrupt",
              ].includes(action)
            ) {
              return;
            }

            if (resolved.relayTarget) {
              const gatewaySocketService = input.getGatewaySocketService?.();
              await gatewaySocketService?.requestLiveRelay?.({
                clientUuid: resolved.relayTarget.clientUuid,
                localSessionId: resolved.relayTarget.localSessionId,
                requestType: "action",
                payload: { action },
              });
              return;
            }

            if (resolved.session?.terminalTarget) {
              await sendAllowedTerminalAction(
                runtime.config.terminal,
                resolved.session.terminalTarget,
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
            return;
          }

          if (type === "resize") {
            const cols =
              typeof parsed.cols === "number" ? parsed.cols : NaN;
            const rows =
              typeof parsed.rows === "number" ? parsed.rows : NaN;
            if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
              return;
            }
            if (resolved.session?.terminalTarget && isStreamableTerminalTarget(resolved.session.terminalTarget)) {
              resizeForegroundTerminal(
                resolved.session.terminalTarget,
                Math.max(20, Math.min(400, Math.round(cols))),
                Math.max(5, Math.min(200, Math.round(rows))),
              );
              return;
            }
            if (resolved.relayTarget) {
              await input.getGatewaySocketService?.()?.requestLiveRelay?.({
                clientUuid: resolved.relayTarget.clientUuid,
                localSessionId: resolved.relayTarget.localSessionId,
                requestType: "resize",
                payload: { cols, rows },
              });
            }
          }
        })().catch((error) => {
          runtime.logger.warn("Telegram WebApp live WS message handling failed", {
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        });
      });

      if (resolved.relayTarget) {
        const gatewaySocketService = input.getGatewaySocketService?.();
        if (!gatewaySocketService?.openLiveRelayStream) {
          socket.close(1011, "Relay live stream is unavailable");
          return;
        }

        const relayStream = await gatewaySocketService.openLiveRelayStream({
          clientUuid: resolved.relayTarget.clientUuid,
          localSessionId: resolved.relayTarget.localSessionId,
          onEvent: (event) => {
            sendJson({
              type: event.event,
              ...event.payload,
            });
          },
        });
        relayStreamClose = relayStream.close;
        sendJson({ type: "ready", mode: "stream" });
        return;
      }

      if (
        !resolved.session?.terminalTarget ||
        !isStreamableTerminalTarget(resolved.session.terminalTarget)
      ) {
        socket.close(1011, "Local live stream is not supported for this terminal");
        return;
      }

      const terminalSize = await getTerminalWindowSize(
        runtime.config.terminal,
        resolved.session.terminalTarget,
      );
      const content = await captureVisibleTerminal(
        runtime.config.terminal,
        resolved.session.terminalTarget,
        runtime.config.terminal.captureLines,
        runtime.config.webapp.visibleScreens,
      );
      const ansi = await captureVisibleTerminalAnsi(
        runtime.config.terminal,
        resolved.session.terminalTarget,
        runtime.config.terminal.captureLines,
        runtime.config.webapp.visibleScreens,
      );
      sendJson({
        type: "snapshot",
        session_id: resolved.session.sessionId,
        session_label: resolved.session.label ?? null,
        captured_at: new Date().toISOString(),
        content,
        ansi,
        ...(terminalSize ? terminalSize : {}),
      });

      localUnsubscribe = subscribeForegroundTerminal(resolved.session.terminalTarget, {
        onData: (data) => {
          sendJson({
            type: "data",
            data,
          });
        },
        onExit: (info) => {
          sendJson({
            type: "exit",
            exitCode: typeof info.exitCode === "number" ? info.exitCode : null,
            signal: typeof info.signal === "number" ? info.signal : null,
          });
        },
      });
      sendJson({ type: "ready", mode: "stream" });
    })().catch((error) => {
      runtime.logger.warn("Telegram WebApp live WS bootstrap failed", {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      socket.close(1011, "Live stream bootstrap failed");
    });
  });

  const handleRequestInternal = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    const method = req.method ?? "GET";
    const normalizedPathname = normalizePrefixedPathname(pathname);
    const requestUrl = new URL(
      req.url ?? normalizedPathname,
      `http://gateway.local`,
    );
    requestUrl.pathname = normalizedPathname;

    if (
      runtime.temporaryFileLinkStore &&
      (await runtime.temporaryFileLinkStore.handleRequest(
        req,
        res,
        requestUrl.pathname,
      ))
    ) {
      return;
    }

    if (oauthFacade) {
      const authorizationHeader = readHeader(req, "authorization");
      const connectorRequestContext = {
        method,
        rawPath: pathname,
        path: requestUrl.pathname,
        queryParameters: [...requestUrl.searchParams.keys()],
        userAgent: readHeader(req, "user-agent"),
        accept: readHeader(req, "accept"),
        contentType: readHeader(req, "content-type"),
        authorizationHeaderPresent: Boolean(authorizationHeader),
        authorizationScheme: authorizationHeader?.split(/\s+/u, 1)[0],
        mcpSessionId: readHeader(req, "mcp-session-id"),
        remoteAddress: req.socket.remoteAddress,
      };
      runtime.logger.info(
        "OAuth connector HTTP request received",
        connectorRequestContext,
      );
      res.once("finish", () => {
        runtime.logger.info("OAuth connector HTTP response completed", {
          ...connectorRequestContext,
          statusCode: res.statusCode,
          responseContentType: String(res.getHeader("content-type") ?? ""),
        });
      });
    }

    if (requestUrl.pathname === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        service: "tellymcp",
        transport: "streamable-http",
      });
      return;
    }

    if (
      oauthFacade &&
      (await oauthFacade.handleRequest(req, res, requestUrl.pathname))
    ) {
      return;
    }

    if (
      runtime.config.telegram.webhook.enabled &&
      requestUrl.pathname === telegramWebhookPath
    ) {
      if (method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return;
      }

      const expectedSecret = runtime.config.telegram.webhook.secret?.trim();
      const receivedSecret = readWebhookSecretHeader(req)?.trim();
      if (!expectedSecret || receivedSecret !== expectedSecret) {
        writeText(res, 401, "Unauthorized");
        return;
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") {
        writeText(res, 400, "Telegram update body is required");
        return;
      }

      if (runtime.config.telegram.webhook.trace) {
        runtime.logger.warn("Telegram webhook update received", {
          path: requestUrl.pathname,
          body,
        });
      } else {
        runtime.logger.info("Telegram webhook update received", {
          path: requestUrl.pathname,
          method,
        });
      }

      try {
        await runtime.telegramTransport.handleWebhookUpdate(body as Update);
        writeText(res, 200, "OK");
      } catch (error) {
        runtime.logger.error("Telegram webhook update handling failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        writeText(
          res,
          500,
          error instanceof Error ? error.message : "Webhook handling failed",
        );
      }
      return;
    }

    if (
      await runtime.gatewayHttpService.handleRequest(
        req,
        res,
        requestUrl.pathname,
      )
    ) {
      return;
    }

    if (runtime.config.webapp.enabled) {
      if (
        requestUrl.pathname === webAppBasePath ||
        requestUrl.pathname === `${webAppBasePath}/` ||
        requestUrl.pathname.startsWith(webAppLivePrefix)
      ) {
        if (method !== "GET") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        const launchMode =
          resolveLaunchModeOverride(requestUrl.searchParams.get("launchMode")) ??
          runtime.config.webapp.launchMode;

        writeHtml(
          res,
          200,
          renderWebAppHtml({
            basePath: publicWebAppBasePath,
            liveWsPath: publicLiveWsPath,
            launchMode,
          }),
        );
        return;
      }

      if (requestUrl.pathname === `${webAppBasePath}/app.js`) {
        if (method !== "GET") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        writeJavaScript(res, 200, WEBAPP_APP_JS);
        return;
      }

      if (requestUrl.pathname === `${webAppBasePath}/styles.css`) {
        if (method !== "GET") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        writeCss(res, 200, WEBAPP_STYLES_CSS);
        return;
      }

      if (requestUrl.pathname === `${webAppBasePath}/api/bootstrap`) {
        if (method !== "POST") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        runtime.logger.info("Telegram WebApp bootstrap request received", {
          method,
          path: requestUrl.pathname,
        });

        const body = await readJsonBody(req).catch(ignoreInvalidJsonBody);
        let sessionId =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "sessionId") === "string"
            ? String(Reflect.get(body, "sessionId")).trim()
            : "";
        const initDataRaw =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "initDataRaw") === "string"
            ? String(Reflect.get(body, "initDataRaw"))
            : "";
        const initDataUnsafe =
          body &&
          typeof body === "object" &&
          Reflect.get(body, "initDataUnsafe") &&
          typeof Reflect.get(body, "initDataUnsafe") === "object"
            ? (Reflect.get(
                body,
                "initDataUnsafe",
              ) as TelegramWebAppInitDataUnsafe)
            : null;

        if (!initDataRaw || !initDataUnsafe) {
          writeText(res, 400, "initDataRaw and initDataUnsafe are required");
          return;
        }

        const relayTarget = parseLiveRelaySessionId(sessionId);
        if (relayTarget) {
          try {
            let trustedTelegramUserId: number | null = null;
            let launchRecord: {
              telegramChatId?: number;
              telegramMessageId?: number;
              allowForeignBinding?: boolean;
            } | null = null;
            if (
              relayTarget.sourceClientUuid &&
              relayTarget.sourceClientUuid !== relayTarget.clientUuid
            ) {
              const validation =
                await runtime.gatewayHttpService.requestLiveRelayBootstrapValidation({
                  clientUuid: relayTarget.sourceClientUuid,
                  initDataRaw,
                  initDataUnsafe,
                });
              trustedTelegramUserId = validation.telegram_user_id;
            } else {
              try {
                const validated = validateTelegramWebAppInitData(
                  initDataRaw,
                  initDataUnsafe,
                  requireTelegramBotToken(
                    runtime,
                    "validate local Telegram WebApp bootstrap",
                  ),
                  runtime.config.webapp.initDataTtlSeconds,
                );
                trustedTelegramUserId = validated.user.id;
                launchRecord = runtime.webAppLaunchRegistry.getByUserId(
                  validated.user.id,
                );
              } catch {
                trustedTelegramUserId = null;
              }
            }
            const relayBootstrap =
              await runtime.gatewayHttpService.requestLiveRelayBootstrap({
                clientUuid: relayTarget.clientUuid,
                localSessionId: relayTarget.localSessionId,
                ...(trustedTelegramUserId !== null
                  ? { telegramUserId: trustedTelegramUserId }
                  : {}),
                // Relay sessions are already gateway-bound to a Telegram principal.
                // Do not rely on the per-user launch registry here because it can be
                // overwritten by other menu interactions before the WebApp opens.
                allowForeignBinding: true,
                initDataRaw,
                initDataUnsafe,
              });
            runtime.logger.info("Telegram WebApp relay bootstrap forwarded", {
              sessionId,
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              trustedTelegramUserId,
              hasLaunchRecord: launchRecord !== null,
              launchRecordAllowForeignBinding:
                launchRecord?.allowForeignBinding === true,
            });
            const record = webAppSessions.create(
              sessionId,
              relayBootstrap.telegram_user_id,
              runtime.config.webapp.sessionTtlSeconds,
            );

            writeJson(res, 200, {
              token: record.token,
              session_id: relayBootstrap.session_id,
              session_label: relayBootstrap.session_label,
              terminal_target: relayBootstrap.terminal_target,
              expires_at: new Date(record.expiresAtMs).toISOString(),
            });

            if (trustedTelegramUserId !== null) {
              runtime.webAppLaunchRegistry.deleteByUserId(trustedTelegramUserId);
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
                .catch((deleteError: unknown) => {
                  runtime.logger.warn(
                    "Telegram WebApp relay launcher message deletion failed",
                    {
                      sessionId,
                      clientUuid: relayTarget.clientUuid,
                      localSessionId: relayTarget.localSessionId,
                      telegramUserId: trustedTelegramUserId,
                      telegramChatId: launchRecord.telegramChatId,
                      telegramMessageId: launchRecord.telegramMessageId,
                      error:
                        deleteError instanceof Error
                          ? (deleteError.stack ?? deleteError.message)
                          : String(deleteError),
                    },
                  );
                });
            }
          } catch (error) {
            runtime.logger.warn("Telegram WebApp relay bootstrap rejected", {
              sessionId,
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
            });
            writeText(
              res,
              403,
              error instanceof Error ? error.message : "WebApp relay bootstrap failed",
            );
          }
          return;
        }

        try {
          const validated = validateTelegramWebAppInitData(
            initDataRaw,
            initDataUnsafe,
            requireTelegramBotToken(
              runtime,
              "validate Telegram WebApp bootstrap",
            ),
            runtime.config.webapp.initDataTtlSeconds,
          );
          if (!sessionId) {
            sessionId =
              (await runtime.bindingStore.getActiveSessionIdForTelegramUser(
                validated.user.id,
              )) ?? "";
          }
          let launchRecord = null;
          if (!sessionId) {
            const launch = runtime.webAppLaunchRegistry.getByUserId(
              validated.user.id,
            );
            launchRecord = launch;
            sessionId = launch?.sessionId ?? "";
          } else {
            launchRecord = runtime.webAppLaunchRegistry.getByUserId(
              validated.user.id,
            );
          }

          if (!sessionId) {
            writeText(
              res,
              400,
              "sessionId is missing and no pending Telegram WebApp launch was found",
            );
            return;
          }

          const binding = await runtime.bindingStore.getBinding(sessionId);
          if (!binding || binding.telegramUserId !== validated.user.id) {
            writeText(res, 403, "This Telegram user is not bound to the requested session.");
            return;
          }

          const session = await runtime.sessionStore.getSession(sessionId);
          const record = webAppSessions.create(
            sessionId,
            validated.user.id,
            runtime.config.webapp.sessionTtlSeconds,
          );

          runtime.logger.info("Telegram WebApp session bootstrapped", {
            sessionId,
            telegramUserId: validated.user.id,
            hasTerminalTarget: Boolean(session?.terminalTarget),
          });
          runtime.webAppLaunchRegistry.deleteByUserId(validated.user.id);

          writeJson(res, 200, {
            token: record.token,
            session_id: sessionId,
            session_label: session?.label ?? null,
            terminal_target: Boolean(session?.terminalTarget),
            expires_at: new Date(record.expiresAtMs).toISOString(),
          });

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
                      error instanceof Error
                        ? (error.stack ?? error.message)
                        : String(error),
                  },
                );
              });
          }
          
          return;
        } catch (error) {
          runtime.logger.warn("Telegram WebApp bootstrap rejected", {
            sessionId,
            initDataLength: initDataRaw.length,
            hasUnsafeUser:
              Boolean(initDataUnsafe?.user) &&
              typeof initDataUnsafe?.user?.id === "number",
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
          writeText(
            res,
            403,
            error instanceof Error ? error.message : "WebApp bootstrap failed",
          );
        }
        return;
      }

      if (requestUrl.pathname === `${webAppBasePath}/api/action`) {
        if (method !== "POST") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        const token = readBearerToken(req);
        const webAppSession = token ? webAppSessions.get(token) : null;
        if (!webAppSession) {
          writeText(res, 401, "Unauthorized");
          return;
        }

        const body = await readJsonBody(req).catch(ignoreInvalidJsonBody);
        const action =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "action") === "string"
            ? String(Reflect.get(body, "action"))
            : "";
        const text =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "text") === "string"
            ? String(Reflect.get(body, "text"))
            : "";
        if (!["up", "down", "enter", "slash", "delete", "tab", "escape", "interrupt", "text"].includes(action)) {
          writeText(res, 400, "Unsupported action");
          return;
        }
        if (action === "text" && (!text || text.length > 4000)) {
          writeText(res, 400, "Text payload is required and must be <= 4000 characters");
          return;
        }

        const nowMs = Date.now();
        if (
          nowMs - webAppSession.lastActionAtMs <
          runtime.config.webapp.actionCooldownMs
        ) {
          writeText(res, 429, "Action cooldown");
          return;
        }

        const relayTarget = parseLiveRelaySessionId(webAppSession.sessionId);
        if (relayTarget) {
          try {
            await runtime.gatewayHttpService.requestLiveRelayAction({
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              action: action as
                | "up"
                | "down"
                | "enter"
                | "slash"
                | "delete"
                | "tab"
                | "escape"
                | "interrupt"
                | "text",
              ...(action === "text" ? { text } : {}),
            });
            webAppSessions.touchAction(webAppSession.token, nowMs);
            writeJson(res, 200, {
              ok: true,
            });
          } catch (error) {
            runtime.logger.error("Telegram WebApp relay action failed", {
              sessionId: webAppSession.sessionId,
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              action,
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
            });
            writeText(
              res,
              isRelayTerminalUnavailableMessage(error) ? 503 : 500,
              error instanceof Error ? error.message : "Failed to send relay terminal action",
            );
          }
          return;
        }

        const binding = await runtime.bindingStore.getBinding(
          webAppSession.sessionId,
        );
        if (
          !binding ||
          binding.telegramUserId !== webAppSession.telegramUserId
        ) {
          writeText(res, 403, "Session binding is no longer valid");
          return;
        }

        const session = await runtime.sessionStore.getSession(
          webAppSession.sessionId,
        );
        if (!session?.terminalTarget) {
          writeText(res, 409, "terminal target is not configured for this session");
          return;
        }

        try {
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
          webAppSessions.touchAction(webAppSession.token, nowMs);
          runtime.logger.info("Telegram WebApp action sent to terminal", {
            sessionId: webAppSession.sessionId,
            telegramUserId: webAppSession.telegramUserId,
            action,
            ...(action === "text" ? { textLength: text.length } : {}),
          });
          writeJson(res, 200, {
            ok: true,
          });
        } catch (error) {
          runtime.logger.error("Telegram WebApp action failed", {
            sessionId: webAppSession.sessionId,
            telegramUserId: webAppSession.telegramUserId,
            action,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
          writeText(
            res,
            isTerminalUnavailableError(error) ? 503 : 500,
            formatTerminalHttpError(error, "Failed to send terminal action"),
          );
        }
        return;
      }
    }

    if (requestUrl.pathname === "/sessions") {
      if (!runtime.config.mcp.enableDebugRoutes) {
        writeText(res, 404, "Not found");
        return;
      }

      if (!isAuthorized(req, runtime.config.mcp.bearerToken)) {
        runtime.logger.warn("Unauthorized sessions HTTP request rejected", {
          method,
          path: requestUrl.pathname,
          remoteAddress: req.socket.remoteAddress,
        });
        writeText(res, 401, "Unauthorized");
        return;
      }

      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return;
      }

      const sessions = await runtime.sessionStore.listSessions();
      const payload = await Promise.all(
        sessions
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
          .map(async (session) => {
            const binding = await runtime.bindingStore.getBinding(
              session.sessionId,
            );

            return {
              session_id: session.sessionId,
              session_label: session.label ?? null,
              updated_at: session.updatedAt,
              binding: binding
                ? {
                    telegram_chat_id: binding.telegramChatId,
                    telegram_user_id: binding.telegramUserId,
                    linked_at: binding.linkedAt,
                  }
                : null,
              terminal: {
                terminal_target: session.terminalTarget ?? null,
                last_nudge_at: session.lastTerminalNudgeAt ?? null,
              },
            };
          }),
      );

      writeJson(res, 200, {
        total: payload.length,
        sessions: payload,
      });
      return;
    }

    if (requestUrl.pathname === "/prune") {
      if (!runtime.config.mcp.enablePruneRoute) {
        writeText(res, 404, "Not found");
        return;
      }

      if (!isAuthorized(req, runtime.config.mcp.bearerToken)) {
        runtime.logger.warn("Unauthorized prune HTTP request rejected", {
          method,
          path: requestUrl.pathname,
          remoteAddress: req.socket.remoteAddress,
        });
        writeText(res, 401, "Unauthorized");
        return;
      }

      if (method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return;
      }

      const result = await runtime.maintenanceStore.pruneAll();
      let gatewayDeleted: Record<string, number> | null = null;
      if (
        runtime.config.distributed.mode === "gateway" ||
        runtime.config.distributed.mode === "both"
      ) {
        try {
          const gatewayResult = await runtime.callBroker<{
            deleted?: Record<string, number>;
          }>("telegramMcp.gateway.pruneGatewayState", {}, {
            meta: { internal_call: true },
          });
          gatewayDeleted =
            gatewayResult?.deleted && typeof gatewayResult.deleted === "object"
              ? gatewayResult.deleted
              : null;
        } catch (error) {
          runtime.logger.warn("Gateway DB prune failed through HTTP endpoint", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      runtime.logger.warn("MCP service state pruned through HTTP endpoint", {
        deletedKeys: result.deletedKeys,
        gatewayDeleted,
        remoteAddress: req.socket.remoteAddress,
      });

      writeJson(res, 200, {
        ok: true,
        deleted_keys: result.deletedKeys,
        ...(gatewayDeleted ? { gateway_deleted: gatewayDeleted } : {}),
      });
      return;
    }

    if (
      requestUrl.pathname !== mcpHttpPath &&
      requestUrl.pathname !== `${mcpHttpPath}/`
    ) {
      writeText(res, 404, "Not found");
      return;
    }

    const authorizationMode = resolveMcpHttpAuthorization(
      req,
      runtime.config.mcp.bearerToken,
      oauthFacade,
    );
    if (!authorizationMode) {
      const authorizationHeader = readHeader(req, "authorization");
      runtime.logger.warn("Unauthorized MCP HTTP request rejected", {
        method,
        path: requestUrl.pathname,
        remoteAddress: req.socket.remoteAddress,
        authorizationHeaderPresent: Boolean(authorizationHeader),
        authorizationScheme: authorizationHeader?.split(/\s+/u, 1)[0],
      });
      oauthFacade?.writeMcpChallenge(res);
      writeText(res, 401, "Unauthorized");
      return;
    }

    const sessionId = readHeader(req, "mcp-session-id");
    const parsedBody =
      method === "POST" || method === "DELETE"
        ? await readJsonBody(req)
        : undefined;
    const rpcMethod = readMcpRpcMethod(parsedBody);

    runtime.logger.debug("MCP HTTP request received", {
      method,
      path: requestUrl.pathname,
      sessionId,
      authorizationMode,
      rpcMethod,
      hasBody: parsedBody !== undefined,
    });
    if (rpcMethod === "initialize" || rpcMethod === "tools/list") {
      runtime.logger.info("Chat connector MCP handshake request received", {
        rpcMethod,
        authorizationMode,
        sessionId,
        userAgent: readHeader(req, "user-agent"),
      });
      res.once("finish", () => {
        runtime.logger.info("Chat connector MCP handshake response completed", {
          rpcMethod,
          authorizationMode,
          statusCode: res.statusCode,
          sessionId:
            readHeader(req, "mcp-session-id") ??
            (String(res.getHeader("mcp-session-id") ?? "") || undefined),
          contentType: String(res.getHeader("content-type") ?? ""),
        });
      });
    }

    try {
      if (method === "POST") {
        if (sessionId) {
          const entry = transports.get(sessionId);
          if (!entry) {
            writeJson(res, 404, {
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: "Unknown MCP session",
              },
              id: null,
            });
            return;
          }

          await entry.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Initialization request is required for a new session",
            },
            id: null,
          });
          return;
        }

        const entryRef: { current: SessionEntry | null } = { current: null };
        let knownSessionId: string | undefined;
        let closing = false;
        let closePromise: Promise<void> | null = null;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            knownSessionId = createdSessionId;
            if (entryRef.current) {
              transports.set(createdSessionId, entryRef.current);
              runtime.logger.info("MCP HTTP session initialized", {
                sessionId: createdSessionId,
              });
            }
          },
        });
        const server = input.createMcpServer();
        const closeEntry = async (
          initiator: "app" | "transport",
        ): Promise<void> => {
          if (closing) {
            return closePromise ?? Promise.resolve();
          }

          closing = true;
          if (closePromise) {
            return closePromise;
          }

          closePromise = (async () => {
            transport.onclose = () => {};
            if (knownSessionId) {
              transports.delete(knownSessionId);
              runtime.logger.info("MCP HTTP session closed", {
                sessionId: knownSessionId,
                initiator,
              });
            }

            if (initiator === "app") {
              await transport.close();
            }

            await server.close();
          })();

          return closePromise;
        };
        entryRef.current = {
          server,
          transport,
          close: () => closeEntry("app"),
        };
        transport.onclose = () => {
          void closeEntry("transport");
        };
        transport.onerror = (error) => {
          if (isDuplicateSseStreamError(error)) {
            runtime.logger.warn(
              "Duplicate MCP SSE stream reported by transport",
              {
                sessionId: knownSessionId,
              },
            );
            return;
          }

          runtime.logger.error("MCP HTTP transport error", {
            sessionId: knownSessionId,
            error: error.stack ?? error.message,
          });
        };

        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (method === "GET" || method === "DELETE") {
        if (!sessionId) {
          writeText(res, 400, "Missing MCP session ID");
          return;
        }

        const entry = transports.get(sessionId);
        if (!entry) {
          writeText(res, 404, "Unknown MCP session");
          return;
        }

        try {
          await entry.transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          if (method === "GET" && isDuplicateSseStreamError(error)) {
            runtime.logger.warn("Duplicate MCP SSE stream detected, closing stale session", {
              sessionId,
            });
            await closeSessionEntry(entry);
            transports.delete(sessionId);
            if (!res.headersSent) {
              writeText(
                res,
                409,
                "Duplicate SSE stream for MCP session. Reconnect and initialize a fresh session.",
              );
            }
            return;
          }

          throw error;
        }
        return;
      }

      writeText(res, 405, "Method not allowed");
    } catch (error) {
      runtime.logger.error("Error handling MCP HTTP request", {
        method,
        path: requestUrl.pathname,
        sessionId,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });

      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    try {
      await handleRequestInternal(req, res, pathname);
    } catch (error) {
      if (!isBodySizeLimitError(error)) {
        throw error;
      }
      if (!res.headersSent) {
        writeJson(res, 413, {
          error: `Request body exceeds the ${MAX_BODY_SIZE} MiB limit`,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };

  let shuttingDown = false;

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    pathname: string,
  ): Promise<boolean> => {
    const normalizedPathname = normalizePrefixedPathname(pathname);
    if (
      normalizedPathname !== `${webAppBasePath}/api/live/ws` &&
      normalizedPathname !== "/gateway/live/ws"
    ) {
      return false;
    }

    liveWsServer.handleUpgrade(req, socket, head, (clientSocket: LiveWebSocket) => {
      liveWsServer.emit("connection", clientSocket, req);
    });
    return true;
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.logger.info("MCP HTTP handler shutdown requested");
    await Promise.all(
      Array.from(transports.values()).map((entry) => closeSessionEntry(entry)),
    );
    transports.clear();
    await new Promise<void>((resolve, reject) => {
      liveWsServer.close((error: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return {
    handleRequest,
    handleUpgrade,
    close: shutdown,
  };
}
type LiveWebSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (
    event: "close" | "error" | "message",
    listener: (payload?: unknown) => void,
  ) => void;
};

type LiveWebSocketServer = {
  on: (
    event: "connection",
    listener: (socket: LiveWebSocket, req: IncomingMessage) => void,
  ) => void;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    callback: (clientSocket: LiveWebSocket) => void,
  ) => void;
  emit: (
    event: "connection",
    socket: LiveWebSocket,
    req: IncomingMessage,
  ) => void;
  close: (callback: (error?: unknown) => void) => void;
};

const wsLib = ws as unknown as {
  WebSocketServer: new (options: Record<string, unknown>) => LiveWebSocketServer;
};
const WebSocketServer = wsLib.WebSocketServer;
