import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { Menu } from "@grammyjs/menu";
import { Bot, GrammyError, InputFile } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";
import type {
  SessionStore,
  TelegramAdminAuthStore,
  SessionBindingStore,
  TelegramMenuPayloadStore,
  TelegramUserLocaleStore,
  TelegramXchangeFileMetaStore,
  MaintenanceStore,
} from "../../api/storage/contract";
import type {
  HumanTransportNotification,
  HumanTransport,
  HumanTransportReply,
  HumanTransportRequest,
} from "../../api/transport/contract";
import type { Logger } from "../../lib/logger/logger";
import { writeLocalTaskXchangeRecord } from "../../lib/telegramXchangeRecords";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import { isExecutorTargetKind } from "./collabSemantics";
import type {
  AdminGatewayRegistrationSessionRecord,
  CurrentAttachmentTargetRecord,
  LiveApprovalEventPayload,
  PendingBroadcastRecord,
  PendingFileHandoffRecord,
  PendingPartnerNoteRecord,
  PendingProjectRecord,
  PendingRenameRecord,
  TelegramClientFetch,
  TelegramEditMessageOptions,
  TelegramMenuContext,
  WaiterRecord,
} from "./transportTypes";
import { parsePartnerNoteText } from "./transportFormatting";
import { TransportLiveActions } from "./transportLiveActions";
import { TransportLifecycleActions } from "./transportLifecycleActions";
import { TransportAttachmentStore } from "./transportAttachmentStore";
import { TransportBroadcastActions } from "./transportBroadcastActions";
import { TransportDocumentActions } from "./transportDocumentActions";
import { TransportContext } from "./transportContext";
import { TransportEventActions } from "./transportEventActions";
import { TransportFileHandoffActions } from "./transportFileHandoffActions";
import { TransportMenuFactories } from "./transportMenuFactories";
import { TransportMenuFingerprints } from "./transportMenuFingerprints";
import { TransportMenuFlow } from "./transportMenuFlow";
import { TransportMenuShell } from "./transportMenuShell";
import { TransportGatewayActions } from "./transportGatewayActions";
import { TransportMessageFlow } from "./transportMessageFlow";
import { TransportMenuState } from "./transportMenuState";
import { TransportPayloadState } from "./transportPayloadState";
import { TransportProjectActions } from "./transportProjectActions";
import { TransportProjectEntryActions } from "./transportProjectEntryActions";
import { TransportProjectMenus } from "./transportProjectMenus";
import { TransportProjectEvents } from "./transportProjectEvents";
import { TransportProjectState } from "./transportProjectState";
import { TransportProjectView } from "./transportProjectView";
import { TransportMenuCallbacks } from "./transportMenuCallbacks";
import { TransportPartnerActions } from "./transportPartnerActions";
import { TransportRequestFlow } from "./transportRequestFlow";
import { TransportSessionActions } from "./transportSessionActions";
import { TransportTmuxActions } from "./transportTmuxActions";
import { TransportTmuxRuntime } from "./transportTmuxRuntime";
import { TransportXchangeState } from "./transportXchangeState";
import { TransportOutputActions } from "./transportOutputActions";
import { buildTransportConstructorWiring } from "./transportConstructorWiring";
import {
  resolveGatewayControlBaseUrl,
} from "./transportUtils";

