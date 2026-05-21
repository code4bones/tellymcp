import { Buffer } from "node:buffer";

import { InlineKeyboard, InputFile } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { SessionContext } from "../../../entities/session/model/types";
import { type SupportedLocale } from "../../i18n";
import type {
  AdminClientSessionViewRecord,
  AdminClientViewRecord,
  GatewayConnectedClientRecord,
  GatewayRelayBindingPayload,
  SendMessageMeta,
  TelegramMenuContext,
} from "./transportTypes";
import {
  buildAdminClientSessionViewButtonLabel,
} from "./transportFormatting";
import {
  buildAdminClientsMenuText,
  mergeGatewayAdminClientSessions,
} from "./transportAdminView";
import {
  buildAdminMainMenuText,
  buildAdminClientSessionDetailText,
  buildAdminClientSessionListText,
  buildAdminClientSessionsMenuText,
  buildAdminToolsMenuText,
} from "./transportMenuText";
import { buildAdminClientTitle, buildPrincipalKey, escapeHtml } from "./transportUtils";

export interface TransportAdminHost {
  config: AppConfig;
  adminClientViewByPrincipal: Map<string, AdminClientViewRecord>;
  adminMainMenu: unknown;
  adminClientsMenu: unknown;
  adminClientSessionsMenu: unknown;
  adminToolsMenu: unknown;
  liveActions: {
    buildUrl(input: {
      targetSessionId: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
      sourceClientUuid?: string;
      launchMode?: "fullscreen" | "expand" | "default";
    }): string | null;
    buildKeyboard(
      getUrl: (mode: "fullscreen" | "expand" | "default") => string | null,
      locale?: SupportedLocale,
    ): InlineKeyboard;
  };
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(ctx: TelegramMenuContext):
    | { telegramChatId: number; telegramUserId: number }
    | null;
  t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string;
  tForContext(ctx: TelegramMenuContext, key: string): Promise<string>;
  listGatewayAdminClients(): Promise<AdminClientViewRecord[]>;
  listGatewayClientSessions(clientUuid: string): Promise<AdminClientSessionViewRecord[]>;
  listGatewayConnectedClients(): Promise<GatewayConnectedClientRecord[]>;
  createAdminClientSessionMenuPayload(
    session: AdminClientSessionViewRecord,
  ): Promise<string>;
  renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: unknown,
  ): Promise<void>;
  editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options?: {
      parse_mode?: "HTML";
      reply_markup?: InlineKeyboard;
    },
  ): Promise<void>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options?: {
      parse_mode?: "HTML";
      reply_markup?: InlineKeyboard;
    },
  ): Promise<{ message_id: number } | void>;
  replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: Parameters<TelegramMenuContext["replyWithDocument"]>[1],
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
  ): Promise<void>;
  showAdminClientsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  getAdminClientSessionPayloadByKey(
    payloadKey: string,
  ): Promise<GatewayRelayBindingPayload | null>;
  getMenuPayloadByKey(
    payloadKey: string,
  ): Promise<{ kind?: string | undefined; targetClientUuid?: string | undefined } | null>;
  extractCallbackSuffix(ctx: TelegramMenuContext, prefix: string): string | null;
  bindRelaySessionToPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
    payload: GatewayRelayBindingPayload;
  }): Promise<SessionContext>;
  webAppLaunchRegistry: {
    set(
      telegramUserId: number,
      sessionId: string,
      ttlSeconds: number,
      value: {
        telegramChatId: number;
        telegramMessageId?: number;
        allowForeignBinding?: boolean;
      },
    ): void;
  };
}

export class TransportAdminActions {
  public constructor(private readonly host: TransportAdminHost) {}

