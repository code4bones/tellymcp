import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { Menu } from "@grammyjs/menu";
import { Bot, GrammyError, InputFile } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  SessionStore,
  TelegramAdminAuthStore,
  SessionBindingStore,
  TelegramInboxStore,
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
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import { createTelegramFetch } from "./proxyFetch";
import type {
  AdminClientViewRecord,
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
  TelegramSendMessageOptions,
  WaiterRecord,
} from "./transportTypes";
import {
  buildInboxText,
  formatFilePreviewLabel,
  formatInboxPreviewLabel,
  formatSessionMenuLabel,
  formatStoragePreviewLabel,
} from "./transportFormatting";
import {
  collectIncomingAttachments,
  extractIncomingText,
  formatInboxDetail,
  formatScreenshotDetail,
  formatStorageDetail,
} from "./transportContent";
import { TransportLiveActions } from "./transportLiveActions";
import { TransportLifecycleActions } from "./transportLifecycleActions";
import { TransportAdminActions } from "./transportAdminActions";
import { TransportAdminMenus } from "./transportAdminMenus";
import { TransportAttachmentStore } from "./transportAttachmentStore";
import { TransportBroadcastActions } from "./transportBroadcastActions";
import { TransportDocumentActions } from "./transportDocumentActions";
import { TransportContext } from "./transportContext";
import { TransportEventActions } from "./transportEventActions";
import { TransportFileHandoffActions } from "./transportFileHandoffActions";
import { TransportLinkingActions } from "./transportLinkingActions";
import { TransportMenuFactories } from "./transportMenuFactories";
import { TransportMenuFingerprints } from "./transportMenuFingerprints";
import { TransportMenuFlow } from "./transportMenuFlow";
import { TransportMenuShell } from "./transportMenuShell";
import { TransportGatewayDirectory } from "./transportGatewayDirectory";
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
import {
  extractCallbackSuffix,
  isGatewayAdminCommand,
  parseAdminAuthCommand,
  readMenuPayloadKey,
  resolveGatewayControlBaseUrl,
} from "./transportUtils";