export class TelegramTransport implements HumanTransport {
  private readonly telegramFetch: TelegramClientFetch;
  private readonly bot: Bot<TelegramMenuContext>;
  private readonly mainMenu: Menu<TelegramMenuContext>;
  private readonly storageMenu: Menu<TelegramMenuContext>;
  private readonly browserMenu: Menu<TelegramMenuContext>;
  private readonly projectsMenu: Menu<TelegramMenuContext>;
  private readonly collabToolsMenu: Menu<TelegramMenuContext>;
  private readonly collabDeleteMenu: Menu<TelegramMenuContext>;
  private readonly screenshotsMenu: Menu<TelegramMenuContext>;
  private readonly sessionsMenu: Menu<TelegramMenuContext>;
  private readonly bufferMenu: Menu<TelegramMenuContext>;
  private readonly settingsMenu: Menu<TelegramMenuContext>;
  private readonly developerMenu: Menu<TelegramMenuContext>;
  private readonly unpairConfirmMenu: Menu<TelegramMenuContext>;
  private readonly pruneConfirmMenu: Menu<TelegramMenuContext>;
  private readonly storageMessageMenu: Menu<TelegramMenuContext>;
  private readonly screenshotMessageMenu: Menu<TelegramMenuContext>;
  private readonly tmuxActions: TransportTmuxActions;
  private readonly liveActions: TransportLiveActions;
  private readonly lifecycleActions: TransportLifecycleActions;
  private readonly attachmentStore: TransportAttachmentStore;
  private readonly broadcastActions: TransportBroadcastActions;
  private readonly context: TransportContext;
  private readonly documentActions: TransportDocumentActions;
  private readonly eventActions: TransportEventActions;
  private readonly partnerActions: TransportPartnerActions;
  private readonly fileHandoffActions: TransportFileHandoffActions;
  private readonly menuFactories: TransportMenuFactories;
  private readonly menuFingerprints: TransportMenuFingerprints;
  private readonly menuFlow: TransportMenuFlow;
  private readonly menuShell: TransportMenuShell;
  private readonly gatewayActions: TransportGatewayActions;
  private readonly messageFlow: TransportMessageFlow;
  private readonly menuCallbacks: TransportMenuCallbacks;
  private readonly menuState: TransportMenuState;
  private readonly payloadState: TransportPayloadState;
  private readonly projectMenus: TransportProjectMenus;
  private readonly projectEvents: TransportProjectEvents;
  private readonly projectState: TransportProjectState;
  private readonly projectView: TransportProjectView;
  private readonly projectActions: TransportProjectActions;
  private readonly projectEntryActions: TransportProjectEntryActions;
  private readonly requestFlow: TransportRequestFlow;
  private readonly sessionActions: TransportSessionActions;
  private readonly outputActions: TransportOutputActions;
  private readonly tmuxRuntime: TransportTmuxRuntime;
  private readonly xchangeState: TransportXchangeState;
  private readonly waiters = new Map<string, WaiterRecord>();
  private readonly tmuxNudgeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly tmuxNudgeFailureNoticeAt = new Map<string, number>();
  private readonly tmuxPromptNoticeState = new Map<
    string,
    { fingerprint: string; sentAtMs: number }
  >();
  private readonly pendingRenames = new Map<string, PendingRenameRecord>();
  private readonly pendingBroadcasts = new Map<string, PendingBroadcastRecord>();
  private readonly pendingPartnerNotes = new Map<string, PendingPartnerNoteRecord>();
  private readonly pendingFileHandoffs = new Map<string, PendingFileHandoffRecord>();
  private readonly pendingProjects = new Map<string, PendingProjectRecord>();
  private readonly currentAttachmentTargets = new Map<
    string,
    CurrentAttachmentTargetRecord
  >();
  private started = false;
  private pollingTask: Promise<void> | undefined;
  private collaborationService?: CollaborationService;
  private tmuxPromptScanTimer: NodeJS.Timeout | undefined;
  private tmuxPromptScanInFlight = false;

  private isTelegramEnabled(): boolean {
    if (this.config.distributed.mode === "client") {
      return false;
    }
    return Boolean(this.config.telegram.botToken?.trim());
  }

  private ensureTelegramEnabledFor(action: string): void {
    if (this.isTelegramEnabled()) {
      return;
    }

    throw new Error(
      `Telegram transport is disabled for this node; cannot ${action}.`,
    );
  }

  private getRequiredBotToken(action: string): string {
    this.ensureTelegramEnabledFor(action);
    return this.config.telegram.botToken!.trim();
  }