  public async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.adminMainMenu,
    );
  }

  public async buildMainMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    let clients: AdminClientViewRecord[] | null = null;
    try {
      clients = await this.host.listGatewayAdminClients();
    } catch {
      clients = null;
    }
    return buildAdminMainMenuText({
      title: this.host.t(locale, "menu:admin.screen.title"),
      gatewayClientsLine: clients
        ? this.host.t(locale, "menu:admin.screen.gateway_clients", {
            count: clients.length,
          })
        : null,
      connectedClientsLine: clients
        ? this.host.t(locale, "menu:admin.screen.gateway_clients_connected", {
            count: clients.filter((client) => client.is_connected).length,
          })
        : null,
      registeredClientsLine: clients
        ? this.host.t(locale, "menu:admin.screen.gateway_clients_registered", {
            count: clients.filter((client) => client.is_registered).length,
          })
        : null,
      unavailableLine: clients
        ? null
        : this.host.t(locale, "menu:admin.screen.gateway_clients_unavailable"),
      hintLine: this.host.t(locale, "menu:admin.screen.hint"),
    });
  }

  public async showClientsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildClientsMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.adminClientsMenu,
    );
  }

  public async showClientSessionsMenu(
    ctx: TelegramMenuContext,
    client?: AdminClientViewRecord,
  ): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await this.host.showAdminClientsMenu(ctx);
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    if (client) {
      this.host.adminClientViewByPrincipal.set(principalKey, client);
    }

    const selectedClient = this.host.adminClientViewByPrincipal.get(principalKey);
    if (!selectedClient) {
      await this.host.showAdminClientsMenu(
        ctx,
        await this.host.tForContext(ctx, "menu:admin.client_sessions.no_client_selected"),
      );
      return;
    }

    const text = await this.buildClientSessionsMenuText(ctx, selectedClient);
    await this.host.renderMenuHtmlScreen(
      ctx,
      text,
      { kind: "menu" },
      this.host.adminClientSessionsMenu,
    );
  }

  public async showClientSessionDetail(
    ctx: TelegramMenuContext,
    input: GatewayRelayBindingPayload,
    payloadKey: string,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const text = buildAdminClientSessionDetailText({
      title: this.host.t(locale, "menu:admin.client_session_detail.title"),
      sessionLine: this.host.t(locale, "menu:admin.client_session_detail.session", {
        sessionName: escapeHtml(input.targetSessionLabel),
      }),
      localSessionId: escapeHtml(input.targetLocalSessionId),
      projectLine: input.projectName
        ? this.host.t(locale, "menu:admin.client_session_detail.project", {
            projectName: escapeHtml(input.projectName),
          })
        : null,
    });

    const keyboard = new InlineKeyboard();
    keyboard.text(
      this.host.t(locale, "menu:admin.client_session_detail.bind"),
      `admin-client-session-bind:${payloadKey}`,
    );
    if (
      this.host.liveActions.buildUrl({
        targetSessionId: input.targetSessionId,
        targetClientUuid: input.targetClientUuid,
        targetLocalSessionId: input.targetLocalSessionId,
      })
    ) {
      keyboard.text("🖥 Live", `admin-client-session-live:${payloadKey}`).row();
    } else {
      keyboard.row();
    }
    keyboard.text(
      this.host.t(locale, "menu:admin.client_session_detail.back_to_sessions"),
      "admin-client-sessions-back",
    );

    if (ctx.callbackQuery?.message) {
      await this.host.editText(
        ctx,
        text,
        { kind: "menu", sessionId: input.targetLocalSessionId },
        { parse_mode: "HTML", reply_markup: keyboard },
      );
      return;
    }

    await this.host.replyText(
      ctx,
      text,
      { kind: "menu", sessionId: input.targetLocalSessionId },
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  }

  public async buildClientsMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    let clients: AdminClientViewRecord[];
    try {
      clients = await this.host.listGatewayAdminClients();
    } catch {
      return [
        this.host.t(locale, "menu:admin.clients.title"),
        "",
        this.host.t(locale, "menu:admin.clients.unavailable"),
      ].join("\n");
    }
    return buildAdminClientsMenuText({
      title: this.host.t(locale, "menu:admin.clients.title"),
      empty: this.host.t(locale, "menu:admin.clients.empty"),
      connectedCountLabel: this.host.t(locale, "menu:admin.clients.connected_count", {
        count: clients.filter((client) => client.is_connected).length,
      }),
      registeredCountLabel: this.host.t(
        locale,
        "menu:admin.clients.registered_count",
        {
          count: clients.filter((client) => client.is_registered).length,
        },
      ),
      legend: this.host.t(locale, "menu:admin.clients.legend"),
      clients,
    });
  }

  public async buildClientSessionsMenuText(
    ctx: TelegramMenuContext,
    client: AdminClientViewRecord,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const clientTitle = buildAdminClientTitle(client);
    return buildAdminClientSessionsMenuText({
      title: this.host.t(locale, "menu:admin.client_sessions.title"),
      clientLine: this.host.t(locale, "menu:admin.client_sessions.client", {
        client: escapeHtml(clientTitle),
      }),
      chooseScopeLine: this.host.t(locale, "menu:admin.client_sessions.choose_scope"),
    });
  }

  public async listClientSessions(
    clientUuid: string,
    scope: "collab" | "all",
  ): Promise<AdminClientSessionViewRecord[]> {
    const collabSessions = await this.host.listGatewayClientSessions(clientUuid);
    const connectedClients =
      scope === "all" ? await this.host.listGatewayConnectedClients() : [];
    const connectedClient =
      scope === "all"
        ? connectedClients.find((client) => client.client_uuid === clientUuid) ?? null
        : null;

    return mergeGatewayAdminClientSessions({
      clientUuid,
      scope,
      collabSessions,
      connectedClient,
    });
  }

  public buildClientSessionViewButtonLabel(
    session: AdminClientSessionViewRecord,
  ): string {
    return buildAdminClientSessionViewButtonLabel(session);
  }

  public async showClientSessionList(
    ctx: TelegramMenuContext,
    scope: "collab" | "all",
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await this.host.showAdminClientsMenu(ctx);
      return;
    }

    const client = this.host.adminClientViewByPrincipal.get(buildPrincipalKey(principal));
    if (!client) {
      await this.host.showAdminClientsMenu(
        ctx,
        await this.host.tForContext(ctx, "menu:admin.client_sessions.no_client_selected"),
      );
      return;
    }

    let sessions: AdminClientSessionViewRecord[];
    try {
      sessions = await this.listClientSessions(client.client_uuid, scope);
    } catch {
      const text = [
        this.host.t(locale, "menu:admin.client_sessions.title"),
        "",
        this.host.t(locale, "menu:admin.client_sessions.unavailable"),
      ].join("\n");
      const replyMarkup = new InlineKeyboard().text(
        this.host.t(locale, "menu:admin.client_sessions.back_to_scope"),
        "admin-client-session-list-back",
      );
      if (ctx.callbackQuery?.message) {
        await this.host.editText(ctx, text, { kind: "menu" }, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } else {
        await this.host.replyText(
          ctx,
          text,
          { kind: "menu" },
          { parse_mode: "HTML", reply_markup: replyMarkup },
        );
      }
      return;
    }

    const titleKey =
      scope === "all"
        ? "menu:admin.client_sessions.scope_all"
        : "menu:admin.client_sessions.scope_collab";
    const text = buildAdminClientSessionListText({
      title: this.host.t(locale, "menu:admin.client_sessions.title"),
      scopeLine: this.host.t(locale, titleKey),
      clientLine: this.host.t(locale, "menu:admin.client_sessions.client", {
        client: escapeHtml(buildAdminClientTitle(client)),
      }),
      emptyLine:
        sessions.length === 0
          ? this.host.t(
              locale,
              scope === "all"
                ? "menu:admin.client_sessions.empty_all"
                : "menu:admin.client_sessions.empty",
            )
          : null,
      chooseLine:
        sessions.length > 0
          ? this.host.t(locale, "menu:admin.client_sessions.choose")
          : null,
    });

    const keyboard = new InlineKeyboard();
    for (const session of sessions) {
      const payloadKey = await this.host.createAdminClientSessionMenuPayload(session);
      keyboard
        .text(
          buildAdminClientSessionViewButtonLabel(session),
          `admin-client-session-open:${payloadKey}`,
        )
        .row();
    }
    keyboard.text(
      this.host.t(locale, "menu:admin.client_sessions.back_to_scope"),
      "admin-client-session-list-back",
    );

    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, { kind: "menu" }, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    }
    await this.host.replyText(ctx, text, { kind: "menu" }, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  public async showToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildToolsMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.adminToolsMenu,
    );
  }

  public async buildToolsMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    return buildAdminToolsMenuText({
      title: this.host.t(locale, "menu:admin.tools.title"),
      clientEnvHelpLine: this.host.t(locale, "menu:admin.tools.client_env_help"),
    });
  }

  public buildClientEnvFromGatewayConfig(): string {
    const config = this.host.config;
    const gatewayPublicUrl = config.distributed.gatewayPublicUrl ?? "";
    const gatewayWsUrl =
      config.distributed.gatewayWsUrl?.trim() ||
      (gatewayPublicUrl
        ? gatewayPublicUrl.replace(/^http/u, "ws").replace(/\/gateway$/u, "/gateway/ws")
        : "");
    const webappPublicUrl =
      config.webapp.publicUrl?.trim() ||
      (gatewayPublicUrl ? gatewayPublicUrl.replace(/\/gateway$/u, "/webapp") : "");
    const tokenBindingSecret =
      typeof process.env.TOKEN_BINDING_SECRET === "string"
        ? process.env.TOKEN_BINDING_SECRET.trim()
        : "";
    const nodeId =
      typeof process.env.NODE_ID === "string" && process.env.NODE_ID.trim()
        ? process.env.NODE_ID.trim()
        : "client";
    const namespace =
      typeof process.env.NAMESPACE === "string" && process.env.NAMESPACE.trim()
        ? process.env.NAMESPACE.trim()
        : "mcp";

    return [
      "# TellyMCP client node",
      "",
      "TELEGRAM_BOT_TOKEN=",
      "TELEGRAM_BOT_USERNAME=",
      "# DEBUG_LANGUAGE=ru",
      "PROJECT_NAME=",
      "",
      "REDIS_HOST=127.0.0.1",
      "REDIS_PORT=6379",
      "REDIS_DB=1",
      "",
      `MODE=${config.mode}`,
      `PAIR_CODE_TTL_SECONDS=${config.pairCodeTtlSeconds}`,
      "",
      "MCP_HTTP_HOST=127.0.0.1",
      "MCP_HTTP_PORT=8787",
      `MCP_HTTP_PATH=${config.mcp.httpPath}`,
      "# MCP_HTTP_BEARER_TOKEN=",
      `MCP_HTTP_ENABLE_DEBUG_ROUTES=${String(config.mcp.enableDebugRoutes)}`,
      `MCP_HTTP_ENABLE_PRUNE_ROUTE=${String(config.mcp.enablePruneRoute)}`,
      "",
      "DISTRIBUTED_MODE=client",
      `GATEWAY_PUBLIC_URL=${gatewayPublicUrl}`,
      `GATEWAY_WS_URL=${gatewayWsUrl}`,
      `GATEWAY_WS_PATH=${config.distributed.gatewayWsPath}`,
      "# GATEWAY_TOKEN=",
      `GATEWAY_TOKEN=${config.distributed.gatewayToken ?? ""}`,
      `GATEWAY_AUTH_TOKEN=${config.distributed.gatewayAuthToken ?? ""}`,
      "",
      `WEBAPP_ENABLED=${String(config.webapp.enabled)}`,
      `WEBAPP_BASE_PATH=${config.webapp.basePath}`,
      `WEBAPP_PUBLIC_URL=${webappPublicUrl}`,
      `WEBAPP_INITDATA_TTL_SECONDS=${config.webapp.initDataTtlSeconds}`,
      `WEBAPP_SESSION_TTL_SECONDS=${config.webapp.sessionTtlSeconds}`,
      `WEBAPP_LAUNCH_MODE=${config.webapp.launchMode}`,
      `WEBAPP_VISIBLE_SCREENS=${config.webapp.visibleScreens}`,
      `WEBAPP_POLL_INTERVAL_MS=${config.webapp.pollIntervalMs}`,
      `WEBAPP_ACTION_COOLDOWN_MS=${config.webapp.actionCooldownMs}`,
      "",
      "MCP_XCHANGE_DIR=.mcp-xchange",
      "",
      `TMUX_NUDGE_ENABLED=${String(config.tmux.nudgeEnabled)}`,
      `TMUX_NUDGE_DEBOUNCE_SECONDS=${config.tmux.nudgeDebounceSeconds}`,
      `TMUX_NUDGE_COOLDOWN_SECONDS=${config.tmux.nudgeCooldownSeconds}`,
      `TMUX_NUDGE_MESSAGE=${config.tmux.nudgeMessage}`,
      `TMUX_PARTNER_NUDGE_MESSAGE=${config.tmux.partnerNudgeMessage}`,
      `TMUX_CAPTURE_MODE=${config.tmux.captureMode}`,
      `TMUX_CAPTURE_LINES=${config.tmux.captureLines}`,
      `TMUX_PROMPT_SCAN_ENABLED=${String(config.tmux.promptScanEnabled)}`,
      `TMUX_PROMPT_SCAN_INTERVAL_SECONDS=${config.tmux.promptScanIntervalSeconds}`,
      `TMUX_PROMPT_SCAN_COOLDOWN_SECONDS=${config.tmux.promptScanCooldownSeconds}`,
      `TMUX_PROMPT_SCAN_STRATEGY=${config.tmux.promptScanStrategy}`,
      `TMUX_PROMPT_SCAN_MIN_SCORE=${config.tmux.promptScanMinScore}`,
      "# TMUX_SOCKET_PATH=",
      "",
      `BROWSER_ENABLED=${String(config.browser.enabled)}`,
      `BROWSER_HEADLESS=${String(config.browser.headless)}`,
      `BROWSER_DEVTOOLS=${String(config.browser.devtools)}`,
      `BROWSER_ADDRESS=${config.browser.address ?? "http://localhost:5173"}`,
      `BROWSER_TIMEOUT_MS=${config.browser.timeoutMs}`,
      `BROWSER_MAX_EVENTS=${config.browser.maxEvents}`,
      `BROWSER_WAIT_UNTIL=${config.browser.waitUntil}`,
      ...(config.browser.executablePath
        ? [`BROWSER_EXECUTABLE_PATH=${config.browser.executablePath}`]
        : ["# BROWSER_EXECUTABLE_PATH="]),
      ...(config.browser.channel
        ? [`BROWSER_CHANNEL=${config.browser.channel}`]
        : ["# BROWSER_CHANNEL=chrome"]),
      `BROWSER_SLOW_MO_MS=${config.browser.slowMoMs}`,
      "",
      `TELEGRAM_POLL_INTERVAL_MS=${config.telegram.pollIntervalMs}`,
      `TELEGRAM_DEFAULT_TIMEOUT_SECONDS=${config.telegram.defaultTimeoutSeconds}`,
      `TELEGRAM_MAX_CONTEXT_CHARS=${config.telegram.maxContextChars}`,
      `TELEGRAM_MAX_QUESTION_CHARS=${config.telegram.maxQuestionChars}`,
      `TELEGRAM_MAX_MESSAGE_CHARS=${config.telegram.maxMessageChars}`,
      `TELEGRAM_INBOX_BATCH_SIZE=${config.telegram.inboxBatchSize}`,
      `TELEGRAM_MENU_PAYLOAD_TTL_SECONDS=${config.telegram.menuPayloadTtlSeconds}`,
      "",
      "# PROXY_USE=http",
      "# HTTP_PROXY=",
      "# SOCKS5_PROXY=",
      "",
      `NAMESPACE=${namespace}`,
      `NODE_ID=${nodeId}`,
      "ENABLE_LOGFEED=0",
      `LOG_LEVEL=${config.logging.level}`,
      `LOG_FILE_ENABLED=${String(config.logging.fileEnabled)}`,
      `LOG_FILE_PATH=${config.logging.filePath}`,
      ...(tokenBindingSecret ? ["", `TOKEN_BINDING_SECRET=${tokenBindingSecret}`] : []),
      "",
    ].join("\n");
  }

  public async handleClientEnvExport(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const content = this.buildClientEnvFromGatewayConfig();
    await this.host.replyDocumentWithRetry(
      ctx,
      new InputFile(Buffer.from(content, "utf8"), ".env-client"),
      {
        caption: this.host.t(locale, "menu:admin.tools.client_env_caption"),
      },
      { kind: "menu" },
    );
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.tools.client_env_sent"),
      });
    }
  }

  public async handleClientSelectCallback(
    ctx: TelegramMenuContext,
    readMenuPayloadKey: (ctx: TelegramMenuContext) => string | null,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.getMenuPayloadByKey(payloadKey);
    const clientUuid =
      payload?.kind === "admin-client" && payload.targetClientUuid
        ? payload.targetClientUuid
        : null;
    if (!clientUuid) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    let clients: AdminClientViewRecord[];
    try {
      clients = await this.host.listGatewayAdminClients();
    } catch {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.clients.unavailable"),
        show_alert: true,
      });
      return;
    }

    const client = clients.find((item) => item.client_uuid === clientUuid);
    if (!client) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:admin.actions.open_client_sessions"),
    });
    await this.showClientSessionsMenu(ctx, client);
  }

  public async handleClientSessionOpenCallback(
    ctx: TelegramMenuContext,
    readMenuPayloadKey: (ctx: TelegramMenuContext) => string | null,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey =
      this.host.extractCallbackSuffix(ctx, "admin-client-session-open:") ??
      readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:admin.actions.open_client_session"),
    });
    await this.showClientSessionDetail(ctx, payload, payloadKey);
  }

  public async handleClientSessionLiveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(
      ctx,
      "admin-client-session-live:",
    );
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.identity_unavailable"),
        show_alert: true,
      });
      return;
    }

    const getUrl = (mode: "fullscreen" | "expand" | "default") =>
      this.host.liveActions.buildUrl({
        targetSessionId: payload.targetSessionId,
        targetClientUuid: payload.targetClientUuid,
        targetLocalSessionId: payload.targetLocalSessionId,
        launchMode: mode,
      });
    const defaultUrl = getUrl(this.host.config.webapp.launchMode);
    if (!defaultUrl) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.public_url_missing"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:live.actions.opening"),
    });

    const sent = await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:live.screen.launcher_title", {
          sessionName: payload.targetSessionLabel,
        }),
        "",
        this.host.t(locale, "menu:live.actions.choose_mode"),
      ].join("\n"),
      { kind: "menu", sessionId: payload.targetLocalSessionId },
      {
        reply_markup: this.host.liveActions.buildKeyboard(getUrl, locale),
      },
    );

    this.host.webAppLaunchRegistry.set(
      principal.telegramUserId,
      payload.targetLocalSessionId,
      this.host.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: principal.telegramChatId,
        allowForeignBinding: true,
        ...(sent && "message_id" in sent
          ? { telegramMessageId: sent.message_id }
          : {}),
      },
    );
  }

  public async handleClientSessionBindCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(
      ctx,
      "admin-client-session-bind:",
    );
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    await this.host.bindRelaySessionToPrincipal({
      principal,
      ctx,
      payload,
    });

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:admin.actions.open_client_session"),
    });
    await this.host.showMainMenu(
      ctx,
      this.host.t(locale, "menu:pairing.link_success", {
        sessionName: payload.targetSessionLabel,
      }),
    );
  }

}
