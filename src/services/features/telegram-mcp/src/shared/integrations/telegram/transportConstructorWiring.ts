import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  MaintenanceStore,
  SessionBindingStore,
  SessionStore,
  TelegramAdminAuthStore,
  TelegramMenuPayloadStore,
  TelegramUserLocaleStore,
  TelegramXchangeFileMetaStore,
} from "../../api/storage/contract";
import type { HumanTransportNotification } from "../../api/transport/contract";
import type { Logger } from "../../lib/logger/logger";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import {
  createTelegramBaseFetchConfig,
  createTelegramFetch,
} from "./proxyFetch";
import type {
  CurrentAttachmentTargetRecord,
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
  formatSessionMenuLabel,
  formatStoragePreviewLabel,
} from "./transportFormatting";
import {
  collectIncomingAttachments,
  extractIncomingText,
  formatScreenshotDetail,
  formatStorageDetail,
} from "./transportContent";
import { TransportAttachmentStore } from "./transportAttachmentStore";
import { TransportBroadcastActions } from "./transportBroadcastActions";
import { TransportContext } from "./transportContext";
import { TransportConsoleRegistry } from "./transportConsoleRegistry";
import { TransportDocumentActions } from "./transportDocumentActions";
import { TransportEventActions } from "./transportEventActions";
import { TransportFileHandoffActions } from "./transportFileHandoffActions";
import { TransportGatewayActions } from "./transportGatewayActions";
import { TransportLifecycleActions } from "./transportLifecycleActions";
import { TransportLinkingActions } from "./transportLinkingActions";
import { TransportLiveActions } from "./transportLiveActions";
import { TransportMenuCallbacks } from "./transportMenuCallbacks";
import { TransportMenuFactories } from "./transportMenuFactories";
import { TransportMenuFingerprints } from "./transportMenuFingerprints";
import { TransportMenuFlow } from "./transportMenuFlow";
import { TransportMenuShell } from "./transportMenuShell";
import { TransportMenuState } from "./transportMenuState";
import { TransportMessageFlow } from "./transportMessageFlow";
import { TransportOutputActions } from "./transportOutputActions";
import { TransportPartnerActions } from "./transportPartnerActions";
import { TransportPayloadState } from "./transportPayloadState";
import { TransportProjectActions } from "./transportProjectActions";
import { TransportProjectEntryActions } from "./transportProjectEntryActions";
import { TransportProjectEvents } from "./transportProjectEvents";
import { TransportProjectMenus } from "./transportProjectMenus";
import { TransportProjectState } from "./transportProjectState";
import { TransportProjectView } from "./transportProjectView";
import { TransportRequestFlow } from "./transportRequestFlow";
import { TransportSessionActions } from "./transportSessionActions";
import { TransportTmuxActions } from "./transportTmuxActions";
import { TransportTmuxRuntime } from "./transportTmuxRuntime";
import { TransportXchangeState } from "./transportXchangeState";
import { extractCallbackSuffix, readMenuPayloadKey } from "./transportUtils";

export interface TransportConstructorWiringHost {
  config: AppConfig;
  sessionStore: SessionStore;
  adminAuthStore: TelegramAdminAuthStore;
  bindingStore: SessionBindingStore;
  menuPayloadStore: TelegramMenuPayloadStore;
  localeStore: TelegramUserLocaleStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
  maintenanceStore: MaintenanceStore;
  objectStore: MinioExchangeStore;
  webAppLaunchRegistry: WebAppLaunchRegistry;
  logger: Logger;
  waiters: Map<string, WaiterRecord>;
  tmuxNudgeDebounceTimers: Map<string, NodeJS.Timeout>;
  tmuxNudgeFailureNoticeAt: Map<string, number>;
  tmuxPromptNoticeState: Map<string, { fingerprint: string; sentAtMs: number }>;
  pendingRenames: Map<string, PendingRenameRecord>;
  pendingBroadcasts: Map<string, PendingBroadcastRecord>;
  pendingPartnerNotes: Map<string, PendingPartnerNoteRecord>;
  pendingFileHandoffs: Map<string, PendingFileHandoffRecord>;
  pendingProjects: Map<string, PendingProjectRecord>;
  currentAttachmentTargets: Map<string, CurrentAttachmentTargetRecord>;
  getCollaborationService(): CollaborationService | undefined;
  createMenuOptions(
    handler: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> };
  getRequiredBotToken(action: string): string;
  deleteMessage(telegramChatId: number, telegramMessageId: number): Promise<void>;
  sendDocumentToChat(
    telegramChatId: number,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number }>;
  sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }>;
  nudgeSessionInbox(sessionId: string): Promise<void>;
  maybeNotifyToolsMismatchForSession(sessionId: string): Promise<void>;
  callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
  isAdminAuthEnabled(): boolean;
  isAdminBotProfile(): boolean;
  isPrincipalAdminAuthorized(
    principal: { telegramChatId: number; telegramUserId: number } | null,
  ): Promise<boolean>;
  setPrincipalAdminAuthorized(principal: {
    telegramChatId: number;
    telegramUserId: number;
  }): Promise<void>;
  ensureGatewayUserForPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
  }): Promise<{ gateway_user_uuid: string }>;
}