  private createMenuOptions(
    handler: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> } {
    return {
      onMenuOutdated: async (ctx) => {
        this.logger.debug("Telegram menu outdated, refreshing", {
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
          menuId: ctx.callbackQuery?.data ?? "unknown",
        });
        await ctx.answerCallbackQuery({
          text: await this.context.tForContext(ctx, "common:menu.refreshed"),
        });
        await handler(ctx);
      },
    };
  }

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly adminAuthStore: TelegramAdminAuthStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly menuPayloadStore: TelegramMenuPayloadStore,
    private readonly localeStore: TelegramUserLocaleStore,
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly objectStore: MinioExchangeStore,
    private readonly webAppLaunchRegistry: WebAppLaunchRegistry,
    private readonly logger: Logger,
  ) {
    const composition = buildTransportConstructorWiring({
      config: this.config,
      sessionStore: this.sessionStore,
      adminAuthStore: this.adminAuthStore,
      bindingStore: this.bindingStore,
      menuPayloadStore: this.menuPayloadStore,
      localeStore: this.localeStore,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      maintenanceStore: this.maintenanceStore,
      objectStore: this.objectStore,
      webAppLaunchRegistry: this.webAppLaunchRegistry,
      logger: this.logger,
      waiters: this.waiters,
      tmuxNudgeDebounceTimers: this.tmuxNudgeDebounceTimers,
      tmuxNudgeFailureNoticeAt: this.tmuxNudgeFailureNoticeAt,
      tmuxPromptNoticeState: this.tmuxPromptNoticeState,
      pendingRenames: this.pendingRenames,
      pendingBroadcasts: this.pendingBroadcasts,
      pendingPartnerNotes: this.pendingPartnerNotes,
      pendingFileHandoffs: this.pendingFileHandoffs,
      pendingProjects: this.pendingProjects,
      currentAttachmentTargets: this.currentAttachmentTargets,
      getCollaborationService: () => this.collaborationService,
      createMenuOptions: (handler) => this.createMenuOptions(handler),
      getRequiredBotToken: (action) => this.getRequiredBotToken(action),
      deleteMessage: (telegramChatId, telegramMessageId) =>
        this.deleteMessage(telegramChatId, telegramMessageId),
      sendDocumentToChat: (telegramChatId, filePath, caption) =>
        this.sendDocumentToChat(telegramChatId, filePath, caption),
      sendNotification: (input) => this.sendNotification(input),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
      maybeNotifyToolsMismatchForSession: (sessionId) =>
        this.maybeNotifyToolsMismatchForSession(sessionId),
      callGatewayJson: (endpointPath, body) => this.callGatewayJson(endpointPath, body),
      isAdminAuthEnabled: () => this.isAdminAuthEnabled(),
      isAdminBotProfile: () => this.isAdminBotProfile(),
      isPrincipalAdminAuthorized: (principal) =>
        this.isPrincipalAdminAuthorized(principal),
      setPrincipalAdminAuthorized: (principal) =>
        this.setPrincipalAdminAuthorized(principal),
      ensureGatewayUserForPrincipal: (input) =>
        this.ensureGatewayUserForPrincipal(input.principal, input.ctx),
    });
    this.telegramFetch = composition.telegramFetch;
    this.bot = composition.bot;
    this.mainMenu = composition.mainMenu;
    this.storageMenu = composition.storageMenu;
    this.browserMenu = composition.browserMenu;
    this.projectsMenu = composition.projectsMenu;
    this.collabToolsMenu = composition.collabToolsMenu;
    this.collabDeleteMenu = composition.collabDeleteMenu;
    this.screenshotsMenu = composition.screenshotsMenu;
    this.sessionsMenu = composition.sessionsMenu;
    this.bufferMenu = composition.bufferMenu;
    this.settingsMenu = composition.settingsMenu;
    this.developerMenu = composition.developerMenu;
    this.unpairConfirmMenu = composition.unpairConfirmMenu;
    this.pruneConfirmMenu = composition.pruneConfirmMenu;
    this.storageMessageMenu = composition.storageMessageMenu;
    this.screenshotMessageMenu = composition.screenshotMessageMenu;
    this.tmuxActions = composition.tmuxActions;
    this.liveActions = composition.liveActions;
    this.lifecycleActions = composition.lifecycleActions;
    this.attachmentStore = composition.attachmentStore;
    this.broadcastActions = composition.broadcastActions;
    this.context = composition.context;
    this.documentActions = composition.documentActions;
    this.eventActions = composition.eventActions;
    this.partnerActions = composition.partnerActions;
    this.fileHandoffActions = composition.fileHandoffActions;
    this.menuFactories = composition.menuFactories;
    this.menuFingerprints = composition.menuFingerprints;
    this.menuFlow = composition.menuFlow;
    this.menuShell = composition.menuShell;
    this.gatewayActions = composition.gatewayActions;
    this.messageFlow = composition.messageFlow;
    this.menuCallbacks = composition.menuCallbacks;
    this.menuState = composition.menuState;
    this.payloadState = composition.payloadState;
    this.projectMenus = composition.projectMenus;
    this.projectEvents = composition.projectEvents;
    this.projectState = composition.projectState;
    this.projectView = composition.projectView;
    this.projectActions = composition.projectActions;
    this.projectEntryActions = composition.projectEntryActions;
    this.requestFlow = composition.requestFlow;
    this.sessionActions = composition.sessionActions;
    this.outputActions = composition.outputActions;
    this.tmuxRuntime = composition.tmuxRuntime;
    this.xchangeState = composition.xchangeState;
    this.bot.use(this.getRootMenu());
    this.menuShell.register(this.bot);
  }

  private isAdminAuthEnabled(): boolean {
    return (
      this.isAdminBotProfile() &&
      Boolean(this.config.distributed.gatewayToken?.trim())
    );
  }

  private isAdminBotProfile(): boolean {
    return this.config.distributed.mode === "gateway";
  }

  private getRootMenu(): Menu<TelegramMenuContext> {
    return this.mainMenu;
  }

  private async isPrincipalAdminAuthorized(
    principal: { telegramChatId: number; telegramUserId: number } | null,
  ): Promise<boolean> {
    if (!this.isAdminAuthEnabled()) {
      return true;
    }
    if (!principal) {
      return false;
    }
    return this.adminAuthStore.isAdminAuthorized(principal);
  }

  private async setPrincipalAdminAuthorized(principal: {
    telegramChatId: number;
    telegramUserId: number;
  }): Promise<void> {
    await this.adminAuthStore.setAdminAuthorized(principal);
  }

  private async ensureGatewayUserForPrincipal(
    principal: { telegramChatId: number; telegramUserId: number },
    ctx: TelegramMenuContext,
  ): Promise<{ gateway_user_uuid: string }> {
    const actor = this.context.getGatewayActorFromContext(ctx);
    return this.callGatewayJson<{ gateway_user_uuid: string }>("/user/auth", {
      telegram_user_id: principal.telegramUserId,
      telegram_chat_id: principal.telegramChatId,
      ...(actor?.telegramUsername
        ? { telegram_username: actor.telegramUsername }
        : {}),
      ...(actor?.telegramDisplayName
        ? { telegram_display_name: actor.telegramDisplayName }
        : {}),
    });
  }

  public setCollaborationService(service: CollaborationService): void {
    this.collaborationService = service;
  }

  private async callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const baseUrl = resolveGatewayControlBaseUrl(this.config);
    if (!baseUrl) {
      throw new Error("Gateway is not configured.");
    }

    const url = new URL(baseUrl);
    url.pathname = `${url.pathname}${endpointPath}`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distributed.gatewayAuthToken
          ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || response.statusText);
    }

    return (await response.json()) as T;
  }

  public async start(): Promise<void> {
    if (this.started) {
      this.logger.debug(
        "Telegram transport start skipped because it is already running",
      );
      return;
    }

    if (!this.isTelegramEnabled()) {
      this.logger.info(
        "Telegram transport is disabled for this node; skipping bot startup",
        {
          distributedMode: this.config.distributed.mode,
        },
      );
      this.started = true;
      this.tmuxRuntime.startPromptScan();
      return;
    }

    this.logger.info("Telegram transport initialization started", {
      pollingTimeoutSeconds: 30,
      proxyEnabled: Boolean(this.config.telegram.proxy),
      proxyType: this.config.telegram.proxy?.type,
    });

    this.logger.debug("Telegram bot init started");
    await this.bot.init();
    this.logger.info("Telegram bot init completed", {
      botId: this.bot.botInfo.id,
      botUsername: this.bot.botInfo.username,
    });
    await this.bot.api.setMyCommands([
      { command: "menu", description: "Open console menu" },
      { command: "help", description: "Show help" },
    ]);
    this.logger.info("Telegram bot commands registered", {
      commands: ["/menu", "/help"],
    });

    this.logger.debug("Telegram polling start scheduled");
    this.pollingTask = this.bot.start({
      timeout: Math.max(
        1,
        Math.floor(this.config.telegram.pollIntervalMs / 1000),
      ),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      onStart: (botInfo) => {
        this.logger.info("Telegram polling entered running state", {
          botId: botInfo.id,
          botUsername: botInfo.username,
          isRunning: this.bot.isRunning(),
          isInited: this.bot.isInited(),
        });
      },
    });
    this.pollingTask.catch((error: unknown) => {
      this.logger.error("Telegram polling task crashed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
    this.started = true;
    this.tmuxRuntime.startPromptScan();
    this.logger.info("Telegram transport start returned control to app", {
      isRunning: this.bot.isRunning(),
      isInited: this.bot.isInited(),
    });
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      this.logger.debug(
        "Telegram transport stop skipped because it is not running",
      );
      return;
    }

    this.logger.info("Telegram transport stopping");
    this.tmuxRuntime.clearTmuxNudgeDebounceTimers();
    this.tmuxRuntime.clearTmuxPromptScanTimer();
    if (this.isTelegramEnabled()) {
      await this.bot.stop();
    }
    this.started = false;
    this.pollingTask = undefined;
    this.logger.info("Telegram transport stopped");
  }

  public async deleteMessage(
    telegramChatId: number,
    telegramMessageId: number,
  ): Promise<void> {
    this.ensureTelegramEnabledFor("delete Telegram messages");
    await this.bot.api.deleteMessage(telegramChatId, telegramMessageId);
  }

  public async sendDocumentToChat(
    telegramChatId: number,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number }> {
    this.ensureTelegramEnabledFor("send Telegram documents");
    const fileBuffer = await readFile(filePath);
    const response = await this.bot.api.sendDocument(
      telegramChatId,
      new InputFile(fileBuffer, basename(filePath)),
      caption?.trim()
        ? {
            caption: caption.trim(),
          }
        : {},
    );

    return {
      messageId: response.message_id,
    };
  }

  public async sendDocumentBufferToChat(
    telegramChatId: number,
    fileName: string,
    content: Uint8Array,
    caption?: string,
  ): Promise<{ messageId: number }> {
    this.ensureTelegramEnabledFor("send Telegram documents");
    const response = await this.bot.api.sendDocument(
      telegramChatId,
      new InputFile(Buffer.from(content), basename(fileName)),
      caption?.trim()
        ? {
            caption: caption.trim(),
          }
        : {},
    );

    return {
      messageId: response.message_id,
    };
  }

  public async editChatMessage(
    telegramChatId: number,
    telegramMessageId: number,
    text: string,
    options: TelegramEditMessageOptions = {},
  ): Promise<void> {
    this.ensureTelegramEnabledFor("edit Telegram messages");
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.bot.api.editMessageText(
          telegramChatId,
          telegramMessageId,
          text,
          options,
        );
        return;
      } catch (error) {
        if (error instanceof GrammyError) {
          if (error.description.includes("message is not modified")) {
            return;
          }

          if (error.error_code === 429) {
            const retryAfterSeconds = Math.max(
              1,
              error.parameters.retry_after ?? 1,
            );
            this.logger.warn(
              "Telegram rate limit hit while editing chat message, cooling down",
              {
                telegramChatId,
                telegramMessageId,
                attempt,
                retryAfterSeconds,
                description: error.description,
              },
            );

            await new Promise((resolve) =>
              setTimeout(resolve, retryAfterSeconds * 1000),
            );
            continue;
          }
        }

        throw error;
      }
    }
  }

  public async sendStartupNotifications(): Promise<void> {
    await this.lifecycleActions.sendStartupNotifications(__dirname);
  }

  public async sendAdminGatewayRegistrationNotifications(input: {
    clientUuid: string;
    gatewayUserUuid?: string;
    nodeId?: string;
    packageVersion?: string;
    totalSessions: number;
    isNewClient: boolean;
    newSessions: AdminGatewayRegistrationSessionRecord[];
  }): Promise<void> {
    await this.requestFlow.sendAdminGatewayRegistrationNotifications(input);
  }

  public async sendRequest(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    return this.requestFlow.sendRequest(input);
  }

  public async sendRequestForGatewayBoundSession(
    input: HumanTransportRequest & { sourceClientUuid: string },
  ): Promise<{ externalMessageId?: string | number }> {
    return this.requestFlow.sendRequestForGatewayBoundSession(input);
  }

  public async sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }> {
    return this.requestFlow.sendNotification(input);
  }

  public async handleProjectMemberNoteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    if (this.projectActions) {
      await this.projectActions.handleProjectMemberNoteCallback(ctx);
      return;
    }

    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^project-member-note:(question|share):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({
        text: "Действие с участником проекта некорректно.",
        show_alert: true,
      });
      return;
    }
    const [, kind, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Данные участника проекта некорректны или устарели.",
        show_alert: true,
      });
      return;
    }

    const payload = await (this as unknown as {
      getProjectMemberPayloadByKey: (payloadKey: string) => Promise<{
        targetSessionId?: string;
        targetSessionLabel?: string;
        projectUuid?: string;
      } | null>;
    }).getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Данные участника проекта некорректны или устарели.",
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    await (this as unknown as {
      beginPartnerNoteMode: (
        ctx: TelegramMenuContext,
        kind: PartnerNoteKind,
        target?: {
          targetSessionId?: string;
          targetSessionLabel?: string;
          projectUuid?: string;
        },
      ) => Promise<void>;
    }).beginPartnerNoteMode(ctx, kind as PartnerNoteKind, {
      ...(payload.targetSessionId ? { targetSessionId: payload.targetSessionId } : {}),
      ...(payload.targetSessionLabel ? { targetSessionLabel: payload.targetSessionLabel } : {}),
      ...(payload.projectUuid ? { projectUuid: payload.projectUuid } : {}),
    });
  }

  public async handlePendingPartnerNote(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    if (this.partnerActions) {
      return this.partnerActions.handlePendingPartnerNote(ctx, text);
    }

    const principal = (this as unknown as {
      getPrincipalFromContext: (
        ctx: TelegramMenuContext,
      ) => { telegramChatId: number; telegramUserId: number } | null;
    }).getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = `${principal.telegramChatId}:${principal.telegramUserId}`;
    const pending = this.pendingPartnerNotes.get(principalKey) as
      | {
          sessionId: string;
          kind: PartnerNoteKind;
          targetSessionId?: string;
          targetSessionLabel?: string;
          projectUuid?: string;
        }
      | undefined;
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingPartnerNotes.delete(principalKey);
      return false;
    }

    const parsed = parsePartnerNoteText(text);
    const sourceSession = await this.sessionStore.getSession(pending.sessionId);
    const sourceLabel = sourceSession?.label ?? pending.sessionId;
    const targetLabel = pending.targetSessionLabel ?? pending.targetSessionId ?? "partner";

    this.pendingPartnerNotes.delete(principalKey);

    if (isExecutorTargetKind(pending.kind)) {
      if (pending.projectUuid) {
        await (this as unknown as {
          ensureProjectSessionRegistered: (input: {
            principal: { telegramChatId: number; telegramUserId: number };
            sessionId: string;
            projectUuid: string;
          }) => Promise<void>;
        }).ensureProjectSessionRegistered({
          principal,
          sessionId: pending.sessionId,
          projectUuid: pending.projectUuid,
        });
      }

      const delegatedMessage = [
        `Пользователь из Telegram просит тебя выполнить задачу для сессии ${sourceLabel}.`,
        `Маршрут результата: ${targetLabel} -> ${sourceLabel}`,
        "",
        "Задача:",
        parsed.message,
      ].join("\n");
      const expectedReply = [
        `Подготовь результат для сессии ${sourceLabel}.`,
        "После подготовки обязательно отправь его обратно через send_partner_note.",
        "Задача не завершена, пока send_partner_note не отработал успешно.",
      ].join(" ");
      const output = await (this as unknown as {
        sendPartnerNote: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }).sendPartnerNote({
        session_id: pending.sessionId,
        ...(pending.targetSessionId ? { target_session_id: pending.targetSessionId } : {}),
        ...(pending.projectUuid ? { project_uuid: pending.projectUuid } : {}),
        kind: pending.kind,
        summary: parsed.summary,
        message: delegatedMessage,
        expected_reply: expectedReply,
        requires_reply: true,
      });

      const sent = await (this as unknown as {
        replyText: (
          ctx: TelegramMenuContext,
          text: string,
          meta: { kind: "menu"; sessionId?: string },
        ) => Promise<{ message_id: number } | void>;
      }).replyText(
        ctx,
        [
          "Задача отправлена.",
          `Маршрут результата: ${targetLabel} -> ${sourceLabel}`,
          `Тип: ${pending.kind}`,
          `Кратко: ${parsed.summary}`,
          `Share: ${String(output.share_id ?? "")}`,
        ].join("\n"),
        { kind: "menu", sessionId: pending.sessionId },
      );

      if (
        output.delivery_status === "queued" &&
        sent &&
        "message_id" in sent &&
        ctx.chat
      ) {
        await this.maintenanceStore.setOutgoingDeliveryNotice({
          deliveryUuid: String(output.inbox_message_id),
          sessionId: pending.sessionId,
          telegramChatId: ctx.chat.id,
          telegramMessageId: sent.message_id,
          shareId: String(output.share_id),
          kind: String(output.kind),
          summary: parsed.summary,
          ...(output.project_name ? { projectName: String(output.project_name) } : {}),
          ...(output.target_actor_label
            ? { targetLabel: String(output.target_actor_label) }
            : { targetLabel }),
          ...(output.target_session_label
            ? { targetSessionLabel: String(output.target_session_label) }
            : { targetSessionLabel: targetLabel }),
        });
      }
      return true;
    }

    await this.enqueuePartnerNoteInstruction({
      principal,
      sessionId: pending.sessionId,
      sourceTelegramMessageId: ctx.message?.message_id ?? 0,
      kind: pending.kind,
      summary: parsed.summary,
      message: parsed.message,
      ...(pending.targetSessionId ? { targetSessionId: pending.targetSessionId } : {}),
      ...(pending.targetSessionLabel ? { targetSessionLabel: pending.targetSessionLabel } : {}),
      ...(pending.projectUuid ? { projectUuid: pending.projectUuid } : {}),
    });

    await (this as unknown as {
      replyText: (
        ctx: TelegramMenuContext,
        text: string,
        meta: { kind: "menu"; sessionId?: string },
      ) => Promise<{ message_id: number } | void>;
    }).replyText(
      ctx,
      [
        "Инструкция добавлена во входящие текущей сессии.",
        `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${pending.kind}`,
        `Кратко: ${parsed.summary}`,
      ].join("\n"),
      { kind: "menu", sessionId: pending.sessionId },
    );
    return true;
  }

  public async enqueuePartnerNoteInstruction(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sourceTelegramMessageId: number;
    kind: PartnerNoteKind;
    summary: string;
    message: string;
    targetSessionId?: string;
    targetSessionLabel?: string;
    projectUuid?: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.sessionId);
    const sourceLabel = session?.label ?? input.sessionId;
    const targetLabel = input.targetSessionLabel ?? input.targetSessionId ?? "напарник";
    await writeLocalTaskXchangeRecord({
      config: this.config,
      session,
      sessionId: input.sessionId,
      summary: input.summary,
      kind: input.kind,
      text: [
        "Пользователь просит текущую консоль выполнить работу и отправить результат другой консоли.",
        `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${input.kind}`,
        `Кратко: ${input.summary}`,
        ...(input.projectUuid ? [`Проект UUID: ${input.projectUuid}`] : []),
        ...(input.targetSessionId ? [`Target session ID: ${input.targetSessionId}`] : []),
        "",
        "Содержимое для отправки:",
        input.message,
        "",
        "Не пересылай это как новую задачу в target-консоль.",
        "Сначала выполни работу в текущей консоли сам.",
        "Через send_partner_note или send_partner_file отправляй только результат, а не исходное поручение.",
        "Не останавливайся на проверке xchange records, чтении note, listing файлов или текстовом отчёте.",
        "Передай target_session_id явно в send_partner_note.",
        "После подготовки обязательно используй send_partner_note.",
        "Задача не завершена, пока send_partner_note не отработал успешно.",
        "Только после успешной отправки результата можно делать mark_xchange_record_read.",
        "Если запрос касается существующего локального файла, вызови send_partner_file.",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      actionDesc:
        "Start with get_xchange_record, complete the work in this console, then send the final result to the target console with send_partner_note or send_partner_file. Do not stop at analysis or a summary. The task is not complete until the outbound tool succeeds, and only then may you call mark_xchange_record_read.",
      tools: ["get_xchange_record", "send_partner_note", "send_partner_file", "mark_xchange_record_read"],
      tags: ["telegram", "human", "local", "partner-routing"],
    });
    await this.nudgeSessionInbox(input.sessionId);
  }

  public async handleProjectMemberJoinedEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    await this.projectEvents.handleProjectMemberJoinedEvent(input);
  }

  public async handleProjectMemberLeftEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    await this.projectEvents.handleProjectMemberLeftEvent(input);
  }

  public async handleProjectDeletedEvent(input: {
    project_uuid: string;
    project_name: string;
  }): Promise<void> {
    await this.projectEvents.handleProjectDeletedEvent(input);
  }

  private async computeSessionToolsHash(sessionId: string): Promise<string | null> {
    const session = await this.sessionStore.getSession(sessionId);
    return session?.lastSeenToolsHash?.trim() || null;
  }

  private async maybeNotifyToolsMismatchForSession(
    sessionId: string,
  ): Promise<void> {
    const session = await this.sessionStore.getSession(sessionId);
    const expectedGatewayHash = session?.lastNotifiedToolsHash?.trim();
    if (!session || !expectedGatewayHash) {
      return;
    }

    const localHash = await this.computeSessionToolsHash(sessionId);
    if (localHash === expectedGatewayHash) {
      return;
    }

    if (session.lastSeenToolsHash?.trim() === expectedGatewayHash) {
      return;
    }

    await this.handleToolsUpdatedEvent({
      local_session_id: sessionId,
      ...(session.label ? { session_label: session.label } : {}),
      ...(localHash ? { client_tools_hash: localHash } : {}),
      gateway_tools_hash: expectedGatewayHash,
      reason: localHash ? "outdated" : "missing",
      instruction:
        "Call refresh_tools_markdown with the current known_hash for this session. If changed=true, read and apply the returned content before continuing.",
    });
  }

  public async handleToolsUpdatedEvent(input: {
    local_session_id: string;
    session_label?: string;
    client_tools_hash?: string;
    gateway_tools_hash: string;
    reason: "missing" | "outdated";
    instruction: string;
  }): Promise<void> {
    await this.eventActions.handleToolsUpdatedEvent(input);
  }

  public async handleGatewayVersionCompatibilityEvent(input: {
    local_session_id: string;
    session_label?: string;
    compatibility: "warn" | "reject";
    gateway_package_version: string;
    gateway_protocol_version: string;
    gateway_capabilities: string[];
    client_package_version: string;
    client_protocol_version: string;
    client_capabilities: string[];
    reasons: string[];
    instruction: string;
  }): Promise<void> {
    await this.eventActions.handleGatewayVersionCompatibilityEvent(input);
  }

  public async handleLiveViewApprovalRequestEvent(
    input: LiveApprovalEventPayload,
  ): Promise<void> {
    await this.eventActions.handleLiveViewApprovalRequestEvent(input);
  }

  public async handleLiveViewApprovalResolvedEvent(
    input: LiveApprovalEventPayload & { approved: boolean },
  ): Promise<void> {
    await this.eventActions.handleLiveViewApprovalResolvedEvent(input);
  }

  public async nudgeSessionInbox(sessionId: string): Promise<void> {
    await this.tmuxActions.nudgeForInboxMessage(sessionId);
  }

  public async nudgeSessionPartnerNote(
    sessionId: string,
    input?: {
      kind?: string;
      requiresReply?: boolean;
    },
  ): Promise<void> {
    const kind = input?.kind?.trim().toLowerCase();
    const requiresReply = input?.requiresReply === true;
    const useReplyNudge =
      !requiresReply &&
      (kind === "reply" || kind === "handoff");
    await this.tmuxActions.nudgeForSession(sessionId, {
      message: useReplyNudge
        ? this.config.tmux.partnerReplyNudgeMessage
        : this.config.tmux.partnerNudgeMessage,
      reason: "partner_note",
    });
  }

  public async waitForReply(
    requestId: string,
    timeoutSeconds: number,
  ): Promise<HumanTransportReply | null> {
    return this.requestFlow.waitForReply(requestId, timeoutSeconds);
  }

  public async handleGatewayTransportReplyEvent(input: {
    request_id: string;
    answer: string;
    received_at: string;
  }): Promise<void> {
    await this.requestFlow.handleGatewayTransportReplyEvent(input);
  }
}