export class TelegramTransport implements HumanTransport {
  private readonly telegramFetch: TelegramClientFetch;
  private readonly bot: Bot<TelegramMenuContext>;
  private readonly mainMenu: Menu<TelegramMenuContext>;
  private readonly adminMainMenu: Menu<TelegramMenuContext>;
  private readonly adminClientsMenu: Menu<TelegramMenuContext>;
  private readonly adminClientSessionsMenu: Menu<TelegramMenuContext>;
  private readonly adminClientSessionDetailMenu: Menu<TelegramMenuContext>;
  private readonly adminToolsMenu: Menu<TelegramMenuContext>;
  private readonly inboxMenu: Menu<TelegramMenuContext>;
  private readonly storageMenu: Menu<TelegramMenuContext>;
  private readonly browserMenu: Menu<TelegramMenuContext>;
  private readonly projectsMenu: Menu<TelegramMenuContext>;
  private readonly collabToolsMenu: Menu<TelegramMenuContext>;
  private readonly collabDeleteMenu: Menu<TelegramMenuContext>;
  private readonly localMenu: Menu<TelegramMenuContext>;
  private readonly screenshotsMenu: Menu<TelegramMenuContext>;
  private readonly linkMenu: Menu<TelegramMenuContext>;
  private readonly partnerMenu: Menu<TelegramMenuContext>;
  private readonly sessionsMenu: Menu<TelegramMenuContext>;
  private readonly bufferMenu: Menu<TelegramMenuContext>;
  private readonly settingsMenu: Menu<TelegramMenuContext>;
  private readonly developerMenu: Menu<TelegramMenuContext>;
  private readonly unpairConfirmMenu: Menu<TelegramMenuContext>;
  private readonly pruneConfirmMenu: Menu<TelegramMenuContext>;
  private readonly inboxMessageMenu: Menu<TelegramMenuContext>;
  private readonly storageMessageMenu: Menu<TelegramMenuContext>;
  private readonly screenshotMessageMenu: Menu<TelegramMenuContext>;
  private readonly tmuxActions: TransportTmuxActions;
  private readonly liveActions: TransportLiveActions;
  private readonly lifecycleActions: TransportLifecycleActions;
  private readonly adminActions: TransportAdminActions;
  private readonly adminMenus: TransportAdminMenus;
  private readonly attachmentStore: TransportAttachmentStore;
  private readonly broadcastActions: TransportBroadcastActions;
  private readonly context: TransportContext;
  private readonly documentActions: TransportDocumentActions;
  private readonly eventActions: TransportEventActions;
  private readonly partnerActions: TransportPartnerActions;
  private readonly fileHandoffActions: TransportFileHandoffActions;
  private readonly linkingActions: TransportLinkingActions;
  private readonly menuFactories: TransportMenuFactories;
  private readonly menuFingerprints: TransportMenuFingerprints;
  private readonly menuFlow: TransportMenuFlow;
  private readonly menuShell: TransportMenuShell;
  private readonly gatewayDirectory: TransportGatewayDirectory;
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
  private readonly adminClientViewByPrincipal = new Map<string, AdminClientViewRecord>();
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
    private readonly inboxStore: TelegramInboxStore,
    private readonly menuPayloadStore: TelegramMenuPayloadStore,
    private readonly localeStore: TelegramUserLocaleStore,
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly objectStore: MinioExchangeStore,
    private readonly webAppLaunchRegistry: WebAppLaunchRegistry,
    private readonly logger: Logger,
  ) {
    this.telegramFetch = createTelegramFetch(
      this.config,
      this.logger,
    ) as unknown as TelegramClientFetch;
    this.liveActions = new TransportLiveActions({
      config: this.config,
      webAppLaunchRegistry: this.webAppLaunchRegistry,
      logger: this.logger,
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      ensureGatewayClientUuid: (principal, actor) =>
        this.gatewayActions.ensureGatewayClientUuid(principal, actor),
      sendChatMessage: (telegramChatId, text, options, meta) =>
        this.outputActions.sendChatMessage(telegramChatId, text, options, meta),
    });
    this.tmuxActions = new TransportTmuxActions({
      config: this.config,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      bindingStore: this.bindingStore,
      logger: this.logger,
      tmuxNudgeFailureNoticeAt: this.tmuxNudgeFailureNoticeAt,
      tmuxPromptNoticeState: this.tmuxPromptNoticeState,
      sendTypingForSession: (sessionId) => this.tmuxRuntime.sendTypingForSession(sessionId),
      resolveLocaleForTelegramUserId: (userId) =>
        this.context.resolveLocaleForTelegramUserId(userId),
      sendNotification: (input) => this.sendNotification(input),
      sendLiveViewLauncherMessage: (input) =>
        this.liveActions.sendLauncherMessage(input),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
    });
    this.xchangeState = new TransportXchangeState({
      config: this.config,
      sessionStore: this.sessionStore,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
    });
    this.context = new TransportContext({
      config: this.config,
      localeStore: this.localeStore,
    });
    this.payloadState = new TransportPayloadState({
      menuPayloadStore: this.menuPayloadStore,
      menuPayloadTtlSeconds: this.config.telegram.menuPayloadTtlSeconds,
    });
    this.menuFingerprints = new TransportMenuFingerprints({
      logger: this.logger,
      bindingStore: this.bindingStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      listActiveSessionStorageEntries: (sessionId) =>
        this.xchangeState.listActiveSessionStorageEntries(sessionId),
      listActiveSessionScreenshots: (sessionId) =>
        this.xchangeState.listActiveSessionScreenshots(sessionId),
    });
    this.adminMenus = new TransportAdminMenus({
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      showAdminMainMenu: (ctx) => this.adminActions.showMainMenu(ctx),
      showAdminClientsMenu: (ctx) => this.adminActions.showClientsMenu(ctx),
      showAdminClientSessionsMenu: (ctx) => this.adminActions.showClientSessionsMenu(ctx),
      showAdminClientSessionList: (ctx, scope) =>
        this.adminActions.showClientSessionList(ctx, scope),
      showAdminToolsMenu: (ctx) => this.adminActions.showToolsMenu(ctx),
      listGatewayAdminClients: () => this.gatewayActions.listGatewayAdminClients(),
      createAdminClientMenuPayload: (client) =>
        this.payloadState.createAdminClientMenuPayload(client),
      handleAdminClientSelectCallback: (ctx) =>
        this.adminActions.handleClientSelectCallback(ctx, readMenuPayloadKey),
      adminHandleClientEnvExport: (ctx) =>
        this.adminActions.handleClientEnvExport(ctx),
    });
    this.documentActions = new TransportDocumentActions({
      logger: this.logger,
    });
    this.linkingActions = new TransportLinkingActions({
      config: this.config,
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      showMainMenu: (ctx, introText) => this.menuState.showMainMenu(ctx, introText),
      showLinkMenu: (ctx) => this.menuFlow.showLinkMenu(ctx),
      showLocalMenu: (ctx) => this.menuFlow.showLocalMenu(ctx),
      showProjectsMenu: (ctx) => this.menuFlow.showProjectsMenu(ctx),
    });
    this.projectMenus = new TransportProjectMenus({
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      buildProjectsFingerprint: (ctx) => this.gatewayActions.buildProjectsFingerprint(ctx),
      loadProjectsContext: (ctx) => this.gatewayActions.loadProjectsContext(ctx),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      createProjectMenuPayload: (sessionId, projectUuid, title) =>
        this.payloadState.createProjectMenuPayload(sessionId, projectUuid, title),
      createProjectDeleteMenuPayload: (sessionId, projectUuid, title) =>
        this.payloadState.createProjectDeleteMenuPayload(
          sessionId,
          projectUuid,
          title,
        ),
      handleProjectSelect: (ctx) => this.projectEntryActions.handleProjectSelect(ctx),
      handleProjectDeleteSelect: (ctx) => this.projectEntryActions.handleProjectDeleteSelect(ctx),
      beginProjectMode: (ctx, mode) => this.projectEntryActions.beginProjectMode(ctx, mode),
      beginProjectBroadcast: (ctx) => this.broadcastActions.beginProjectBroadcast(ctx),
      handleCollabHistoryExport: (ctx) => this.menuFlow.handleCollabHistoryExport(ctx),
      showCollabToolsMenu: (ctx) => this.menuFlow.showCollabToolsMenu(ctx),
      showCollabDeleteMenu: (ctx) => this.menuFlow.showCollabDeleteMenu(ctx),
      showProjectsMenu: (ctx) => this.menuFlow.showProjectsMenu(ctx),
      showMainMenu: (ctx) => this.menuState.showMainMenu(ctx),
    });
    this.menuFactories = new TransportMenuFactories({
      logger: this.logger,
      bindingStore: this.bindingStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      buildMainMenuFingerprint: (ctx) =>
        this.menuFingerprints.buildMainMenuFingerprint(ctx),
      buildInboxFingerprint: (ctx) =>
        this.menuFingerprints.buildInboxFingerprint(ctx),
      buildStorageFingerprint: (ctx) =>
        this.menuFingerprints.buildStorageFingerprint(ctx),
      buildScreenshotsFingerprint: (ctx) =>
        this.menuFingerprints.buildScreenshotsFingerprint(ctx),
      buildSessionsFingerprint: (ctx) =>
        this.menuFingerprints.buildSessionsFingerprint(ctx),
      buildLinkFingerprint: (ctx) =>
        this.menuFingerprints.buildLinkFingerprint(ctx),
      buildInboxButtonLabel: (ctx) =>
        this.menuFingerprints.buildInboxButtonLabel(ctx),
      buildScreenshotsButtonLabel: (ctx) =>
        this.menuFingerprints.buildScreenshotsButtonLabel(ctx),
      buildLinkButtonLabel: (ctx) =>
        this.menuFingerprints.buildLinkButtonLabel(ctx),
      showLiveViewLauncher: (ctx) => this.menuFlow.showLiveViewLauncher(ctx),
      showBufferMenu: (ctx) => this.menuFlow.showBufferMenu(ctx),
      showBrowserMenu: (ctx) => this.menuFlow.showBrowserMenu(ctx),
      showMainMenu: (ctx) => this.menuState.showMainMenu(ctx),
      showLocalEntryPoint: (ctx) => this.linkingActions.showLocalEntryPoint(ctx),
      showProjectsEntryPoint: (ctx) =>
        this.linkingActions.showProjectsEntryPoint(ctx),
      showInboxMenu: (ctx) => this.menuFlow.showInboxMenu(ctx),
      showStorageMenu: (ctx) => this.menuFlow.showStorageMenu(ctx),
      showSettingsMenu: (ctx) => this.menuFlow.showSettingsMenu(ctx),
      showSessionsMenu: (ctx) => this.menuFlow.showSessionsMenu(ctx),
      showScreenshotsMenu: (ctx) => this.menuFlow.showScreenshotsMenu(ctx),
      showLocalMenu: (ctx) => this.menuFlow.showLocalMenu(ctx),
      showLinkMenu: (ctx) => this.menuFlow.showLinkMenu(ctx),
      showPartnerMenu: (ctx) => this.menuFlow.showPartnerMenu(ctx),
      showPartnerEntryPoint: (ctx) => this.menuCallbacks.showPartnerEntryPoint(ctx),
      handleLinkButton: (ctx) => this.linkingActions.handleLinkButton(ctx),
      handleLinkTargetSelect: (ctx) =>
        this.menuCallbacks.handleLinkTargetSelect(ctx, readMenuPayloadKey(ctx)),
      beginPartnerNoteMode: (ctx, kind) =>
        this.partnerActions.beginPartnerNoteMode(ctx, kind),
      sendActiveSessionBuffer: (ctx, input) =>
        this.menuFlow.sendActiveSessionBuffer(ctx, input),
      showUnpairConfirmMenu: (ctx) => this.menuFlow.showUnpairConfirmMenu(ctx),
      showDeveloperMenu: (ctx) => this.menuFlow.showDeveloperMenu(ctx),
      showPruneConfirmMenu: (ctx) => this.menuFlow.showPruneConfirmMenu(ctx),
      showActiveSessionInfo: (ctx) => this.menuFlow.showActiveSessionInfo(ctx),
      beginRenameActiveSession: (ctx) =>
        this.sessionActions.beginRenameActiveSession(ctx),
      beginBroadcast: (ctx) => this.broadcastActions.beginBroadcast(ctx),
      pruneAllSessions: (ctx) => this.sessionActions.pruneAllSessions(ctx),
      unpairActiveSession: (ctx) => this.sessionActions.unpairActiveSession(ctx),
      handleInboxMessageOpen: (ctx) =>
        this.menuCallbacks.handleInboxMessageOpen(ctx, readMenuPayloadKey(ctx)),
      handleInboxMessageDelete: (ctx) =>
        this.menuCallbacks.handleInboxMessageDelete(ctx, readMenuPayloadKey(ctx)),
      handleStorageOpen: (ctx) =>
        this.menuCallbacks.handleStorageOpen(ctx, readMenuPayloadKey(ctx)),
      handleStorageGet: (ctx) =>
        this.menuCallbacks.handleStorageGet(ctx, readMenuPayloadKey(ctx)),
      handleStorageDelete: (ctx) =>
        this.menuCallbacks.handleStorageDelete(ctx, readMenuPayloadKey(ctx)),
      handleScreenshotOpen: (ctx) =>
        this.menuCallbacks.handleScreenshotOpen(ctx, readMenuPayloadKey(ctx)),
      handleScreenshotGet: (ctx) =>
        this.menuCallbacks.handleScreenshotGet(ctx, readMenuPayloadKey(ctx)),
      handleScreenshotDelete: (ctx) =>
        this.menuCallbacks.handleScreenshotDelete(ctx, readMenuPayloadKey(ctx)),
      handleSessionSelection: (ctx) =>
        this.menuCallbacks.handleSessionSelection(ctx, readMenuPayloadKey(ctx)),
      createInboxMenuPayload: (sessionId, messageId) =>
        this.payloadState.createInboxMenuPayload(sessionId, messageId),
      createFileMenuPayload: (sessionId, filePath) =>
        this.payloadState.createFileMenuPayload(sessionId, filePath),
      createSessionMenuPayload: (sessionId) =>
        this.payloadState.createSessionMenuPayload(sessionId),
      createLinkMenuPayload: (sessionId, targetSessionId) =>
        this.payloadState.createLinkMenuPayload(sessionId, targetSessionId),
      formatInboxPreviewLabel: (message) => formatInboxPreviewLabel(message),
      formatStoragePreviewLabel: (filePath, meta) =>
        formatStoragePreviewLabel(filePath, meta),
      formatFilePreviewLabel: (filePath) => formatFilePreviewLabel(filePath),
      formatSessionMenuLabel: (input) => formatSessionMenuLabel(input),
      listActiveSessionStorageEntries: (sessionId) =>
        this.xchangeState.listActiveSessionStorageEntries(sessionId),
      listActiveSessionScreenshots: (sessionId) =>
        this.xchangeState.listActiveSessionScreenshots(sessionId),
    });

    this.bot = new Bot<TelegramMenuContext>(
      this.config.telegram.botToken ?? "0:disabled",
      {
      client: {
        fetch: this.telegramFetch,
      },
    });
    this.outputActions = new TransportOutputActions({
      config: this.config,
      logger: this.logger,
      bot: this.bot,
    });
    this.tmuxRuntime = new TransportTmuxRuntime({
      config: this.config,
      logger: this.logger,
      bot: this.bot,
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      isTelegramEnabled: () => this.isTelegramEnabled(),
      tmuxActions: this.tmuxActions,
      tmuxNudgeDebounceTimers: this.tmuxNudgeDebounceTimers,
    });
    this.mainMenu = this.menuFactories.createMainMenu();
    this.adminMainMenu = this.adminMenus.createAdminMainMenu();
    this.adminClientsMenu = this.adminMenus.createAdminClientsMenu();
    this.adminClientSessionsMenu = this.adminMenus.createAdminClientSessionsMenu();
    this.adminClientSessionDetailMenu =
      this.adminMenus.createAdminClientSessionDetailMenu();
    this.adminToolsMenu = this.adminMenus.createAdminToolsMenu();
    this.inboxMenu = this.menuFactories.createInboxMenu();
    this.storageMenu = this.menuFactories.createStorageMenu();
    this.browserMenu = this.menuFactories.createBrowserMenu();
    this.projectsMenu = this.projectMenus.createProjectsMenu();
    this.collabToolsMenu = this.projectMenus.createCollabToolsMenu();
    this.collabDeleteMenu = this.projectMenus.createCollabDeleteMenu();
    this.localMenu = this.menuFactories.createLocalMenu();
    this.screenshotsMenu = this.menuFactories.createScreenshotsMenu();
    this.linkMenu = this.menuFactories.createLinkMenu();
    this.partnerMenu = this.menuFactories.createPartnerMenu();
    this.sessionsMenu = this.menuFactories.createSessionsMenu();
    this.bufferMenu = this.menuFactories.createBufferMenu();
    this.settingsMenu = this.menuFactories.createSettingsMenu();
    this.developerMenu = this.menuFactories.createDeveloperMenu();
    this.unpairConfirmMenu = this.menuFactories.createUnpairConfirmMenu();
    this.pruneConfirmMenu = this.menuFactories.createPruneConfirmMenu();
    this.inboxMessageMenu = this.menuFactories.createInboxMessageMenu();
    this.storageMessageMenu = this.menuFactories.createStorageMessageMenu();
    this.screenshotMessageMenu = this.menuFactories.createScreenshotMessageMenu();
    this.adminActions = new TransportAdminActions({
      config: this.config,
      adminClientViewByPrincipal: this.adminClientViewByPrincipal,
      adminMainMenu: this.adminMainMenu,
      adminClientsMenu: this.adminClientsMenu,
      adminClientSessionsMenu: this.adminClientSessionsMenu,
      adminToolsMenu: this.adminToolsMenu,
      liveActions: this.liveActions,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      tForContext: (ctx, key) => this.context.tForContext(ctx, key),
      listGatewayAdminClients: () => this.gatewayActions.listGatewayAdminClients(),
      listGatewayClientSessions: (clientUuid) =>
        this.gatewayActions.listGatewayClientSessions(clientUuid),
      listGatewayConnectedClients: () => this.gatewayActions.listGatewayConnectedClients(),
      createAdminClientSessionMenuPayload: (session) =>
        this.payloadState.createAdminClientSessionMenuPayload(session),
      renderMenuHtmlScreen: (ctx, text, meta, menu) =>
        this.menuFlow.renderMenuHtmlScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
      editText: (ctx, text, meta, options) =>
        this.outputActions.editText(
          ctx,
          text,
          meta,
          options as TelegramEditMessageOptions,
        ),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.documentActions.replyDocumentWithRetry(ctx, document, options, meta),
      showAdminClientsMenu: (ctx, introText) => this.adminActions.showClientsMenu(ctx, introText),
      showMainMenu: (ctx, introText) => this.menuState.showMainMenu(ctx, introText),
      getAdminClientSessionPayloadByKey: (payloadKey) =>
        this.projectState.getAdminClientSessionPayloadByKey(payloadKey),
      getMenuPayloadByKey: (payloadKey) =>
        this.menuPayloadStore.getMenuPayload(payloadKey),
      extractCallbackSuffix: (ctx, prefix) => extractCallbackSuffix(ctx, prefix),
      bindRelaySessionToPrincipal: (input) => this.projectState.bindRelaySessionToPrincipal(input),
      webAppLaunchRegistry: this.webAppLaunchRegistry,
    });
    this.broadcastActions = new TransportBroadcastActions({
      logger: this.logger,
      pendingBroadcasts: this.pendingBroadcasts,
      pendingRenames: this.pendingRenames,
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showCollabToolsMenu: (ctx) => this.menuFlow.showCollabToolsMenu(ctx),
      showDeveloperMenu: (ctx) => this.menuFlow.showDeveloperMenu(ctx),
      ensureGatewayClientUuid: (principal) => this.gatewayActions.ensureGatewayClientUuid(principal),
      listGatewayProjects: (principal) => this.gatewayActions.listGatewayProjects(principal),
      listGatewayProjectSessions: (principal, projectUuid) =>
        this.gatewayActions.listGatewayProjectSessions(principal, projectUuid),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      routeTelegramInboxToRelaySession: (input) =>
        this.messageFlow.routeTelegramInboxToRelaySession(input),
      scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
        this.tmuxRuntime.scheduleTmuxNudgeForInboxMessage(sessionId, session),
      sendPartnerNote: (input) => this.gatewayActions.sendPartnerNote(input),
    });
    this.partnerActions = new TransportPartnerActions({
      logger: this.logger,
      pendingPartnerNotes: this.pendingPartnerNotes,
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showPartnerMenu: (ctx) => this.menuFlow.showPartnerMenu(ctx),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      maintenanceStore: this.maintenanceStore,
      ensureProjectSessionRegistered: (input) => this.gatewayActions.ensureProjectSessionRegistered(input),
      sendPartnerNote: (input) => this.gatewayActions.sendPartnerNote(input),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
    });
    this.fileHandoffActions = new TransportFileHandoffActions({
      logger: this.logger,
      config: this.config,
      pendingFileHandoffs: this.pendingFileHandoffs,
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showPartnerMenu: (ctx) => this.menuFlow.showPartnerMenu(ctx),
      showLocalMenu: (ctx) => this.menuFlow.showLocalMenu(ctx),
      showProjectMemberDetail: (ctx, input) =>
        this.projectView.showProjectMemberDetail(ctx, {
          ...input,
          inviteToken: input.inviteToken ?? "",
        }),
      getProjectPayloadByUuid: (sessionId, projectUuid) =>
        this.projectState.getProjectPayloadByUuid(sessionId, projectUuid),
      ensureProjectSessionRegistered: (input) => this.gatewayActions.ensureProjectSessionRegistered(input),
      sendPartnerNote: (input) => this.gatewayActions.sendPartnerNote(input),
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      maintenanceStore: this.maintenanceStore,
      objectStore: this.objectStore,
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
    });
    this.menuCallbacks = new TransportMenuCallbacks({
      logger: this.logger,
      getMenuPayloadByKey: (key) => this.menuPayloadStore.getMenuPayload(key),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      tForContext: (ctx, key, vars) => this.context.tForContext(ctx, key, vars),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      editText: (ctx, text, meta, options) =>
        this.outputActions.editText(
          ctx,
          text,
          meta,
          options as TelegramEditMessageOptions,
        ),
      showMainMenu: (ctx, introText) => this.menuState.showMainMenu(ctx, introText),
      showLinkMenu: (ctx) => this.menuFlow.showLinkMenu(ctx),
      showPartnerMenu: (ctx) => this.menuFlow.showPartnerMenu(ctx),
      showScreenshotsMenu: (ctx, introText) =>
        this.menuFlow.showScreenshotsMenu(ctx, introText),
      showStorageMenu: (ctx, introText) =>
        this.menuFlow.showStorageMenu(ctx, introText),
      inboxMessageMenu: this.inboxMessageMenu,
      storageMessageMenu: this.storageMessageMenu,
      screenshotMessageMenu: this.screenshotMessageMenu,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      objectStore: this.objectStore,
      formatInboxDetail: (message) => formatInboxDetail(message),
      formatScreenshotDetail: (sessionId, filePath, meta) =>
        formatScreenshotDetail(sessionId, filePath, meta),
      formatStorageDetail: (sessionId, filePath, meta) =>
        formatStorageDetail(sessionId, filePath, meta),
      formatFilePreviewLabel: (filePath, meta) =>
        formatFilePreviewLabel(filePath, meta),
      listActiveSessionFiles: (sessionId) =>
        this.xchangeState.listActiveSessionFiles(sessionId),
      createPartnerFileTargetPayload: (sessionId, targetSessionId, title, filePath) =>
        this.payloadState.createPartnerFileTargetPayload(
          sessionId,
          targetSessionId,
          title,
          filePath,
        ),
      ensureStoredXchangeFile: (sessionId, filePath, source) =>
        this.attachmentStore.ensureStoredXchangeFile(sessionId, filePath, source),
      sendDocumentToChat: (chatId, filePath, caption) =>
        this.sendDocumentToChat(chatId, filePath, caption),
      linkSessions: (sessionId, targetSessionId) =>
        this.linkingActions.linkSessions(sessionId, targetSessionId),
      maybeNotifyToolsMismatchForSession: (sessionId) => this.maybeNotifyToolsMismatchForSession(sessionId),
    });
    this.menuState = new TransportMenuState({
      logger: this.logger,
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      getTmuxStatusLine: async (locale) =>
        this.context.t(locale, "menu:main.screen.tmux_mode_direct"),
      setCurrentAttachmentTargetForContext: (ctx, target) =>
        this.menuFlow.setCurrentAttachmentTargetForContext(ctx, target),
      renderMenuHtmlScreen: (ctx, text, meta, menu) =>
        this.menuFlow.renderMenuHtmlScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
      renderMenuScreen: (ctx, text, meta, menu) =>
        this.menuFlow.renderMenuScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      mainMenu: this.mainMenu,
      sessionsMenu: this.sessionsMenu,
      inboxMenu: this.inboxMenu,
      storageMenu: this.storageMenu,
      browserMenu: this.browserMenu,
      screenshotsMenu: this.screenshotsMenu,
      linkMenu: this.linkMenu,
      partnerMenu: this.partnerMenu,
      localMenu: this.localMenu,
      settingsMenu: this.settingsMenu,
      bufferMenu: this.bufferMenu,
      developerMenu: this.developerMenu,
      unpairConfirmMenu: this.unpairConfirmMenu,
      pruneConfirmMenu: this.pruneConfirmMenu,
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      inboxStore: this.inboxStore,
      listActiveSessionScreenshots: (sessionId) =>
        this.xchangeState.listActiveSessionScreenshots(sessionId),
      listActiveSessionStorageEntries: (sessionId) =>
        this.xchangeState.listActiveSessionStorageEntries(sessionId),
    });
    this.projectState = new TransportProjectState({
      config: this.config,
      getGatewayActorFromContext: (ctx) => this.context.getGatewayActorFromContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      maintenanceStore: this.maintenanceStore,
      menuPayloadStore: this.menuPayloadStore,
    });
    this.projectView = new TransportProjectView({
      config: this.config,
      projectsMenu: this.projectsMenu,
      collabToolsMenu: this.collabToolsMenu,
      collabDeleteMenu: this.collabDeleteMenu,
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      getGatewayActorFromContext: (ctx) => this.context.getGatewayActorFromContext(ctx),
      ensureGatewayClientUuid: (principal, actor) =>
        this.gatewayActions.ensureGatewayClientUuid(principal, actor),
      loadProjectsContext: (ctx) => this.gatewayActions.loadProjectsContext(ctx),
      listGatewayProjects: (principal, actor) =>
        this.gatewayActions.listGatewayProjects(principal, actor),
      listGatewayProjectSessions: (principal, projectUuid) =>
        this.gatewayActions.listGatewayProjectSessions(principal, projectUuid),
      listGatewaySessionHistory: (principal, localSessionId) =>
        this.gatewayActions.listGatewaySessionHistory(principal, localSessionId),
      collectCollabBroadcastTargets: (principal, _sessionId) =>
        this.broadcastActions.listCollabBroadcastTargets(principal),
      ensureOpenedProjectIsActive: (input) =>
        this.gatewayActions.ensureOpenedProjectIsActive(input),
      setCurrentAttachmentTargetForContext: (ctx, target) =>
        this.menuFlow.setCurrentAttachmentTargetForContext(ctx, target),
      renderMenuScreen: (ctx, text, meta, menu) =>
        this.menuFlow.renderMenuScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      editText: (ctx, text, meta, options) =>
        this.outputActions.editText(
          ctx,
          text,
          meta,
          options as TelegramEditMessageOptions,
        ),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.documentActions.replyDocumentWithRetry(ctx, document, options, meta),
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      maintenanceStore: this.maintenanceStore,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      webAppLaunchRegistry: this.webAppLaunchRegistry,
      createProjectMemberMenuPayload: (
        sessionId,
        projectUuid,
        targetSessionId,
        title,
        extra,
      ) =>
        this.payloadState.createProjectMemberMenuPayload(
          sessionId,
          projectUuid,
          targetSessionId,
          title,
          extra,
        ),
      listActiveSessionFiles: (sessionId) =>
        this.xchangeState.listActiveSessionFiles(sessionId),
      formatFilePreviewLabel: (filePath, meta) =>
        formatFilePreviewLabel(filePath, meta),
    });
    this.attachmentStore = new TransportAttachmentStore({
      sessionStore: this.sessionStore,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      objectStore: this.objectStore,
      telegramFetch: (input, init) =>
        this.telegramFetch(input, init as Parameters<typeof this.telegramFetch>[1]),
      getRequiredBotToken: (action) => this.getRequiredBotToken(action),
      getTelegramFile: (fileId) => this.bot.api.getFile(fileId),
    });
    this.lifecycleActions = new TransportLifecycleActions({
      logger: this.logger,
      config: this.config,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      bindingStore: this.bindingStore,
      isTelegramEnabled: () => this.isTelegramEnabled(),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.context.t(locale, key, options),
      sendNotification: (input) => this.sendNotification(input),
    });
    this.menuFlow = new TransportMenuFlow({
      config: this.config,
      logger: this.logger,
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      menuState: this.menuState,
      projectView: this.projectView,
      liveActions: this.liveActions,
      tmuxActions: this.tmuxActions,
      pendingRenames: this.pendingRenames,
      pendingBroadcasts: this.pendingBroadcasts,
      pendingPartnerNotes: this.pendingPartnerNotes,
      pendingFileHandoffs: this.pendingFileHandoffs,
      pendingProjects: this.pendingProjects,
      currentAttachmentTargets: this.currentAttachmentTargets,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      getGatewayActorFromContext: (ctx) => this.context.getGatewayActorFromContext(ctx),
      t: (locale, key, options) => this.context.t(locale, key, options),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      editText: (ctx, text, meta, options) =>
        this.outputActions.editText(
          ctx,
          text,
          meta,
          options as TelegramEditMessageOptions,
        ),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.documentActions.replyDocumentWithRetry(ctx, document, options, meta),
    });
    this.gatewayDirectory = new TransportGatewayDirectory({
      logger: this.logger,
      config: this.config,
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
    });
    this.gatewayActions = new TransportGatewayActions({
      getCollaborationService: () => this.collaborationService,
      projectState: this.projectState,
      gatewayDirectory: this.gatewayDirectory,
    });
    this.messageFlow = new TransportMessageFlow({
      logger: this.logger,
      config: this.config,
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      adminAuthStore: this.adminAuthStore,
      waiters: this.waiters,
      currentAttachmentTargets: this.currentAttachmentTargets,
      isAdminAuthEnabled: () => this.isAdminAuthEnabled(),
      isAdminBotProfile: () => this.isAdminBotProfile(),
      isPrincipalAdminAuthorized: (principal) =>
        this.isPrincipalAdminAuthorized(principal),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      extractIncomingText: (message) => extractIncomingText(message),
      collectIncomingAttachments: (message) =>
        collectIncomingAttachments(message),
      buildInboxText: (text, attachments) =>
        buildInboxText(text, attachments),
      clearPendingInteractionsForContext: (ctx) =>
        this.menuFlow.clearPendingInteractionsForContext(ctx),
      handlePendingRename: (ctx, text) =>
        this.sessionActions.handlePendingRename(ctx, text),
      handlePendingBroadcast: (ctx, text) =>
        this.broadcastActions.handlePendingBroadcast(ctx, text),
      handlePendingPartnerNote: (ctx, text) =>
        this.partnerActions.handlePendingPartnerNote(ctx, text),
      handlePendingFileHandoff: (ctx, text) =>
        this.fileHandoffActions.handlePending(ctx, text),
      handlePendingProject: (ctx, text) => this.projectActions.handlePendingProject(ctx, text),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      tForContext: (ctx, key, options) => this.context.tForContext(ctx, key, options),
      showSessionsMenu: (ctx, introText) =>
        this.menuFlow.showSessionsMenu(ctx, introText),
      showHelp: (ctx) => this.menuFlow.showHelp(ctx),
      showAdminMainMenu: (ctx, introText) => this.adminActions.showMainMenu(ctx, introText),
      showAdminClientsMenu: (ctx, introText) =>
        this.adminActions.showClientsMenu(ctx, introText),
      mainMenu: this.mainMenu,
      bindRelaySessionToPrincipal: (input) =>
        this.projectState.bindRelaySessionToPrincipal(input),
      clearWaiter: (requestId) => this.requestFlow.clearWaiter(requestId),
      callGatewayJson: (path, payload) =>
        this.callGatewayJson(path, payload as Record<string, unknown> | undefined),
      scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
        this.tmuxRuntime.scheduleTmuxNudgeForInboxMessage(sessionId, session),
      downloadIncomingAttachments: (session, sessionId, sourceTelegramMessageId, attachments) =>
        this.attachmentStore.downloadIncomingAttachments(
          session,
          sessionId,
          sourceTelegramMessageId,
          attachments,
        ),
      storeTelegramUploadMetas: (input) =>
        this.attachmentStore.storeTelegramUploadMetas(input),
      deliverAttachmentToPartner: (input) =>
        this.fileHandoffActions.deliverToPartnerPublic(input).then(() => {}),
    });
    this.menuShell = new TransportMenuShell({
      logger: this.logger,
      tForContext: (ctx, key) => this.context.tForContext(ctx, key),
      showPartnerMenu: (ctx) => this.menuFlow.showPartnerMenu(ctx),
      showProjectsMenu: (ctx) => this.menuFlow.showProjectsMenu(ctx),
      showAdminClientSessionList: (ctx, scope) =>
        this.adminActions.showClientSessionList(ctx, scope),
      showAdminClientSessionsMenu: (ctx) =>
        this.adminActions.showClientSessionsMenu(ctx),
      handleMessage: (ctx) => this.messageFlow.handleMessage(ctx),
      cancelPendingBroadcast: (ctx) => this.broadcastActions.cancelPendingBroadcast(ctx),
      cancelPendingPartnerNote: (ctx) => this.partnerActions.cancelPendingPartnerNote(ctx),
      cancelPendingFileHandoff: (ctx) => this.fileHandoffActions.cancelPending(ctx),
      handleAdminClientSessionLiveCallback: (ctx) =>
        this.adminActions.handleClientSessionLiveCallback(ctx),
      handleAdminClientSessionBindCallback: (ctx) =>
        this.adminActions.handleClientSessionBindCallback(ctx),
      handleAdminClientSessionOpenCallback: (ctx, readPayloadKey) =>
        this.adminActions.handleClientSessionOpenCallback(ctx, readPayloadKey),
      handleProjectSetCallback: (ctx) =>
        this.projectActions.handleProjectSetCallback(ctx),
      handleProjectMembersCallback: (ctx) =>
        this.projectActions.handleProjectMembersCallback(ctx),
      handleProjectMemberOpenCallback: (ctx) =>
        this.projectActions.handleProjectMemberOpenCallback(ctx),
      handleProjectMemberNoteCallback: (ctx) =>
        this.projectActions.handleProjectMemberNoteCallback(ctx),
      handleProjectMemberLiveCallback: (ctx) =>
        this.projectActions.handleProjectMemberLiveCallback(ctx),
      handleLiveApprovalCallback: (ctx) =>
        this.projectActions.handleLiveApprovalCallback(ctx),
      handleProjectDetailCallback: (ctx) =>
        this.projectActions.handleProjectDetailCallback(ctx),
      handleProjectDeleteCallback: (ctx) =>
        this.projectActions.handleProjectDeleteCallback(ctx),
      handleProjectLeaveCallback: (ctx) =>
        this.projectActions.handleProjectLeaveCallback(ctx),
    });
    this.eventActions = new TransportEventActions({
      logger: this.logger,
      config: this.config,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      bindingStore: this.bindingStore,
      webAppLaunchRegistry: this.webAppLaunchRegistry,
      createLiveApprovalMenuPayload: (input) =>
        this.payloadState.createLiveApprovalMenuPayload(input),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
      sendNotification: (input) => this.sendNotification(input),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.context.t(locale, key, options),
      tForTelegramUserId: (telegramUserId, key, options) =>
        this.context.tForTelegramUserId(telegramUserId, key, options),
      sendChatMessage: (telegramChatId, text, options, meta) =>
        this.outputActions.sendChatMessage(telegramChatId, text, options, meta),
      buildLiveViewUrl: (input) => this.liveActions.buildUrl(input),
      buildLiveViewKeyboard: (buildUrlForMode, locale) =>
        this.liveActions.buildKeyboard(buildUrlForMode, locale),
    });
    this.projectEvents = new TransportProjectEvents({
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.context.t(locale, key, options),
      sendNotification: (input) => this.sendNotification(input),
    });
    this.requestFlow = new TransportRequestFlow({
      logger: this.logger,
      config: this.config,
      adminAuthStore: this.adminAuthStore,
      maintenanceStore: this.maintenanceStore,
      waiters: this.waiters,
      isTelegramEnabled: () => this.isTelegramEnabled(),
      isAdminAuthEnabled: () => this.isAdminAuthEnabled(),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.context.t(locale, key, options),
      sendTextChunks: (chatId, body, meta) =>
        this.outputActions.sendTextChunks(chatId, body, meta),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
    });
    this.sessionActions = new TransportSessionActions({
      logger: this.logger,
      config: this.config,
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      maintenanceStore: this.maintenanceStore,
      pendingRenames: this.pendingRenames,
      pendingBroadcasts: this.pendingBroadcasts,
      mainMenu: this.mainMenu,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      t: (locale, key, options) => this.context.t(locale, key, options),
      replyText: (ctx, text, meta, options) =>
        this.outputActions.replyText(
          ctx,
          text,
          meta,
          options as TelegramSendMessageOptions,
        ),
      showSessionsMenu: (ctx, introText) =>
        this.menuFlow.showSessionsMenu(ctx, introText),
      clearPendingInteractionsForContext: (ctx) =>
        this.menuFlow.clearPendingInteractionsForContext(ctx),
      clearTmuxNudgeDebounceTimers: () => this.tmuxRuntime.clearTmuxNudgeDebounceTimers(),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
    });
    this.projectActions = new TransportProjectActions({
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.context.t(locale, key, vars),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      extractCallbackSuffix: (ctx, prefix) => extractCallbackSuffix(ctx, prefix),
      getGatewayActorFromContext: (ctx) => this.context.getGatewayActorFromContext(ctx),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      pendingProjects: this.pendingProjects,
      ensureGatewayClientUuid: (principal, actor) =>
        this.gatewayActions.ensureGatewayClientUuid(principal, actor),
      listGatewayProjects: (principal) => this.gatewayActions.listGatewayProjects(principal),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
      activateProjectForSession: (input) =>
        this.gatewayActions.activateProjectForSession(input),
      ensureOpenedProjectIsActive: (input) =>
        this.gatewayActions.ensureOpenedProjectIsActive(input),
      getProjectPayloadByUuid: (sessionId, projectUuid) =>
        this.projectState.getProjectPayloadByUuid(sessionId, projectUuid),
      getProjectMemberPayloadByKey: (payloadKey) =>
        this.projectState.getProjectMemberPayloadByKey(payloadKey),
      getPartnerFileTargetPayloadByKey: (payloadKey) =>
        this.projectState.getPartnerFileTargetPayloadByKey(payloadKey),
      getLiveApprovalPayloadByKey: (payloadKey) =>
        this.projectState.getLiveApprovalPayloadByKey(payloadKey),
      beginFileHandoffModeForTarget: (ctx, input) =>
        this.fileHandoffActions.beginModeForTarget(ctx, input),
      beginPartnerNoteMode: (ctx, kind, target) =>
        this.partnerActions.beginPartnerNoteMode(ctx, kind, target),
      showProjectMembers: (ctx, input) => this.projectView.showProjectMembers(ctx, input),
      showProjectMemberDetail: (ctx, input) => this.projectView.showProjectMemberDetail(ctx, input),
      showProjectMemberFiles: (ctx, input) => this.projectView.showProjectMemberFiles(ctx, input),
      showProjectsMenu: (ctx, introText) =>
        this.menuFlow.showProjectsMenu(ctx, introText),
      showCollabDeleteMenu: (ctx, introText) =>
        this.menuFlow.showCollabDeleteMenu(ctx, introText),
      replyText: (ctx, text, meta) => this.outputActions.replyText(ctx, text, meta),
      editText: (ctx, text, meta) => this.outputActions.editText(ctx, text, meta),
    });
    this.projectEntryActions = new TransportProjectEntryActions({
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      menuPayloadStore: this.menuPayloadStore,
      pendingProjects: this.pendingProjects,
      resolveLocaleForContext: (ctx) => this.context.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.context.getPrincipalFromContext(ctx),
      t: (locale, key, options) => this.context.t(locale, key, options),
      replyText: (ctx, text, meta) => this.outputActions.replyText(ctx, text, meta),
      showProjectsMenu: (ctx, introText) =>
        this.menuFlow.showProjectsMenu(ctx, introText),
      listGatewayProjects: (principal) => this.gatewayActions.listGatewayProjects(principal),
      getProjectPayloadByUuid: (sessionId, projectUuid) =>
        this.projectState.getProjectPayloadByUuid(sessionId, projectUuid),
      ensureOpenedProjectIsActive: (input) =>
        this.gatewayActions.ensureOpenedProjectIsActive(input),
      showProjectMembers: (ctx, input) => this.projectView.showProjectMembers(ctx, input),
      ensureGatewayClientUuid: (principal) =>
        this.gatewayActions.ensureGatewayClientUuid(principal),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
    });
    this.mainMenu.register([
      this.adminMainMenu,
      this.inboxMenu,
      this.storageMenu,
      this.browserMenu,
      this.projectsMenu,
      this.collabToolsMenu,
      this.collabDeleteMenu,
      this.localMenu,
      this.screenshotsMenu,
      this.linkMenu,
      this.partnerMenu,
      this.sessionsMenu,
      this.bufferMenu,
      this.settingsMenu,
      this.developerMenu,
      this.unpairConfirmMenu,
      this.pruneConfirmMenu,
      this.inboxMessageMenu,
      this.storageMessageMenu,
      this.screenshotMessageMenu,
    ]);
    this.adminMainMenu.register([
      this.adminClientsMenu,
      this.adminClientSessionsMenu,
      this.adminClientSessionDetailMenu,
      this.adminToolsMenu,
    ]);
    this.bot.use(async (ctx, next) => {
      await this.handleAdminAccessMiddleware(ctx, next);
    });
    this.bot.use(this.getRootMenu());
    this.menuShell.register(this.bot);
  }

  private isAdminAuthEnabled(): boolean {
    return Boolean(this.config.telegram.adminToken?.trim());
  }

  private isAdminBotProfile(): boolean {
    return this.isAdminAuthEnabled();
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

  private async handleAdminAccessMiddleware(
    ctx: TelegramMenuContext,
    next: () => Promise<void>,
  ): Promise<void> {
    if (!this.isAdminAuthEnabled()) {
      await next();
      return;
    }

    const principal = this.context.getPrincipalFromContext(ctx);
    const authorized = await this.isPrincipalAdminAuthorized(principal);
    if (authorized) {
      await next();
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: await this.context.tForContext(ctx, "menu:admin.auth.required_callback"),
        show_alert: true,
      });
      return;
    }

    const text = extractIncomingText(ctx.message);
    const token = text ? parseAdminAuthCommand(text) : null;
    if (principal && token) {
      await this.messageFlow.handleAdminAuthCommand(ctx, principal, token);
      return;
    }

    if (text && isGatewayAdminCommand(text)) {
      await this.outputActions.replyText(
        ctx,
        await this.context.tForContext(ctx, "menu:admin.auth.prompt"),
        {
          kind: "transport",
        },
      );
      return;
    }

    await next();
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
      ...(this.isAdminAuthEnabled()
        ? [{ command: "auth", description: "Authenticate as gateway admin" }]
        : []),
      ...(this.isAdminBotProfile()
        ? [
            { command: "link", description: "Open gateway clients list" },
            { command: "admin", description: "Open gateway admin menu" },
          ]
        : []),
      { command: "menu", description: "Open session menu" },
      { command: "help", description: "Show help" },
    ]);
    this.logger.info("Telegram bot commands registered", {
      commands: [
        ...(this.isAdminAuthEnabled() ? ["/auth"] : []),
        ...(this.isAdminBotProfile() ? ["/link", "/admin"] : []),
        "/menu",
        "/help",
      ],
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
      new InputFile(fileBuffer, path.basename(filePath)),
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

  public async recoverPendingInboxNudges(): Promise<void> {
    await this.lifecycleActions.recoverPendingInboxNudges();
  }

  public async sendStartupNotifications(): Promise<void> {
    await this.lifecycleActions.sendStartupNotifications(__dirname);
  }

  public async sendAdminGatewayRegistrationNotifications(input: {
    clientUuid: string;
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
    const workspaceDir = session?.cwd?.trim();
    if (!workspaceDir) {
      return null;
    }

    try {
      const content = await readFile(path.join(workspaceDir, "TOOLS.md"), "utf8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
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
        "Call refresh_tools_markdown for this session, then re-read the local TOOLS.md and apply it before continuing.",
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

  public async nudgeSessionPartnerNote(sessionId: string): Promise<void> {
    await this.tmuxActions.nudgeForSession(sessionId, {
      message: this.config.tmux.partnerNudgeMessage,
      reason: "partner_note",
      requireInboxMessage: false,
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