export interface TransportConstructorWiringResult {
  telegramFetch: TelegramClientFetch;
  bot: Bot<TelegramMenuContext>;
  mainMenu: Menu<TelegramMenuContext>;
  storageMenu: Menu<TelegramMenuContext>;
  browserMenu: Menu<TelegramMenuContext>;
  projectsMenu: Menu<TelegramMenuContext>;
  collabToolsMenu: Menu<TelegramMenuContext>;
  collabDeleteMenu: Menu<TelegramMenuContext>;
  localMenu: Menu<TelegramMenuContext>;
  screenshotsMenu: Menu<TelegramMenuContext>;
  linkMenu: Menu<TelegramMenuContext>;
  partnerMenu: Menu<TelegramMenuContext>;
  sessionsMenu: Menu<TelegramMenuContext>;
  bufferMenu: Menu<TelegramMenuContext>;
  settingsMenu: Menu<TelegramMenuContext>;
  developerMenu: Menu<TelegramMenuContext>;
  unpairConfirmMenu: Menu<TelegramMenuContext>;
  pruneConfirmMenu: Menu<TelegramMenuContext>;
  storageMessageMenu: Menu<TelegramMenuContext>;
  screenshotMessageMenu: Menu<TelegramMenuContext>;
  tmuxActions: TransportTmuxActions;
  liveActions: TransportLiveActions;
  lifecycleActions: TransportLifecycleActions;
  attachmentStore: TransportAttachmentStore;
  broadcastActions: TransportBroadcastActions;
  context: TransportContext;
  documentActions: TransportDocumentActions;
  eventActions: TransportEventActions;
  partnerActions: TransportPartnerActions;
  fileHandoffActions: TransportFileHandoffActions;
  linkingActions: TransportLinkingActions;
  menuFactories: TransportMenuFactories;
  menuFingerprints: TransportMenuFingerprints;
  menuFlow: TransportMenuFlow;
  menuShell: TransportMenuShell;
  consoleRegistry: TransportConsoleRegistry;
  gatewayActions: TransportGatewayActions;
  messageFlow: TransportMessageFlow;
  menuCallbacks: TransportMenuCallbacks;
  menuState: TransportMenuState;
  payloadState: TransportPayloadState;
  projectMenus: TransportProjectMenus;
  projectEvents: TransportProjectEvents;
  projectState: TransportProjectState;
  projectView: TransportProjectView;
  projectActions: TransportProjectActions;
  projectEntryActions: TransportProjectEntryActions;
  requestFlow: TransportRequestFlow;
  sessionActions: TransportSessionActions;
  outputActions: TransportOutputActions;
  tmuxRuntime: TransportTmuxRuntime;
  xchangeState: TransportXchangeState;
}

