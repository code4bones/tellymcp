import { randomUUID } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { AppRuntime } from "./bootstrap/runtime";
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
  captureVisibleTmuxPane,
  isTmuxUnavailableError,
  sendAllowedTmuxAction,
} from "./webapp/tmux";

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
  close: () => Promise<void>;
};

function formatTmuxHttpError(error: unknown, fallback: string): string {
  if (isTmuxUnavailableError(error)) {
    return "tmux is unavailable";
  }

  return fallback;
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const method = Reflect.get(body, "method");
  return method === "initialize";
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
    return knownParams;
  }

  const knownBody = (req as IncomingMessage & { body?: unknown }).body;
  if (knownBody !== undefined) {
    return knownBody;
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

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isRelayTmuxUnavailableMessage(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("tmux is unavailable");
}

export function createMcpHttpHandler(
  runtime: AppRuntime,
  input: {
    createMcpServer: () => McpServer;
  },
): McpHttpHandler {
  const transports = new Map<string, SessionEntry>();
  const webAppSessions = new WebAppSessionRegistry();
  const webAppBasePath =
    runtime.config.webapp.basePath.replace(/\/+$/u, "") || "/webapp";
  const rootPrefix = normalizeBasePath(process.env.ROOT_PREFIX || "/api");
  const publicWebAppBasePath =
    rootPrefix === "/"
      ? webAppBasePath
      : `${rootPrefix}${normalizeBasePath(webAppBasePath)}`;
  const webAppLivePrefix = `${webAppBasePath}/live/`;

  const closeSessionEntry = async (entry: SessionEntry): Promise<void> => {
    await entry.close();
  };

  const handleRequest = async (
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

    if (requestUrl.pathname === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        service: "telegram-human-mcp",
        transport: "streamable-http",
      });
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

        writeHtml(
          res,
          200,
          renderWebAppHtml({
            basePath: publicWebAppBasePath,
            launchMode: runtime.config.webapp.launchMode,
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

        const body = await readJsonBody(req).catch(() => undefined);
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
                  runtime.config.telegram.botToken,
                  runtime.config.webapp.initDataTtlSeconds,
                );
                trustedTelegramUserId = validated.user.id;
                runtime.webAppLaunchRegistry.deleteByUserId(validated.user.id);
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
                ...(relayTarget.sourceClientUuid &&
                relayTarget.sourceClientUuid !== relayTarget.clientUuid
                  ? { allowForeignBinding: true }
                  : {}),
                initDataRaw,
                initDataUnsafe,
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
              tmux_target: relayBootstrap.tmux_target,
              poll_interval_ms: relayBootstrap.poll_interval_ms,
              expires_at: new Date(record.expiresAtMs).toISOString(),
            });
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
            runtime.config.telegram.botToken,
            runtime.config.webapp.initDataTtlSeconds,
          );
          runtime.logger.info("Telegram WebApp initData validation debug", {
            sessionId: sessionId || null,
            telegramUserId: validated.user.id,
            providedHash: validated.validationDebug.providedHash,
            officialRawMatches: validated.validationDebug.officialRaw.matches,
            officialRawCheckString: validated.validationDebug.officialRaw.checkString,
            officialRawComputedHash:
              validated.validationDebug.officialRaw.computedHash,
            userFieldsMatches:
              validated.validationDebug.userFields?.matches ?? null,
            userFieldsCheckString:
              validated.validationDebug.userFields?.checkString ?? null,
            userFieldsComputedHash:
              validated.validationDebug.userFields?.computedHash ?? null,
          });
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
            hasTmuxTarget: Boolean(session?.tmuxTarget),
          });
          runtime.webAppLaunchRegistry.deleteByUserId(validated.user.id);

          writeJson(res, 200, {
            token: record.token,
            session_id: sessionId,
            session_label: session?.label ?? null,
            tmux_target: Boolean(session?.tmuxTarget),
            poll_interval_ms: runtime.config.webapp.pollIntervalMs,
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
            initDataPreview: initDataRaw.slice(0, 160),
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

      if (requestUrl.pathname === `${webAppBasePath}/api/view`) {
        if (method !== "GET") {
          writeText(res, 405, "Method not allowed");
          return;
        }

        const token = readBearerToken(req);
        const webAppSession = token ? webAppSessions.get(token) : null;
        if (!webAppSession) {
          writeText(res, 401, "Unauthorized");
          return;
        }

        const relayTarget = parseLiveRelaySessionId(webAppSession.sessionId);
        if (relayTarget) {
          try {
            const result = await runtime.gatewayHttpService.requestLiveRelayView({
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
            });
            writeJson(res, 200, result);
          } catch (error) {
            runtime.logger.error("Telegram WebApp relay visible buffer capture failed", {
              sessionId: webAppSession.sessionId,
              clientUuid: relayTarget.clientUuid,
              localSessionId: relayTarget.localSessionId,
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
            });
            writeText(
              res,
              isRelayTmuxUnavailableMessage(error) ? 503 : 500,
              error instanceof Error ? error.message : "Failed to capture relay tmux pane",
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
        if (!session?.tmuxTarget) {
          writeText(res, 409, "tmux target is not configured for this session");
          return;
        }

        try {
          const content = await captureVisibleTmuxPane(
            runtime.config.tmux,
            session.tmuxTarget,
            runtime.config.tmux.captureLines,
            runtime.config.webapp.visibleScreens,
          );
          writeJson(res, 200, {
            session_id: session.sessionId,
            session_label: session.label ?? null,
            captured_at: new Date().toISOString(),
            content,
          });
        } catch (error) {
          runtime.logger.error("Telegram WebApp visible buffer capture failed", {
            sessionId: webAppSession.sessionId,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
          writeText(
            res,
            isTmuxUnavailableError(error) ? 503 : 500,
            formatTmuxHttpError(error, "Failed to capture visible tmux pane"),
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

        const body = await readJsonBody(req).catch(() => undefined);
        const action =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "action") === "string"
            ? String(Reflect.get(body, "action"))
            : "";
        if (!["up", "down", "enter", "slash", "delete", "tab", "escape", "interrupt"].includes(action)) {
          writeText(res, 400, "Unsupported action");
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
                | "interrupt",
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
              isRelayTmuxUnavailableMessage(error) ? 503 : 500,
              error instanceof Error ? error.message : "Failed to send relay tmux action",
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
        if (!session?.tmuxTarget) {
          writeText(res, 409, "tmux target is not configured for this session");
          return;
        }

        try {
          await sendAllowedTmuxAction(
            runtime.config.tmux,
            session.tmuxTarget,
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
          webAppSessions.touchAction(webAppSession.token, nowMs);
          runtime.logger.info("Telegram WebApp action sent to tmux", {
            sessionId: webAppSession.sessionId,
            telegramUserId: webAppSession.telegramUserId,
            action,
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
            isTmuxUnavailableError(error) ? 503 : 500,
            formatTmuxHttpError(error, "Failed to send tmux action"),
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
            const inboxCount = await runtime.inboxStore.countInboxMessages(
              session.sessionId,
            );

            return {
              session_id: session.sessionId,
              session_label: session.label ?? null,
              updated_at: session.updatedAt,
              inbox_count: inboxCount,
              binding: binding
                ? {
                    telegram_chat_id: binding.telegramChatId,
                    telegram_user_id: binding.telegramUserId,
                    linked_at: binding.linkedAt,
                  }
                : null,
              tmux: {
                tmux_session_name: session.tmuxSessionName ?? null,
                tmux_window_name: session.tmuxWindowName ?? null,
                tmux_window_index:
                  typeof session.tmuxWindowIndex === "number"
                    ? session.tmuxWindowIndex
                    : null,
                tmux_pane_id: session.tmuxPaneId ?? null,
                tmux_pane_index:
                  typeof session.tmuxPaneIndex === "number"
                    ? session.tmuxPaneIndex
                    : null,
                tmux_target: session.tmuxTarget ?? null,
                last_nudge_at: session.lastTmuxNudgeAt ?? null,
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
      runtime.logger.warn("MCP service state pruned through HTTP endpoint", {
        deletedKeys: result.deletedKeys,
        remoteAddress: req.socket.remoteAddress,
      });

      writeJson(res, 200, {
        ok: true,
        deleted_keys: result.deletedKeys,
      });
      return;
    }

    if (requestUrl.pathname !== runtime.config.mcp.httpPath) {
      writeText(res, 404, "Not found");
      return;
    }

    if (!isAuthorized(req, runtime.config.mcp.bearerToken)) {
      runtime.logger.warn("Unauthorized MCP HTTP request rejected", {
        method,
        path: requestUrl.pathname,
        remoteAddress: req.socket.remoteAddress,
      });
      writeText(res, 401, "Unauthorized");
      return;
    }

    const sessionId = readHeader(req, "mcp-session-id");
    const parsedBody =
      method === "POST" || method === "DELETE"
        ? await readJsonBody(req)
        : undefined;

    runtime.logger.debug("MCP HTTP request received", {
      method,
      path: requestUrl.pathname,
      sessionId,
      hasBody: parsedBody !== undefined,
    });

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

  let shuttingDown = false;

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
  };

  return {
    handleRequest,
    close: shutdown,
  };
}