export function buildTransportConstructorWiring(
  host: TransportConstructorWiringHost,
): TransportConstructorWiringResult {
  const telegramBaseFetchConfig = createTelegramBaseFetchConfig(
    host.config,
    host.logger,
  );
  const telegramFetch = createTelegramFetch(
    host.config,
    host.logger,
  ) as unknown as TelegramClientFetch;
  const bot = Object.keys(telegramBaseFetchConfig).length > 0
    ? new Bot<TelegramMenuContext>(
        host.config.telegram.botToken ?? "0:disabled",
        ({
          client: {
            baseFetchConfig: telegramBaseFetchConfig,
          },
        } as never),
      )
    : new Bot<TelegramMenuContext>(host.config.telegram.botToken ?? "0:disabled");

  const context = new TransportContext({
    config: host.config,
    localeStore: host.localeStore,
  });
  const payloadState = new TransportPayloadState({
    menuPayloadStore: host.menuPayloadStore,
    menuPayloadTtlSeconds: host.config.telegram.menuPayloadTtlSeconds,
  });
  const xchangeState = new TransportXchangeState({
    config: host.config,
    sessionStore: host.sessionStore,
    xchangeFileMetaStore: host.xchangeFileMetaStore,
  });
  const outputActions = new TransportOutputActions({
    config: host.config,
    logger: host.logger,
    bot,
  });
  const consoleRegistry = new TransportConsoleRegistry({
    config: host.config,
    logger: host.logger,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
  });

  const liveActions = new TransportLiveActions({
    config: host.config,
    webAppLaunchRegistry: host.webAppLaunchRegistry,
    logger: host.logger,
    t: (locale, key, vars) => context.t(locale, key, vars),
    ensureGatewayClientUuid: (principal, actor) =>
      gatewayActions.ensureGatewayClientUuid(principal, actor),
    sendChatMessage: (telegramChatId, text, options, meta) =>
      outputActions.sendChatMessage(telegramChatId, text, options, meta),
  });

  const tmuxActions: TransportTmuxActions = new TransportTmuxActions({
    config: host.config,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    logger: host.logger,
    tmuxNudgeFailureNoticeAt: host.tmuxNudgeFailureNoticeAt,
    tmuxPromptNoticeState: host.tmuxPromptNoticeState,
    sendTypingForSession: (sessionId) => tmuxRuntime.sendTypingForSession(sessionId),
    resolveLocaleForTelegramUserId: (userId) =>
      context.resolveLocaleForTelegramUserId(userId),
    sendNotification: (input) => requestFlow.sendNotification(input),
    sendLiveViewLauncherMessage: (input) => liveActions.sendLauncherMessage(input),
    t: (locale, key, vars) => context.t(locale, key, vars),
  });

  const tmuxRuntime: TransportTmuxRuntime = new TransportTmuxRuntime({
    config: host.config,
    logger: host.logger,
    bot,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    isTelegramEnabled: () => host.config.distributed.mode !== "client" && Boolean(host.config.telegram.botToken?.trim()),
    tmuxActions,
    tmuxNudgeDebounceTimers: host.tmuxNudgeDebounceTimers,
  });

  const menuFingerprints = new TransportMenuFingerprints({
    logger: host.logger,
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    getMenuPayloadByKey: (key) => host.menuPayloadStore.getMenuPayload(key),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    listActiveSessionStorageEntries: (sessionId) =>
      xchangeState.listActiveSessionStorageEntries(sessionId),
    listActiveSessionScreenshots: (sessionId) =>
      xchangeState.listActiveSessionScreenshots(sessionId),
  });

  const documentActions = new TransportDocumentActions({
    logger: host.logger,
  });

  const linkingActions = new TransportLinkingActions({
    config: host.config,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    tForContext: (ctx, key, vars) => context.tForContext(ctx, key, vars),
    showMainMenu: (ctx, introText) => menuState.showMainMenu(ctx, introText),
    showLinkMenu: (ctx) => menuFlow.showLinkMenu(ctx),
    showLocalMenu: (ctx) => menuFlow.showLocalMenu(ctx),
    showProjectsMenu: (ctx) => menuFlow.showProjectsMenu(ctx),
  });

  const projectMenus: TransportProjectMenus = new TransportProjectMenus({
    createMenuOptions: (onMenuOutdated) => host.createMenuOptions(onMenuOutdated),
    buildProjectsFingerprint: (ctx) => gatewayActions.buildProjectsFingerprint(ctx),
    loadProjectsContext: (ctx) => gatewayActions.loadProjectsContext(ctx),
    tForContext: (ctx, key, vars) => context.tForContext(ctx, key, vars),
    createProjectMenuPayload: (sessionId, projectUuid, title) =>
      payloadState.createProjectMenuPayload(sessionId, projectUuid, title),
    createProjectDeleteMenuPayload: (sessionId, projectUuid, title) =>
      payloadState.createProjectDeleteMenuPayload(sessionId, projectUuid, title),
    handleProjectSelect: (ctx) => projectEntryActions.handleProjectSelect(ctx),
    handleProjectDeleteSelect: (ctx) => projectEntryActions.handleProjectDeleteSelect(ctx),
    beginProjectMode: (ctx, mode) => projectEntryActions.beginProjectMode(ctx, mode),
    beginProjectBroadcast: (ctx) => broadcastActions.beginProjectBroadcast(ctx),
    handleCollabHistoryExport: (ctx) => menuFlow.handleCollabHistoryExport(ctx),
    showCollabToolsMenu: (ctx) => menuFlow.showCollabToolsMenu(ctx),
    showCollabDeleteMenu: (ctx) => menuFlow.showCollabDeleteMenu(ctx),
    showProjectsMenu: (ctx) => menuFlow.showProjectsMenu(ctx),
    showMainMenu: (ctx) => menuState.showMainMenu(ctx),
  });

  const menuFactories: TransportMenuFactories = new TransportMenuFactories({
    logger: host.logger,
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    createMenuOptions: (onMenuOutdated) => host.createMenuOptions(onMenuOutdated),
    tForContext: (ctx, key, vars) => context.tForContext(ctx, key, vars),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    buildMainMenuFingerprint: (ctx) =>
      menuFingerprints.buildMainMenuFingerprint(ctx),
    buildStorageFingerprint: (ctx) =>
      menuFingerprints.buildStorageFingerprint(ctx),
    buildScreenshotsFingerprint: (ctx) =>
      menuFingerprints.buildScreenshotsFingerprint(ctx),
    buildSessionsFingerprint: (ctx) =>
      menuFingerprints.buildSessionsFingerprint(ctx),
    buildLinkFingerprint: (ctx) =>
      menuFingerprints.buildLinkFingerprint(ctx),
    buildScreenshotsButtonLabel: (ctx) =>
      menuFingerprints.buildScreenshotsButtonLabel(ctx),
    buildLinkButtonLabel: (ctx) =>
      menuFingerprints.buildLinkButtonLabel(ctx),
    showLiveViewLauncher: (ctx) => menuFlow.showLiveViewLauncher(ctx),
    showBufferMenu: (ctx) => menuFlow.showBufferMenu(ctx),
    showBrowserMenu: (ctx) => menuFlow.showBrowserMenu(ctx),
    showMainMenu: (ctx) => menuState.showMainMenu(ctx),
    showLocalEntryPoint: (ctx) => linkingActions.showLocalEntryPoint(ctx),
    showProjectsEntryPoint: (ctx) => linkingActions.showProjectsEntryPoint(ctx),
    showStorageMenu: (ctx) => menuFlow.showStorageMenu(ctx),
    showSettingsMenu: (ctx) => menuFlow.showSettingsMenu(ctx),
    showSessionsMenu: (ctx) => menuFlow.showSessionsMenu(ctx),
    showScreenshotsMenu: (ctx) => menuFlow.showScreenshotsMenu(ctx),
    showLocalMenu: (ctx) => menuFlow.showLocalMenu(ctx),
    showLinkMenu: (ctx) => menuFlow.showLinkMenu(ctx),
    showPartnerMenu: (ctx) => menuFlow.showPartnerMenu(ctx),
    showPartnerEntryPoint: (ctx) => menuCallbacks.showPartnerEntryPoint(ctx),
    handleLinkButton: (ctx) => linkingActions.handleLinkButton(ctx),
    handleLinkTargetSelect: (ctx) =>
      menuCallbacks.handleLinkTargetSelect(ctx, readMenuPayloadKey(ctx)),
    beginPartnerNoteMode: (ctx, kind) =>
      partnerActions.beginPartnerNoteMode(ctx, kind),
    sendActiveSessionBuffer: (ctx, input) =>
      menuFlow.sendActiveSessionBuffer(ctx, input),
    showUnpairConfirmMenu: (ctx) => menuFlow.showUnpairConfirmMenu(ctx),
    showDeveloperMenu: (ctx) => menuFlow.showDeveloperMenu(ctx),
    showDeveloperInfo: (ctx) => menuFlow.showDeveloperInfo(ctx),
    showPruneConfirmMenu: (ctx) => menuFlow.showPruneConfirmMenu(ctx),
    showActiveSessionInfo: (ctx) => menuFlow.showActiveSessionInfo(ctx),
    beginRenameActiveSession: (ctx) =>
      sessionActions.beginRenameActiveSession(ctx),
    beginBroadcast: (ctx) => broadcastActions.beginBroadcast(ctx),
    pruneAllSessions: (ctx) => sessionActions.pruneAllSessions(ctx),
    unpairActiveSession: (ctx) => sessionActions.unpairActiveSession(ctx),
    handleStorageOpen: (ctx) =>
      menuCallbacks.handleStorageOpen(ctx, readMenuPayloadKey(ctx)),
    handleStorageGet: (ctx) =>
      menuCallbacks.handleStorageGet(ctx, readMenuPayloadKey(ctx)),
    handleStorageDelete: (ctx) =>
      menuCallbacks.handleStorageDelete(ctx, readMenuPayloadKey(ctx)),
    handleScreenshotOpen: (ctx) =>
      menuCallbacks.handleScreenshotOpen(ctx, readMenuPayloadKey(ctx)),
    handleScreenshotGet: (ctx) =>
      menuCallbacks.handleScreenshotGet(ctx, readMenuPayloadKey(ctx)),
    handleScreenshotDelete: (ctx) =>
      menuCallbacks.handleScreenshotDelete(ctx, readMenuPayloadKey(ctx)),
    handleSessionSelection: (ctx) =>
      menuCallbacks.handleSessionSelection(ctx, readMenuPayloadKey(ctx)),
    handleSessionGroupSelection: (ctx) =>
      menuCallbacks.handleSessionGroupSelection(ctx, readMenuPayloadKey(ctx)),
    getMenuPayloadByKey: (key) => host.menuPayloadStore.getMenuPayload(key),
    createFileMenuPayload: (sessionId, filePath) =>
      payloadState.createFileMenuPayload(sessionId, filePath),
    createSessionMenuPayload: (sessionId, ownerLabel, ownerKey) =>
      payloadState.createSessionMenuPayload(sessionId, ownerLabel, ownerKey),
    createSessionGroupMenuPayload: (ownerLabel, ownerKey) =>
      payloadState.createSessionGroupMenuPayload(ownerLabel, ownerKey),
    createLinkMenuPayload: (sessionId, targetSessionId) =>
      payloadState.createLinkMenuPayload(sessionId, targetSessionId),
    formatStoragePreviewLabel: (filePath, meta) =>
      formatStoragePreviewLabel(filePath, meta),
    formatFilePreviewLabel: (filePath) => formatFilePreviewLabel(filePath),
    formatSessionMenuLabel: (input) => formatSessionMenuLabel(input),
    listActiveSessionStorageEntries: (sessionId) =>
      xchangeState.listActiveSessionStorageEntries(sessionId),
    listActiveSessionScreenshots: (sessionId) =>
      xchangeState.listActiveSessionScreenshots(sessionId),
  });

  const mainMenu: Menu<TelegramMenuContext> = menuFactories.createMainMenu();
  const storageMenu: Menu<TelegramMenuContext> = menuFactories.createStorageMenu();
  const browserMenu: Menu<TelegramMenuContext> = menuFactories.createBrowserMenu();
  const localMenu: Menu<TelegramMenuContext> = menuFactories.createLocalMenu();
  const screenshotsMenu: Menu<TelegramMenuContext> = menuFactories.createScreenshotsMenu();
  const linkMenu: Menu<TelegramMenuContext> = menuFactories.createLinkMenu();
  const partnerMenu: Menu<TelegramMenuContext> = menuFactories.createPartnerMenu();
  const sessionsMenu: Menu<TelegramMenuContext> = menuFactories.createSessionsMenu();
  const bufferMenu: Menu<TelegramMenuContext> = menuFactories.createBufferMenu();
  const settingsMenu: Menu<TelegramMenuContext> = menuFactories.createSettingsMenu();
  const developerMenu: Menu<TelegramMenuContext> = menuFactories.createDeveloperMenu();
  const unpairConfirmMenu: Menu<TelegramMenuContext> = menuFactories.createUnpairConfirmMenu();
  const pruneConfirmMenu: Menu<TelegramMenuContext> = menuFactories.createPruneConfirmMenu();
  const storageMessageMenu: Menu<TelegramMenuContext> = menuFactories.createStorageMessageMenu();
  const screenshotMessageMenu: Menu<TelegramMenuContext> = menuFactories.createScreenshotMessageMenu();
  const projectsMenu: Menu<TelegramMenuContext> = projectMenus.createProjectsMenu();
  const collabToolsMenu: Menu<TelegramMenuContext> = projectMenus.createCollabToolsMenu();
  const collabDeleteMenu: Menu<TelegramMenuContext> = projectMenus.createCollabDeleteMenu();

  const menuState: TransportMenuState = new TransportMenuState({
    logger: host.logger,
    t: (locale, key, vars) => context.t(locale, key, vars),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    getTmuxStatusLine: async (locale) =>
      context.t(locale, "menu:main.screen.tmux_mode_direct"),
    setCurrentAttachmentTargetForContext: (ctx, target) =>
      menuFlow.setCurrentAttachmentTargetForContext(ctx, target),
    renderMenuHtmlScreen: (ctx, text, meta, menu) =>
      menuFlow.renderMenuHtmlScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
    renderMenuScreen: (ctx, text, meta, menu) =>
      menuFlow.renderMenuScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
    renderMenuMarkdownScreen: (ctx, text, meta, menu) =>
      menuFlow.renderMenuMarkdownScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(
        ctx,
        text,
        meta,
        options as TelegramSendMessageOptions,
      ),
    getMenuPayloadByKey: (key) => host.menuPayloadStore.getMenuPayload(key),
    getMainMenu: () => mainMenu,
    getSessionsMenu: () => sessionsMenu,
    getStorageMenu: () => storageMenu,
    getBrowserMenu: () => browserMenu,
    getScreenshotsMenu: () => screenshotsMenu,
    getLinkMenu: () => linkMenu,
    getPartnerMenu: () => partnerMenu,
    getLocalMenu: () => localMenu,
    getSettingsMenu: () => settingsMenu,
    getBufferMenu: () => bufferMenu,
    getDeveloperMenu: () => developerMenu,
    getUnpairConfirmMenu: () => unpairConfirmMenu,
    getPruneConfirmMenu: () => pruneConfirmMenu,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    listActiveSessionScreenshots: (sessionId) =>
      xchangeState.listActiveSessionScreenshots(sessionId),
    listActiveSessionStorageEntries: (sessionId) =>
      xchangeState.listActiveSessionStorageEntries(sessionId),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
  });

  const projectState: TransportProjectState = new TransportProjectState({
    config: host.config,
    getGatewayActorFromContext: (ctx) => context.getGatewayActorFromContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    maintenanceStore: host.maintenanceStore,
    menuPayloadStore: host.menuPayloadStore,
  });
  const gatewayActions: TransportGatewayActions = new TransportGatewayActions({
    getCollaborationService: () => host.getCollaborationService(),
    projectState,
  });

  const attachmentStore = new TransportAttachmentStore({
    sessionStore: host.sessionStore,
    xchangeFileMetaStore: host.xchangeFileMetaStore,
    objectStore: host.objectStore,
    telegramFetch: (input, init) =>
      telegramFetch(input, init as Parameters<typeof telegramFetch>[1]),
    getRequiredBotToken: (action) => host.getRequiredBotToken(action),
    getTelegramFile: (fileId) => bot.api.getFile(fileId),
  });

  const lifecycleActions = new TransportLifecycleActions({
    logger: host.logger,
    config: host.config,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    isTelegramEnabled: () =>
      host.config.distributed.mode !== "client" &&
      Boolean(host.config.telegram.botToken?.trim()),
    resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
      context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
    t: (locale, key, options) => context.t(locale, key, options),
    sendNotification: (input) => host.sendNotification(input),
  });

  const projectView: TransportProjectView = new TransportProjectView({
    config: host.config,
    projectsMenu,
    collabToolsMenu,
    collabDeleteMenu,
    t: (locale, key, vars) => context.t(locale, key, vars),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
      context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    getGatewayActorFromContext: (ctx) => context.getGatewayActorFromContext(ctx),
    ensureGatewayClientUuid: (principal, actor) =>
      gatewayActions.ensureGatewayClientUuid(principal, actor),
    loadProjectsContext: (ctx) => gatewayActions.loadProjectsContext(ctx),
    listGatewayProjects: (principal, actor) =>
      gatewayActions.listGatewayProjects(principal, actor),
    listGatewayProjectSessions: (principal, projectUuid) =>
      gatewayActions.listGatewayProjectSessions(principal, projectUuid),
    listGatewaySessionHistory: (principal, localSessionId) =>
      gatewayActions.listGatewaySessionHistory(principal, localSessionId),
    collectCollabBroadcastTargets: (principal, _sessionId) =>
      broadcastActions.listCollabBroadcastTargets(principal),
    ensureOpenedProjectIsActive: (input) =>
      gatewayActions.ensureOpenedProjectIsActive(input),
    setCurrentAttachmentTargetForContext: (ctx, target) =>
      menuFlow.setCurrentAttachmentTargetForContext(ctx, target),
    renderMenuScreen: (ctx, text, meta, menu) =>
      menuFlow.renderMenuScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(
        ctx,
        text,
        meta,
        options as TelegramSendMessageOptions,
      ),
    editText: (ctx, text, meta, options) =>
      outputActions.editText(
        ctx,
        text,
        meta,
        options as TelegramEditMessageOptions,
      ),
    replyDocumentWithRetry: (ctx, document, options, meta) =>
      documentActions.replyDocumentWithRetry(ctx, document, options, meta),
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    maintenanceStore: host.maintenanceStore,
    xchangeFileMetaStore: host.xchangeFileMetaStore,
    webAppLaunchRegistry: host.webAppLaunchRegistry,
    createProjectMemberMenuPayload: (sessionId, projectUuid, targetSessionId, title, extra) =>
      payloadState.createProjectMemberMenuPayload(
        sessionId,
        projectUuid,
        targetSessionId,
        title,
        extra,
      ),
    listActiveSessionFiles: (sessionId) => xchangeState.listActiveSessionFiles(sessionId),
    formatFilePreviewLabel: (filePath, meta) => formatFilePreviewLabel(filePath, meta),
  });

  const menuFlow: TransportMenuFlow = new TransportMenuFlow({
    config: host.config,
    logger: host.logger,
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    menuState,
    projectView,
    liveActions,
    tmuxActions,
    pendingRenames: host.pendingRenames,
    pendingBroadcasts: host.pendingBroadcasts,
    pendingPartnerNotes: host.pendingPartnerNotes,
    pendingFileHandoffs: host.pendingFileHandoffs,
    pendingProjects: host.pendingProjects,
    currentAttachmentTargets: host.currentAttachmentTargets,
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    ensureGatewayScopeConsolesBound: ({ principal, ctx }) =>
      consoleRegistry.ensureScopedConsolesBound({ principal, ctx }),
    getGatewayActorFromContext: (ctx) => context.getGatewayActorFromContext(ctx),
    t: (locale, key, options) => context.t(locale, key, options),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(
        ctx,
        text,
        meta,
        options as TelegramSendMessageOptions,
      ),
    editText: (ctx, text, meta, options) =>
      outputActions.editText(
        ctx,
        text,
        meta,
        options as TelegramEditMessageOptions,
      ),
    replyDocumentWithRetry: (ctx, document, options, meta) =>
      documentActions.replyDocumentWithRetry(ctx, document, options, meta),
    captureRelaySessionBuffer: (sessionId, scope) =>
      host.callGatewayJson("/live/capture-buffer", {
        session_id: sessionId,
        scope,
      }),
  });

  const broadcastActions: TransportBroadcastActions = new TransportBroadcastActions({
    config: host.config,
    logger: host.logger,
    pendingBroadcasts: host.pendingBroadcasts,
    pendingRenames: host.pendingRenames,
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    tForContext: (ctx, key, vars) => context.tForContext(ctx, key, vars),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    deleteMessage: (chatId, messageId) => host.deleteMessage(chatId, messageId),
    showCollabToolsMenu: (ctx) => menuFlow.showCollabToolsMenu(ctx),
    showDeveloperMenu: (ctx) => menuFlow.showDeveloperMenu(ctx),
    ensureGatewayClientUuid: (principal) => gatewayActions.ensureGatewayClientUuid(principal),
    listGatewayProjects: (principal) => gatewayActions.listGatewayProjects(principal),
    listGatewayProjectSessions: (principal, projectUuid) =>
      gatewayActions.listGatewayProjectSessions(principal, projectUuid),
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    routeTelegramInboxToRelaySession: (input) =>
      messageFlow.routeTelegramInboxToRelaySession(input),
    scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
      tmuxRuntime.scheduleTmuxNudgeForInboxMessage(sessionId, session),
    sendPartnerNote: (input) => gatewayActions.sendPartnerNote(input),
  });

  const partnerActions: TransportPartnerActions = new TransportPartnerActions({
    config: host.config,
    logger: host.logger,
    pendingPartnerNotes: host.pendingPartnerNotes,
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    deleteMessage: (chatId, messageId) => host.deleteMessage(chatId, messageId),
    showProjectsMenu: (ctx, introText) => menuFlow.showProjectsMenu(ctx, introText),
    showMainMenu: (ctx, introText) => menuState.showMainMenu(ctx, introText),
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    maintenanceStore: host.maintenanceStore,
    ensureProjectSessionRegistered: (input) => gatewayActions.ensureProjectSessionRegistered(input),
    sendPartnerNote: (input) => gatewayActions.sendPartnerNote(input),
    nudgeSessionInbox: (sessionId) => host.nudgeSessionInbox(sessionId),
  });

  const fileHandoffActions: TransportFileHandoffActions = new TransportFileHandoffActions({
    logger: host.logger,
    config: host.config,
    pendingFileHandoffs: host.pendingFileHandoffs,
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    deleteMessage: (chatId, messageId) => host.deleteMessage(chatId, messageId),
    showPartnerMenu: (ctx) => menuFlow.showPartnerMenu(ctx),
    showLocalMenu: (ctx) => menuFlow.showLocalMenu(ctx),
    showProjectMemberDetail: (ctx, input) =>
      projectView.showProjectMemberDetail(ctx, {
        ...input,
        inviteToken: input.inviteToken ?? "",
      }),
    getProjectPayloadByUuid: (sessionId, projectUuid) =>
      projectState.getProjectPayloadByUuid(sessionId, projectUuid),
    ensureProjectSessionRegistered: (input) => gatewayActions.ensureProjectSessionRegistered(input),
    sendPartnerNote: (input) => gatewayActions.sendPartnerNote(input),
    xchangeFileMetaStore: host.xchangeFileMetaStore,
    sessionStore: host.sessionStore,
    maintenanceStore: host.maintenanceStore,
    objectStore: host.objectStore,
    nudgeSessionInbox: (sessionId) => host.nudgeSessionInbox(sessionId),
  });

  const menuCallbacks: TransportMenuCallbacks = new TransportMenuCallbacks({
    logger: host.logger,
    getMenuPayloadByKey: (key) => host.menuPayloadStore.getMenuPayload(key),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    tForContext: (ctx, key, vars) => context.tForContext(ctx, key, vars),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    editText: (ctx, text, meta, options) =>
      outputActions.editText(ctx, text, meta, options as TelegramEditMessageOptions),
    showMainMenu: (ctx, introText) => menuState.showMainMenu(ctx, introText),
    showSessionsMenu: (ctx, introText) => menuFlow.showSessionsMenu(ctx, introText),
    showLinkMenu: (ctx) => menuFlow.showLinkMenu(ctx),
    showPartnerMenu: (ctx) => menuFlow.showPartnerMenu(ctx),
    showScreenshotsMenu: (ctx, introText) => menuFlow.showScreenshotsMenu(ctx, introText),
    showStorageMenu: (ctx, introText) => menuFlow.showStorageMenu(ctx, introText),
    storageMessageMenu,
    screenshotMessageMenu,
    xchangeFileMetaStore: host.xchangeFileMetaStore,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    objectStore: host.objectStore,
    formatScreenshotDetail: (sessionId, filePath, meta) =>
      formatScreenshotDetail(sessionId, filePath, meta),
    formatStorageDetail: (sessionId, filePath, meta) =>
      formatStorageDetail(sessionId, filePath, meta),
    formatFilePreviewLabel: (filePath, meta) => formatFilePreviewLabel(filePath, meta),
    listActiveSessionFiles: (sessionId) => xchangeState.listActiveSessionFiles(sessionId),
    createPartnerFileTargetPayload: (sessionId, targetSessionId, title, filePath) =>
      payloadState.createPartnerFileTargetPayload(sessionId, targetSessionId, title, filePath),
    ensureStoredXchangeFile: (sessionId, filePath, source) =>
      attachmentStore.ensureStoredXchangeFile(sessionId, filePath, source),
    sendDocumentToChat: (chatId, filePath, caption) =>
      host.sendDocumentToChat(chatId, filePath, caption),
    linkSessions: (sessionId, targetSessionId) =>
      linkingActions.linkSessions(sessionId, targetSessionId),
    maybeNotifyToolsMismatchForSession: (sessionId) =>
      host.maybeNotifyToolsMismatchForSession(sessionId),
  });

  const requestFlow: TransportRequestFlow = new TransportRequestFlow({
    logger: host.logger,
    config: host.config,
    adminAuthStore: host.adminAuthStore,
    maintenanceStore: host.maintenanceStore,
    waiters: host.waiters,
    isTelegramEnabled: () =>
      host.config.distributed.mode !== "client" &&
      Boolean(host.config.telegram.botToken?.trim()),
    isAdminAuthEnabled: () => host.isAdminAuthEnabled(),
    resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
      context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
    t: (locale, key, options) => context.t(locale, key, options),
    sendTextChunks: (chatId, body, meta) =>
      outputActions.sendTextChunks(chatId, body, meta),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
  });

  const projectEvents = new TransportProjectEvents({
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
      context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
    t: (locale, key, options) => context.t(locale, key, options),
    sendNotification: (input) => host.sendNotification(input),
  });

  const sessionActions: TransportSessionActions = new TransportSessionActions({
    logger: host.logger,
    config: host.config,
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    maintenanceStore: host.maintenanceStore,
    pendingRenames: host.pendingRenames,
    pendingBroadcasts: host.pendingBroadcasts,
    getMainMenu: () => mainMenu,
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    t: (locale, key, options) => context.t(locale, key, options),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    showSessionsMenu: (ctx, introText) => menuFlow.showSessionsMenu(ctx, introText),
    clearPendingInteractionsForContext: (ctx) =>
      menuFlow.clearPendingInteractionsForContext(ctx),
    clearTmuxNudgeDebounceTimers: () => tmuxRuntime.clearTmuxNudgeDebounceTimers(),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
  });

  const projectActions: TransportProjectActions = new TransportProjectActions({
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    t: (locale, key, vars) => context.t(locale, key, vars),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    extractCallbackSuffix: (ctx, prefix) => extractCallbackSuffix(ctx, prefix),
    getGatewayActorFromContext: (ctx) => context.getGatewayActorFromContext(ctx),
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    pendingProjects: host.pendingProjects,
    ensureGatewayClientUuid: (principal, actor) =>
      gatewayActions.ensureGatewayClientUuid(principal, actor),
    listGatewayProjects: (principal) => gatewayActions.listGatewayProjects(principal),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
    activateProjectForSession: (input) => gatewayActions.activateProjectForSession(input),
    ensureProjectSessionRegistered: (input) =>
      gatewayActions.ensureProjectSessionRegistered(input),
    ensureOpenedProjectIsActive: (input) =>
      gatewayActions.ensureOpenedProjectIsActive(input),
    getProjectPayloadByUuid: (sessionId, projectUuid) =>
      projectState.getProjectPayloadByUuid(sessionId, projectUuid),
    getProjectMemberPayloadByKey: (payloadKey) =>
      projectState.getProjectMemberPayloadByKey(payloadKey),
    getPartnerFileTargetPayloadByKey: (payloadKey) =>
      projectState.getPartnerFileTargetPayloadByKey(payloadKey),
    getLiveApprovalPayloadByKey: (payloadKey) =>
      projectState.getLiveApprovalPayloadByKey(payloadKey),
    beginFileHandoffModeForTarget: (ctx, input) =>
      fileHandoffActions.beginModeForTarget(ctx, input),
    beginPartnerNoteMode: (ctx, kind, target) =>
      partnerActions.beginPartnerNoteMode(ctx, kind, target),
    showProjectMembers: (ctx, input) => projectView.showProjectMembers(ctx, input),
    showProjectMemberDetail: (ctx, input) =>
      projectView.showProjectMemberDetail(ctx, input),
    showProjectMemberFiles: (ctx, input) => projectView.showProjectMemberFiles(ctx, input),
    showProjectsMenu: (ctx, introText) => menuFlow.showProjectsMenu(ctx, introText),
    showCollabDeleteMenu: (ctx, introText) =>
      menuFlow.showCollabDeleteMenu(ctx, introText),
    replyText: (ctx, text, meta) => outputActions.replyText(ctx, text, meta),
    editText: (ctx, text, meta) => outputActions.editText(ctx, text, meta),
  });

  const projectEntryActions: TransportProjectEntryActions = new TransportProjectEntryActions({
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    menuPayloadStore: host.menuPayloadStore,
    pendingProjects: host.pendingProjects,
    resolveLocaleForContext: (ctx) => context.resolveLocaleForContext(ctx),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    t: (locale, key, options) => context.t(locale, key, options),
    replyText: (ctx, text, meta) => outputActions.replyText(ctx, text, meta),
    showProjectsMenu: (ctx, introText) => menuFlow.showProjectsMenu(ctx, introText),
    listGatewayProjects: (principal) => gatewayActions.listGatewayProjects(principal),
    getProjectPayloadByUuid: (sessionId, projectUuid) =>
      projectState.getProjectPayloadByUuid(sessionId, projectUuid),
    ensureOpenedProjectIsActive: (input) =>
      gatewayActions.ensureOpenedProjectIsActive(input),
    showProjectMembers: (ctx, input) => projectView.showProjectMembers(ctx, input),
    ensureGatewayClientUuid: (principal) =>
      gatewayActions.ensureGatewayClientUuid(principal),
    callGatewayJson: (path, payload) => host.callGatewayJson(path, payload),
  });

  const messageFlow: TransportMessageFlow = new TransportMessageFlow({
    logger: host.logger,
    config: host.config,
    bindingStore: host.bindingStore,
    sessionStore: host.sessionStore,
    isAdminAuthEnabled: () => host.isAdminAuthEnabled(),
    isPrincipalAdminAuthorized: (principal) =>
      host.isPrincipalAdminAuthorized(principal),
    setPrincipalAdminAuthorized: (principal) =>
      host.setPrincipalAdminAuthorized(principal),
    waiters: host.waiters,
    currentAttachmentTargets: host.currentAttachmentTargets,
    isAdminBotProfile: () => host.isAdminBotProfile(),
    getPrincipalFromContext: (ctx) => context.getPrincipalFromContext(ctx),
    ensureGatewayUserForPrincipal: ({ principal, ctx }) =>
      host.ensureGatewayUserForPrincipal({ principal, ctx }),
    extractIncomingText: (message) => extractIncomingText(message),
    collectIncomingAttachments: (message) => collectIncomingAttachments(message),
    buildInboxText: (text, attachments) => buildInboxText(text, attachments),
    clearPendingInteractionsForContext: (ctx) => menuFlow.clearPendingInteractionsForContext(ctx),
    handlePendingRename: (ctx, text) => sessionActions.handlePendingRename(ctx, text),
    handlePendingBroadcast: (ctx, text) => broadcastActions.handlePendingBroadcast(ctx, text),
    handlePendingPartnerNote: (ctx, text) => partnerActions.handlePendingPartnerNote(ctx, text),
    handlePendingFileHandoff: (ctx, text) => fileHandoffActions.handlePending(ctx, text),
    handlePendingProject: (ctx, text) => projectActions.handlePendingProject(ctx, text),
    replyText: (ctx, text, meta, options) =>
      outputActions.replyText(ctx, text, meta, options as TelegramSendMessageOptions),
    tForContext: (ctx, key, options) => context.tForContext(ctx, key, options),
    showSessionsMenu: (ctx, introText) => menuFlow.showSessionsMenu(ctx, introText),
    showHelp: (ctx) => menuFlow.showHelp(ctx),
    ensureGatewayScopeConsolesBound: ({ principal, ctx }) =>
      consoleRegistry.ensureScopedConsolesBound({ principal, ctx }),
    getMainMenu: () => mainMenu,
    clearWaiter: (requestId) => requestFlow.clearWaiter(requestId),
    callGatewayJson: (path, payload) =>
      host.callGatewayJson(path, payload as Record<string, unknown> | undefined),
    scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
      tmuxRuntime.scheduleTmuxNudgeForInboxMessage(sessionId, session),
    downloadIncomingAttachments: (session, sessionId, sourceTelegramMessageId, attachments) =>
      attachmentStore.downloadIncomingAttachments(
        session,
        sessionId,
        sourceTelegramMessageId,
        attachments,
      ),
    storeTelegramUploadMetas: (input) => attachmentStore.storeTelegramUploadMetas(input),
    deliverAttachmentToPartner: (input) =>
      fileHandoffActions.deliverToPartnerPublic(input).then(() => {}),
  });

  const eventActions = new TransportEventActions({
    logger: host.logger,
    config: host.config,
    sessionStore: host.sessionStore,
    bindingStore: host.bindingStore,
    webAppLaunchRegistry: host.webAppLaunchRegistry,
    createLiveApprovalMenuPayload: (input) =>
      payloadState.createLiveApprovalMenuPayload(input),
    nudgeSessionInbox: (sessionId) => host.nudgeSessionInbox(sessionId),
    sendNotification: (input) => host.sendNotification(input),
    resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
      context.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
    t: (locale, key, options) => context.t(locale, key, options),
    tForTelegramUserId: (telegramUserId, key, options) =>
      context.tForTelegramUserId(telegramUserId, key, options),
    sendChatMessage: (telegramChatId, text, options, meta) =>
      outputActions.sendChatMessage(telegramChatId, text, options, meta),
    buildLiveViewUrl: (input) => liveActions.buildUrl(input),
    buildLiveViewKeyboard: (buildUrlForMode, locale) =>
      liveActions.buildKeyboard(buildUrlForMode, locale),
  });

  const menuShell = new TransportMenuShell({
    logger: host.logger,
    tForContext: (ctx, key) => context.tForContext(ctx, key),
    showProjectsMenu: (ctx) => menuFlow.showProjectsMenu(ctx),
    handleMessage: (ctx) => messageFlow.handleMessage(ctx),
    cancelPendingBroadcast: (ctx) => broadcastActions.cancelPendingBroadcast(ctx),
    cancelPendingPartnerNote: (ctx) => partnerActions.cancelPendingPartnerNote(ctx),
    cancelPendingFileHandoff: (ctx) => fileHandoffActions.cancelPending(ctx),
    handleProjectSetCallback: (ctx) =>
      projectActions.handleProjectSetCallback(ctx),
    handleProjectMembersCallback: (ctx) =>
      projectActions.handleProjectMembersCallback(ctx),
    handleProjectMemberOpenCallback: (ctx) =>
      projectActions.handleProjectMemberOpenCallback(ctx),
    handleProjectMemberNoteCallback: (ctx) =>
      projectActions.handleProjectMemberNoteCallback(ctx),
    handleProjectMemberLiveCallback: (ctx) =>
      projectActions.handleProjectMemberLiveCallback(ctx),
    handleLiveApprovalCallback: (ctx) =>
      projectActions.handleLiveApprovalCallback(ctx),
    handleProjectDetailCallback: (ctx) =>
      projectActions.handleProjectDetailCallback(ctx),
    handleProjectDeleteCallback: (ctx) =>
      projectActions.handleProjectDeleteCallback(ctx),
    handleProjectLeaveCallback: (ctx) =>
      projectActions.handleProjectLeaveCallback(ctx),
  });

  mainMenu.register([
    storageMenu,
    browserMenu,
    projectsMenu,
    collabToolsMenu,
    collabDeleteMenu,
    localMenu,
    screenshotsMenu,
    linkMenu,
    partnerMenu,
    sessionsMenu,
    bufferMenu,
    settingsMenu,
    developerMenu,
    unpairConfirmMenu,
    pruneConfirmMenu,
    storageMessageMenu,
    screenshotMessageMenu,
  ]);

  return {
    telegramFetch,
    bot,
    mainMenu,
    storageMenu,
    browserMenu,
    projectsMenu,
    collabToolsMenu,
    collabDeleteMenu,
    localMenu,
    screenshotsMenu,
    linkMenu,
    partnerMenu,
    sessionsMenu,
    bufferMenu,
    settingsMenu,
    developerMenu,
    unpairConfirmMenu,
    pruneConfirmMenu,
    storageMessageMenu,
    screenshotMessageMenu,
    tmuxActions,
    liveActions,
    lifecycleActions,
    attachmentStore,
    broadcastActions,
    context,
    documentActions,
    eventActions,
    partnerActions,
    fileHandoffActions,
    linkingActions,
    menuFactories,
    menuFingerprints,
    menuFlow,
    menuShell,
    consoleRegistry,
    gatewayActions,
    messageFlow,
    menuCallbacks,
    menuState,
    payloadState,
    projectMenus,
    projectEvents,
    projectState,
    projectView,
    projectActions,
    projectEntryActions,
    requestFlow,
    sessionActions,
    outputActions,
    tmuxRuntime,
    xchangeState,
  };
}
