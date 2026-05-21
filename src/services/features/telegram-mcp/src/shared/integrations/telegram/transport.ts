import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { Menu, type MenuFlavor } from "@grammyjs/menu";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import {
  buildLiveRelaySessionId,
  parseLiveRelaySessionId,
} from "../../../app/webapp/relay";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  PartnerNoteKind,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type {
  TelegramInboxMessage,
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
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
import {
  createInboxMessageId,
  createMenuPayloadKey,
} from "../../lib/ids/ids";
import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import {
  formatTelegramMessage,
  formatTelegramNotification,
} from "./messageFormat";
import { buildProjectMemberDetailText } from "./collabUi";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import { createTelegramFetch } from "./proxyFetch";
import {
  captureTmuxPaneRange,
  deleteXchangeFile,
  isTmuxUnavailableError,
} from "../tmux/client";
import {
  TELLYMCP_PACKAGE_NAME,
  TELLYMCP_PROTOCOL_VERSION,
  detectAvailablePackageUpdate,
  getTellyMcpPackageVersion,
} from "../../lib/version/versionHandshake";
import {
  normalizeLocale,
  translate,
  type SupportedLocale,
} from "../../i18n";
import type {
  AdminClientSessionViewRecord,
  AdminClientViewRecord,
  AdminGatewayRegistrationSessionRecord,
  CurrentAttachmentTargetRecord,
  GatewayActorProfile,
  GatewayClientRecord,
  GatewayClientSessionRecord,
  GatewayConnectedClientRecord,
  GatewayProjectRecord,
  GatewayProjectSessionRecord,
  GatewayRelayBindingPayload,
  LiveApprovalEventPayload,
  PendingBroadcastRecord,
  PendingFileHandoffRecord,
  PendingPartnerNoteRecord,
  PendingProjectBroadcastRemoteTarget,
  PendingProjectRecord,
  PendingRenameRecord,
  SendMessageMeta,
  SentChunk,
  StoredAttachmentRecord,
  TelegramAttachmentDescriptor,
  TelegramClientFetch,
  TelegramEditMessageOptions,
  TelegramMenuContext,
  TelegramSendMessageOptions,
  TmuxCaptureScope,
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
  formatFileDetail,
  formatInboxDetail,
  formatScreenshotDetail,
  formatStorageDetail,
} from "./transportContent";
import {
  buildAdminClientsMenuText,
  mergeGatewayAdminClients,
} from "./transportAdminView";
import { TransportLiveActions } from "./transportLiveActions";
import { TransportLifecycleActions } from "./transportLifecycleActions";
import { TransportAdminActions } from "./transportAdminActions";
import { TransportAdminMenus } from "./transportAdminMenus";
import { TransportBroadcastActions } from "./transportBroadcastActions";
import { TransportEventActions } from "./transportEventActions";
import { TransportFileHandoffActions } from "./transportFileHandoffActions";
import { TransportMenuFactories } from "./transportMenuFactories";
import { TransportMenuFingerprints } from "./transportMenuFingerprints";
import { TransportMenuFlow } from "./transportMenuFlow";
import { TransportGatewayDirectory } from "./transportGatewayDirectory";
import { TransportMessageFlow } from "./transportMessageFlow";
import { TransportMenuState } from "./transportMenuState";
import { TransportPayloadState } from "./transportPayloadState";
import { TransportProjectActions } from "./transportProjectActions";
import { TransportProjectMenus } from "./transportProjectMenus";
import { TransportProjectState } from "./transportProjectState";
import { TransportProjectView } from "./transportProjectView";
import { TransportMenuCallbacks } from "./transportMenuCallbacks";
import { TransportPartnerActions } from "./transportPartnerActions";
import { TransportRequestFlow } from "./transportRequestFlow";
import { TransportTmuxActions } from "./transportTmuxActions";
import { TransportXchangeState } from "./transportXchangeState";
import {
  buildAdminMainMenuText,
} from "./transportMenuText";
import {
  buildDatedRelativePath,
  buildLocalHandoffId,
  buildLocalNoteContent,
  buildPrincipalKey,
  escapeHtml,
  formatMenuTimestamp,
  formatTmuxBridgeError,
  isGatewayAdminCommand,
  isGatewayLinkCommand,
  isHelpCommand,
  isMenuEntryCommand,
  joinHttpPath,
  normalizeBasePath,
  normalizeGatewayBaseUrl,
  parseAdminAuthCommand,
  parsePairingCode,
  readMenuPayloadKey,
  renderMarkdownChunk,
  resolveGatewayControlBaseUrl,
  slugifyFilenamePart,
  splitLongTelegramText,
  splitTitleAndBody,
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
  private readonly broadcastActions: TransportBroadcastActions;
  private readonly eventActions: TransportEventActions;
  private readonly partnerActions: TransportPartnerActions;
  private readonly fileHandoffActions: TransportFileHandoffActions;
  private readonly menuFactories: TransportMenuFactories;
  private readonly menuFingerprints: TransportMenuFingerprints;
  private readonly menuFlow: TransportMenuFlow;
  private readonly gatewayDirectory: TransportGatewayDirectory;
  private readonly messageFlow: TransportMessageFlow;
  private readonly menuCallbacks: TransportMenuCallbacks;
  private readonly menuState: TransportMenuState;
  private readonly payloadState: TransportPayloadState;
  private readonly projectMenus: TransportProjectMenus;
  private readonly projectState: TransportProjectState;
  private readonly projectView: TransportProjectView;
  private readonly projectActions: TransportProjectActions;
  private readonly requestFlow: TransportRequestFlow;
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
          text: await this.tForContext(ctx, "common:menu.refreshed"),
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
      t: (locale, key, vars) => this.t(locale, key, vars),
      ensureGatewayClientUuid: (principal, actor) =>
        this.ensureGatewayClientUuid(principal, actor),
      sendChatMessage: (telegramChatId, text, options, meta) =>
        this.sendChatMessage(telegramChatId, text, options, meta),
    });
    this.tmuxActions = new TransportTmuxActions({
      config: this.config,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      bindingStore: this.bindingStore,
      logger: this.logger,
      tmuxNudgeFailureNoticeAt: this.tmuxNudgeFailureNoticeAt,
      tmuxPromptNoticeState: this.tmuxPromptNoticeState,
      sendTypingForSession: (sessionId) => this.sendTypingForSession(sessionId),
      resolveLocaleForTelegramUserId: (userId) =>
        this.resolveLocaleForTelegramUserId(userId),
      sendNotification: (input) => this.sendNotification(input),
      sendLiveViewLauncherMessage: (input) =>
        this.liveActions.sendLauncherMessage(input),
      t: (locale, key, vars) => this.t(locale, key, vars),
    });
    this.xchangeState = new TransportXchangeState({
      config: this.config,
      sessionStore: this.sessionStore,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
    });
    this.menuFingerprints = new TransportMenuFingerprints({
      logger: this.logger,
      bindingStore: this.bindingStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      listActiveSessionStorageEntries: (sessionId) =>
        this.listActiveSessionStorageEntries(sessionId),
      listActiveSessionScreenshots: (sessionId) =>
        this.listActiveSessionScreenshots(sessionId),
    });
    this.adminMenus = new TransportAdminMenus({
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      tForContext: (ctx, key, vars) => this.tForContext(ctx, key, vars),
      showAdminMainMenu: (ctx) => this.showAdminMainMenu(ctx),
      showAdminClientsMenu: (ctx) => this.showAdminClientsMenu(ctx),
      showAdminClientSessionsMenu: (ctx) => this.showAdminClientSessionsMenu(ctx),
      showAdminClientSessionList: (ctx, scope) =>
        this.showAdminClientSessionList(ctx, scope),
      showAdminToolsMenu: (ctx) => this.showAdminToolsMenu(ctx),
      listGatewayAdminClients: () => this.listGatewayAdminClients(),
      createAdminClientMenuPayload: (client) =>
        this.createAdminClientMenuPayload(client),
      handleAdminClientSelectCallback: (ctx) =>
        this.handleAdminClientSelectCallback(ctx),
      adminHandleClientEnvExport: (ctx) =>
        this.adminActions.handleClientEnvExport(ctx),
    });
    this.projectMenus = new TransportProjectMenus({
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      buildProjectsFingerprint: (ctx) => this.buildProjectsFingerprint(ctx),
      loadProjectsContext: (ctx) => this.loadProjectsContext(ctx),
      tForContext: (ctx, key, vars) => this.tForContext(ctx, key, vars),
      createProjectMenuPayload: (sessionId, projectUuid, title) =>
        this.createProjectMenuPayload(sessionId, projectUuid, title),
      createProjectDeleteMenuPayload: (sessionId, projectUuid, title) =>
        this.createProjectDeleteMenuPayload(sessionId, projectUuid, title),
      handleProjectSelect: (ctx) => this.handleProjectSelect(ctx),
      handleProjectDeleteSelect: (ctx) => this.handleProjectDeleteSelect(ctx),
      beginProjectMode: (ctx, mode) => this.beginProjectMode(ctx, mode),
      beginProjectBroadcast: (ctx) => this.beginProjectBroadcast(ctx),
      handleCollabHistoryExport: (ctx) => this.handleCollabHistoryExport(ctx),
      showCollabToolsMenu: (ctx) => this.showCollabToolsMenu(ctx),
      showCollabDeleteMenu: (ctx) => this.showCollabDeleteMenu(ctx),
      showProjectsMenu: (ctx) => this.showProjectsMenu(ctx),
      showMainMenu: (ctx) => this.showMainMenu(ctx),
    });
    this.menuFactories = new TransportMenuFactories({
      logger: this.logger,
      bindingStore: this.bindingStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      createMenuOptions: (onMenuOutdated) => this.createMenuOptions(onMenuOutdated),
      tForContext: (ctx, key, vars) => this.tForContext(ctx, key, vars),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      buildMainMenuFingerprint: (ctx) => this.buildMainMenuFingerprint(ctx),
      buildInboxFingerprint: (ctx) => this.buildInboxFingerprint(ctx),
      buildStorageFingerprint: (ctx) => this.buildStorageFingerprint(ctx),
      buildScreenshotsFingerprint: (ctx) =>
        this.buildScreenshotsFingerprint(ctx),
      buildSessionsFingerprint: (ctx) => this.buildSessionsFingerprint(ctx),
      buildLinkFingerprint: (ctx) => this.buildLinkFingerprint(ctx),
      buildInboxButtonLabel: (ctx) => this.buildInboxButtonLabel(ctx),
      buildScreenshotsButtonLabel: (ctx) =>
        this.buildScreenshotsButtonLabel(ctx),
      buildLinkButtonLabel: (ctx) => this.buildLinkButtonLabel(ctx),
      showLiveViewLauncher: (ctx) => this.showLiveViewLauncher(ctx),
      showBufferMenu: (ctx) => this.showBufferMenu(ctx),
      showBrowserMenu: (ctx) => this.showBrowserMenu(ctx),
      showMainMenu: (ctx) => this.showMainMenu(ctx),
      showLocalEntryPoint: (ctx) => this.showLocalEntryPoint(ctx),
      showProjectsEntryPoint: (ctx) => this.showProjectsEntryPoint(ctx),
      showInboxMenu: (ctx) => this.showInboxMenu(ctx),
      showStorageMenu: (ctx) => this.showStorageMenu(ctx),
      showSettingsMenu: (ctx) => this.showSettingsMenu(ctx),
      showSessionsMenu: (ctx) => this.showSessionsMenu(ctx),
      showScreenshotsMenu: (ctx) => this.showScreenshotsMenu(ctx),
      showLocalMenu: (ctx) => this.showLocalMenu(ctx),
      showLinkMenu: (ctx) => this.showLinkMenu(ctx),
      showPartnerMenu: (ctx) => this.showPartnerMenu(ctx),
      showPartnerEntryPoint: (ctx) => this.showPartnerEntryPoint(ctx),
      handleLinkButton: (ctx) => this.handleLinkButton(ctx),
      handleLinkTargetSelect: (ctx) => this.handleLinkTargetSelect(ctx),
      beginPartnerNoteMode: (ctx, kind) => this.beginPartnerNoteMode(ctx, kind),
      sendActiveSessionBuffer: (ctx, input) =>
        this.sendActiveSessionBuffer(ctx, input),
      showUnpairConfirmMenu: (ctx) => this.showUnpairConfirmMenu(ctx),
      showDeveloperMenu: (ctx) => this.showDeveloperMenu(ctx),
      showPruneConfirmMenu: (ctx) => this.showPruneConfirmMenu(ctx),
      showActiveSessionInfo: (ctx) => this.showActiveSessionInfo(ctx),
      beginRenameActiveSession: (ctx) => this.beginRenameActiveSession(ctx),
      beginBroadcast: (ctx) => this.beginBroadcast(ctx),
      pruneAllSessions: (ctx) => this.pruneAllSessions(ctx),
      unpairActiveSession: (ctx) => this.unpairActiveSession(ctx),
      handleInboxMessageOpen: (ctx) => this.handleInboxMessageOpen(ctx),
      handleInboxMessageDelete: (ctx) => this.handleInboxMessageDelete(ctx),
      handleStorageOpen: (ctx) => this.handleStorageOpen(ctx),
      handleStorageGet: (ctx) => this.handleStorageGet(ctx),
      handleStorageDelete: (ctx) => this.handleStorageDelete(ctx),
      handleScreenshotOpen: (ctx) => this.handleScreenshotOpen(ctx),
      handleScreenshotGet: (ctx) => this.handleScreenshotGet(ctx),
      handleScreenshotDelete: (ctx) => this.handleScreenshotDelete(ctx),
      handleSessionSelection: (ctx) => this.handleSessionSelection(ctx),
      createInboxMenuPayload: (sessionId, messageId) =>
        this.createInboxMenuPayload(sessionId, messageId),
      createFileMenuPayload: (sessionId, filePath) =>
        this.createFileMenuPayload(sessionId, filePath),
      createSessionMenuPayload: (sessionId) =>
        this.createSessionMenuPayload(sessionId),
      createLinkMenuPayload: (sessionId, targetSessionId) =>
        this.createLinkMenuPayload(sessionId, targetSessionId),
      formatInboxPreviewLabel: (message) => this.formatInboxPreviewLabel(message),
      formatStoragePreviewLabel: (filePath, meta) =>
        this.formatStoragePreviewLabel(filePath, meta),
      formatFilePreviewLabel: (filePath) => this.formatFilePreviewLabel(filePath),
      formatSessionMenuLabel: (input) => this.formatSessionMenuLabel(input),
      listActiveSessionStorageEntries: (sessionId) =>
        this.listActiveSessionStorageEntries(sessionId),
      listActiveSessionScreenshots: (sessionId) =>
        this.listActiveSessionScreenshots(sessionId),
    });

    this.bot = new Bot<TelegramMenuContext>(
      this.config.telegram.botToken ?? "0:disabled",
      {
      client: {
        fetch: this.telegramFetch,
      },
    });
    this.mainMenu = this.createMainMenu();
    this.adminMainMenu = this.createAdminMainMenu();
    this.adminClientsMenu = this.createAdminClientsMenu();
    this.adminClientSessionsMenu = this.createAdminClientSessionsMenu();
    this.adminClientSessionDetailMenu = this.createAdminClientSessionDetailMenu();
    this.adminToolsMenu = this.createAdminToolsMenu();
    this.inboxMenu = this.createInboxMenu();
    this.storageMenu = this.createStorageMenu();
    this.browserMenu = this.createBrowserMenu();
    this.projectsMenu = this.createProjectsMenu();
    this.collabToolsMenu = this.createCollabToolsMenu();
    this.collabDeleteMenu = this.createCollabDeleteMenu();
    this.localMenu = this.createLocalMenu();
    this.screenshotsMenu = this.createScreenshotsMenu();
    this.linkMenu = this.createLinkMenu();
    this.partnerMenu = this.createPartnerMenu();
    this.sessionsMenu = this.createSessionsMenu();
    this.bufferMenu = this.createBufferMenu();
    this.settingsMenu = this.createSettingsMenu();
    this.developerMenu = this.createDeveloperMenu();
    this.unpairConfirmMenu = this.createUnpairConfirmMenu();
    this.pruneConfirmMenu = this.createPruneConfirmMenu();
    this.inboxMessageMenu = this.createInboxMessageMenu();
    this.storageMessageMenu = this.createStorageMessageMenu();
    this.screenshotMessageMenu = this.createScreenshotMessageMenu();
    this.adminActions = new TransportAdminActions({
      config: this.config,
      adminClientViewByPrincipal: this.adminClientViewByPrincipal,
      adminClientsMenu: this.adminClientsMenu,
      adminClientSessionsMenu: this.adminClientSessionsMenu,
      adminToolsMenu: this.adminToolsMenu,
      liveActions: this.liveActions,
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      tForContext: (ctx, key) => this.tForContext(ctx, key),
      listGatewayAdminClients: () => this.listGatewayAdminClients(),
      listGatewayClientSessions: (clientUuid) =>
        this.listGatewayClientSessions(clientUuid),
      listGatewayConnectedClients: () => this.listGatewayConnectedClients(),
      createAdminClientSessionMenuPayload: (session) =>
        this.createAdminClientSessionMenuPayload(session),
      renderMenuHtmlScreen: (ctx, text, meta, menu) =>
        this.renderMenuHtmlScreen(ctx, text, meta, menu as Menu<TelegramMenuContext>),
      editText: (ctx, text, meta, options) =>
        this.editText(ctx, text, meta, options),
      replyText: (ctx, text, meta, options) =>
        this.replyText(ctx, text, meta, options),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.replyDocumentWithRetry(ctx, document, options, meta),
      showAdminClientsMenu: (ctx, introText) => this.showAdminClientsMenu(ctx, introText),
      showMainMenu: (ctx, introText) => this.showMainMenu(ctx, introText),
      getAdminClientSessionPayloadByKey: (payloadKey) =>
        this.getAdminClientSessionPayloadByKey(payloadKey),
      getMenuPayloadByKey: (payloadKey) =>
        this.menuPayloadStore.getMenuPayload(payloadKey),
      extractCallbackSuffix: (ctx, prefix) => this.extractCallbackSuffix(ctx, prefix),
      bindRelaySessionToPrincipal: (input) => this.bindRelaySessionToPrincipal(input),
      webAppLaunchRegistry: this.webAppLaunchRegistry,
    });
    this.broadcastActions = new TransportBroadcastActions({
      logger: this.logger,
      pendingBroadcasts: this.pendingBroadcasts,
      pendingRenames: this.pendingRenames,
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      tForContext: (ctx, key, vars) => this.tForContext(ctx, key, vars),
      replyText: (ctx, text, meta, options) => this.replyText(ctx, text, meta, options),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showCollabToolsMenu: (ctx) => this.showCollabToolsMenu(ctx),
      showDeveloperMenu: (ctx) => this.showDeveloperMenu(ctx),
      ensureGatewayClientUuid: (principal) => this.ensureGatewayClientUuid(principal),
      listGatewayProjects: (principal) => this.listGatewayProjects(principal),
      listGatewayProjectSessions: (principal, projectUuid) =>
        this.listGatewayProjectSessions(principal, projectUuid),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      routeTelegramInboxToRelaySession: (input) =>
        this.routeTelegramInboxToRelaySession(input),
      scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
        this.scheduleTmuxNudgeForInboxMessage(sessionId, session),
      sendPartnerNote: (input) => this.sendPartnerNote(input),
    });
    this.partnerActions = new TransportPartnerActions({
      logger: this.logger,
      pendingPartnerNotes: this.pendingPartnerNotes,
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      replyText: (ctx, text, meta, options) => this.replyText(ctx, text, meta, options),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showPartnerMenu: (ctx) => this.showPartnerMenu(ctx),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      maintenanceStore: this.maintenanceStore,
      ensureProjectSessionRegistered: (input) => this.ensureProjectSessionRegistered(input),
      sendPartnerNote: (input) => this.sendPartnerNote(input),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
    });
    this.fileHandoffActions = new TransportFileHandoffActions({
      logger: this.logger,
      config: this.config,
      pendingFileHandoffs: this.pendingFileHandoffs,
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      replyText: (ctx, text, meta, options) => this.replyText(ctx, text, meta, options),
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      showPartnerMenu: (ctx) => this.showPartnerMenu(ctx),
      showLocalMenu: (ctx) => this.showLocalMenu(ctx),
      showProjectMemberDetail: (ctx, input) =>
        this.showProjectMemberDetail(ctx, {
          ...input,
          inviteToken: input.inviteToken ?? "",
        }),
      getProjectPayloadByUuid: (sessionId, projectUuid) =>
        this.getProjectPayloadByUuid(sessionId, projectUuid),
      ensureProjectSessionRegistered: (input) => this.ensureProjectSessionRegistered(input),
      sendPartnerNote: (input) => this.sendPartnerNote(input),
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
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      tForContext: (ctx, key, vars) => this.tForContext(ctx, key, vars),
      replyText: (ctx, text, meta, options) =>
        this.replyText(ctx, text, meta, options as Parameters<TelegramTransport["replyText"]>[3]),
      editText: (ctx, text, meta, options) =>
        this.editText(ctx, text, meta, options as Parameters<TelegramTransport["editText"]>[3]),
      showMainMenu: (ctx, introText) => this.showMainMenu(ctx, introText),
      showLinkMenu: (ctx) => this.showLinkMenu(ctx),
      showPartnerMenu: (ctx) => this.showPartnerMenu(ctx),
      showScreenshotsMenu: (ctx, introText) => this.showScreenshotsMenu(ctx, introText),
      showStorageMenu: (ctx, introText) => this.showStorageMenu(ctx, introText),
      inboxMessageMenu: this.inboxMessageMenu,
      storageMessageMenu: this.storageMessageMenu,
      screenshotMessageMenu: this.screenshotMessageMenu,
      xchangeFileMetaStore: this.xchangeFileMetaStore,
      inboxStore: this.inboxStore,
      sessionStore: this.sessionStore,
      bindingStore: this.bindingStore,
      objectStore: this.objectStore,
      formatInboxDetail: (message) => this.formatInboxDetail(message),
      formatScreenshotDetail: (sessionId, filePath, meta) =>
        this.formatScreenshotDetail(sessionId, filePath, meta),
      formatStorageDetail: (sessionId, filePath, meta) =>
        this.formatStorageDetail(sessionId, filePath, meta),
      formatFilePreviewLabel: (filePath, meta) => this.formatFilePreviewLabel(filePath, meta),
      listActiveSessionFiles: (sessionId) => this.listActiveSessionFiles(sessionId),
      createPartnerFileTargetPayload: (sessionId, targetSessionId, title, filePath) =>
        this.createPartnerFileTargetPayload(sessionId, targetSessionId, title, filePath),
      ensureStoredXchangeFile: (sessionId, filePath, source) =>
        this.ensureStoredXchangeFile(sessionId, filePath, source),
      sendDocumentToChat: (chatId, filePath, caption) =>
        this.sendDocumentToChat(chatId, filePath, caption),
      linkSessions: (sessionId, targetSessionId) => this.linkSessions(sessionId, targetSessionId),
      maybeNotifyToolsMismatchForSession: (sessionId) => this.maybeNotifyToolsMismatchForSession(sessionId),
    });
    this.payloadState = new TransportPayloadState({
      menuPayloadStore: this.menuPayloadStore,
      menuPayloadTtlSeconds: this.config.telegram.menuPayloadTtlSeconds,
    });
    this.menuState = new TransportMenuState({
      logger: this.logger,
      t: (locale, key, vars) => this.t(locale, key, vars),
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      getTmuxStatusLine: (locale) => this.getTmuxStatusLine(locale),
      setCurrentAttachmentTargetForContext: (ctx, target) =>
        this.setCurrentAttachmentTargetForContext(ctx, target),
      renderMenuHtmlScreen: (ctx, text, meta, menu) =>
        this.renderMenuHtmlScreen(
          ctx,
          text,
          meta,
          menu as Parameters<TelegramTransport["renderMenuHtmlScreen"]>[3],
        ),
      renderMenuScreen: (ctx, text, meta, menu) =>
        this.renderMenuScreen(
          ctx,
          text,
          meta,
          menu as Parameters<TelegramTransport["renderMenuScreen"]>[3],
        ),
      replyText: (ctx, text, meta, options) =>
        this.replyText(
          ctx,
          text,
          meta,
          options as Parameters<TelegramTransport["replyText"]>[3],
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
        this.listActiveSessionScreenshots(sessionId),
      listActiveSessionStorageEntries: (sessionId) =>
        this.listActiveSessionStorageEntries(sessionId),
    });
    this.projectState = new TransportProjectState({
      config: this.config,
      getGatewayActorFromContext: (ctx) => this.getGatewayActorFromContext(ctx),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
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
      t: (locale, key, vars) => this.t(locale, key, vars),
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      getGatewayActorFromContext: (ctx) => this.getGatewayActorFromContext(ctx),
      ensureGatewayClientUuid: (principal, actor) =>
        this.ensureGatewayClientUuid(principal, actor),
      loadProjectsContext: (ctx) => this.loadProjectsContext(ctx),
      listGatewayProjects: (principal, actor) =>
        this.listGatewayProjects(principal, actor),
      listGatewayProjectSessions: (principal, projectUuid) =>
        this.listGatewayProjectSessions(principal, projectUuid),
      listGatewaySessionHistory: (principal, localSessionId) =>
        this.listGatewaySessionHistory(principal, localSessionId),
      collectCollabBroadcastTargets: (principal, sessionId) =>
        this.collectCollabBroadcastTargets(principal, sessionId),
      ensureOpenedProjectIsActive: (input) =>
        this.ensureOpenedProjectIsActive(input),
      setCurrentAttachmentTargetForContext: (ctx, target) =>
        this.setCurrentAttachmentTargetForContext(ctx, target),
      renderMenuScreen: (ctx, text, meta, menu) =>
        this.renderMenuScreen(
          ctx,
          text,
          meta,
          menu as Parameters<TelegramTransport["renderMenuScreen"]>[3],
        ),
      replyText: (ctx, text, meta, options) =>
        this.replyText(ctx, text, meta, options),
      editText: (ctx, text, meta, options) =>
        this.editText(ctx, text, meta, options),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.replyDocumentWithRetry(ctx, document, options, meta),
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
        this.createProjectMemberMenuPayload(
          sessionId,
          projectUuid,
          targetSessionId,
          title,
          extra,
        ),
      listActiveSessionFiles: (sessionId) => this.listActiveSessionFiles(sessionId),
      formatFilePreviewLabel: (filePath, meta) =>
        this.formatFilePreviewLabel(filePath, meta),
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
        this.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.t(locale, key, options),
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
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      getGatewayActorFromContext: (ctx) => this.getGatewayActorFromContext(ctx),
      t: (locale, key, options) => this.t(locale, key, options),
      replyText: (ctx, text, meta, options) =>
        this.replyText(
          ctx,
          text,
          meta as Parameters<TelegramTransport["replyText"]>[2],
          options,
        ),
      editText: (ctx, text, meta, options) =>
        this.editText(
          ctx,
          text,
          meta as Parameters<TelegramTransport["editText"]>[2],
          options,
        ),
      replyDocumentWithRetry: (ctx, document, options, meta) =>
        this.replyDocumentWithRetry(
          ctx,
          document,
          options,
          meta as Parameters<TelegramTransport["replyDocumentWithRetry"]>[3],
        ),
    });
    this.gatewayDirectory = new TransportGatewayDirectory({
      logger: this.logger,
      config: this.config,
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
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
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      extractIncomingText: (message) => this.extractIncomingText(message),
      collectIncomingAttachments: (message) =>
        this.collectIncomingAttachments(message),
      buildInboxText: (text, attachments) =>
        this.buildInboxText(text, attachments),
      clearPendingInteractionsForContext: (ctx) =>
        this.clearPendingInteractionsForContext(ctx),
      handlePendingRename: (ctx, text) => this.handlePendingRename(ctx, text),
      handlePendingBroadcast: (ctx, text) =>
        this.handlePendingBroadcast(ctx, text),
      handlePendingPartnerNote: (ctx, text) =>
        this.handlePendingPartnerNote(ctx, text),
      handlePendingFileHandoff: (ctx, text) =>
        this.handlePendingFileHandoff(ctx, text),
      handlePendingProject: (ctx, text) => this.handlePendingProject(ctx, text),
      replyText: (ctx, text, meta, options) =>
        this.replyText(
          ctx,
          text,
          meta as Parameters<TelegramTransport["replyText"]>[2],
          options,
        ),
      tForContext: (ctx, key, options) => this.tForContext(ctx, key, options),
      showSessionsMenu: (ctx, introText) => this.showSessionsMenu(ctx, introText),
      showHelp: (ctx) => this.showHelp(ctx),
      showAdminMainMenu: (ctx, introText) => this.showAdminMainMenu(ctx, introText),
      showAdminClientsMenu: (ctx, introText) =>
        this.showAdminClientsMenu(ctx, introText),
      mainMenu: this.mainMenu,
      bindRelaySessionToPrincipal: (input) =>
        this.bindRelaySessionToPrincipal(input),
      clearWaiter: (requestId) => this.clearWaiter(requestId),
      callGatewayJson: (path, payload) =>
        this.callGatewayJson(path, payload as Record<string, unknown> | undefined),
      scheduleTmuxNudgeForInboxMessage: (sessionId, session) =>
        this.scheduleTmuxNudgeForInboxMessage(sessionId, session),
      downloadIncomingAttachments: (session, sessionId, sourceTelegramMessageId, attachments) =>
        this.downloadIncomingAttachments(
          session,
          sessionId,
          sourceTelegramMessageId,
          attachments,
        ),
      storeTelegramUploadMetas: (input) => this.storeTelegramUploadMetas(input),
      deliverAttachmentToPartner: (input) =>
        this.fileHandoffActions.deliverToPartnerPublic(input).then(() => {}),
    });
    this.eventActions = new TransportEventActions({
      logger: this.logger,
      config: this.config,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      bindingStore: this.bindingStore,
      webAppLaunchRegistry: this.webAppLaunchRegistry,
      createLiveApprovalMenuPayload: (input) => this.createLiveApprovalMenuPayload(input),
      nudgeSessionInbox: (sessionId) => this.nudgeSessionInbox(sessionId),
      sendNotification: (input) => this.sendNotification(input),
      resolveLocaleForTelegramUserId: (telegramUserId, telegramLanguageCode) =>
        this.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.t(locale, key, options),
      tForTelegramUserId: (telegramUserId, key, options) =>
        this.tForTelegramUserId(telegramUserId, key, options),
      sendChatMessage: (telegramChatId, text, options, meta) =>
        this.sendChatMessage(telegramChatId, text, options, meta),
      buildLiveViewUrl: (input) => this.liveActions.buildUrl(input),
      buildLiveViewKeyboard: (buildUrlForMode, locale) =>
        this.liveActions.buildKeyboard(buildUrlForMode, locale),
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
        this.resolveLocaleForTelegramUserId(telegramUserId, telegramLanguageCode),
      t: (locale, key, options) => this.t(locale, key, options),
      sendTextChunks: (chatId, body, meta) =>
        this.sendTextChunks(
          chatId,
          body,
          meta as Parameters<TelegramTransport["sendTextChunks"]>[2],
        ),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
    });
    this.projectActions = new TransportProjectActions({
      resolveLocaleForContext: (ctx) => this.resolveLocaleForContext(ctx),
      t: (locale, key, vars) => this.t(locale, key, vars),
      getPrincipalFromContext: (ctx) => this.getPrincipalFromContext(ctx),
      extractCallbackSuffix: (ctx, prefix) => this.extractCallbackSuffix(ctx, prefix),
      getGatewayActorFromContext: (ctx) => this.getGatewayActorFromContext(ctx),
      bindingStore: this.bindingStore,
      sessionStore: this.sessionStore,
      pendingProjects: this.pendingProjects,
      ensureGatewayClientUuid: (principal, actor) => this.ensureGatewayClientUuid(principal, actor),
      listGatewayProjects: (principal) => this.listGatewayProjects(principal),
      callGatewayJson: (path, payload) => this.callGatewayJson(path, payload),
      activateProjectForSession: (input) => this.activateProjectForSession(input),
      ensureOpenedProjectIsActive: (input) => this.ensureOpenedProjectIsActive(input),
      getProjectPayloadByUuid: (sessionId, projectUuid) =>
        this.getProjectPayloadByUuid(sessionId, projectUuid),
      getProjectMemberPayloadByKey: (payloadKey) =>
        this.getProjectMemberPayloadByKey(payloadKey),
      getPartnerFileTargetPayloadByKey: (payloadKey) =>
        this.getPartnerFileTargetPayloadByKey(payloadKey),
      getLiveApprovalPayloadByKey: (payloadKey) =>
        this.getLiveApprovalPayloadByKey(payloadKey),
      beginFileHandoffModeForTarget: (ctx, input) =>
        this.beginFileHandoffModeForTarget(ctx, input),
      beginPartnerNoteMode: (ctx, kind, target) =>
        this.beginPartnerNoteMode(ctx, kind, target),
      showProjectMembers: (ctx, input) => this.showProjectMembers(ctx, input),
      showProjectMemberDetail: (ctx, input) => this.showProjectMemberDetail(ctx, input),
      showProjectMemberFiles: (ctx, input) => this.showProjectMemberFiles(ctx, input),
      showProjectsMenu: (ctx, introText) => this.showProjectsMenu(ctx, introText),
      showCollabDeleteMenu: (ctx, introText) => this.showCollabDeleteMenu(ctx, introText),
      replyText: (ctx, text, meta) => this.replyText(ctx, text, meta),
      editText: (ctx, text, meta) => this.editText(ctx, text, meta),
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
    this.bot.catch((error) => {
      this.logger.error("Telegram polling error", {
      error:
            error.error instanceof Error
              ? error.error.message
              : String(error.error),
      });
    });
    this.bot.callbackQuery("broadcast-cancel", async (ctx) => {
      await this.cancelPendingBroadcast(ctx);
    });
    this.bot.callbackQuery("partner-note-cancel", async (ctx) => {
      await this.cancelPendingPartnerNote(ctx);
    });
    this.bot.callbackQuery("partner-back", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:partner.actions.back_to_partner"),
      });
      await this.showPartnerMenu(ctx);
    });
    this.bot.callbackQuery("file-handoff-cancel", async (ctx) => {
      await this.cancelPendingFileHandoff(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-live:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionLiveCallback(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-bind:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionBindCallback(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-open:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionOpenCallback(ctx);
    });
    this.bot.callbackQuery("admin-client-sessions-collab", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
      });
      await this.showAdminClientSessionList(ctx, "collab");
    });
    this.bot.callbackQuery("admin-client-sessions-all", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
      });
      await this.showAdminClientSessionList(ctx, "all");
    });
    this.bot.callbackQuery("admin-client-sessions-back", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.back_to_client_sessions"),
      });
      await this.showAdminClientSessionsMenu(ctx);
    });
    this.bot.callbackQuery("admin-client-session-list-back", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.back_to_client_sessions"),
      });
      await this.showAdminClientSessionsMenu(ctx);
    });
    this.bot.callbackQuery(/^project-set:(.+)$/u, async (ctx) => {
      await this.handleProjectSetCallback(ctx);
    });
    this.bot.callbackQuery(/^project-members:(.+)$/u, async (ctx) => {
      await this.handleProjectMembersCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-open:(.+)$/u, async (ctx) => {
      await this.handleProjectMemberOpenCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-note:(question|share):(.+)$/u, async (ctx) => {
      await this.handleProjectMemberNoteCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-live:(.+)$/u, async (ctx) => {
      await this.handleProjectMemberLiveCallback(ctx);
    });
    this.bot.callbackQuery(/^live-approval:(approve|deny):(.+)$/u, async (ctx) => {
      await this.handleLiveApprovalCallback(ctx);
    });
    this.bot.callbackQuery(/^project-detail:(.+)$/u, async (ctx) => {
      await this.handleProjectDetailCallback(ctx);
    });
    this.bot.callbackQuery(/^project-delete:(.+)$/u, async (ctx) => {
      await this.handleProjectDeleteCallback(ctx);
    });
    this.bot.callbackQuery(/^project-leave:(.+)$/u, async (ctx) => {
      await this.handleProjectLeaveCallback(ctx);
    });
    this.bot.callbackQuery("project-back", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Back to projects." });
      await this.showProjectsMenu(ctx);
    });
    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
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

    const principal = this.getPrincipalFromContext(ctx);
    const authorized = await this.isPrincipalAdminAuthorized(principal);
    if (authorized) {
      await next();
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.auth.required_callback"),
        show_alert: true,
      });
      return;
    }

    const text = this.extractIncomingText(ctx.message);
    const token = text ? parseAdminAuthCommand(text) : null;
    if (principal && token) {
      await this.handleAdminAuthCommand(ctx, principal, token);
      return;
    }

    if (text && isGatewayAdminCommand(text)) {
      await this.replyText(
        ctx,
        await this.tForContext(ctx, "menu:admin.auth.prompt"),
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

  private async sendPartnerNote(
    input: SendPartnerNoteInput,
  ): Promise<SendPartnerNoteOutput> {
    if (this.collaborationService) {
      return this.collaborationService.sendPartnerNote(input);
    }

    if (!this.config.distributed.gatewayPublicUrl) {
      throw new Error("Partner collaboration service is not configured.");
    }

    const url = normalizeGatewayBaseUrl(this.config.distributed.gatewayPublicUrl);
    url.pathname = `${url.pathname}/partner-note`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distributed.gatewayAuthToken
          ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Gateway collaboration request failed with status ${response.status}: ${text || response.statusText}`,
      );
    }

    return (await response.json()) as SendPartnerNoteOutput;
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

  private async ensureGatewayClientUuid(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<string> {
    return this.projectState.ensureGatewayClientUuid(principal, actor);
  }

  private async listGatewayProjects(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<GatewayProjectRecord[]> {
    return this.projectState.listGatewayProjects(principal, actor);
  }

  private async listGatewayClients(): Promise<GatewayClientRecord[]> {
    return this.gatewayDirectory.listGatewayClients();
  }

  private async listGatewayConnectedClients(): Promise<GatewayConnectedClientRecord[]> {
    return this.gatewayDirectory.listGatewayConnectedClients();
  }

  private async listGatewayAdminClients(): Promise<AdminClientViewRecord[]> {
    return this.gatewayDirectory.listGatewayAdminClients();
  }

  private async listGatewayClientSessions(
    clientUuid: string,
  ): Promise<GatewayClientSessionRecord[]> {
    return this.gatewayDirectory.listGatewayClientSessions(clientUuid);
  }

  private async listGatewayProjectSessions(
    principal: { telegramChatId: number; telegramUserId: number },
    projectUuid: string,
  ): Promise<GatewayProjectSessionRecord[]> {
    return this.projectState.listGatewayProjectSessions(principal, projectUuid);
  }

  private async listGatewaySessionHistory(
    principal: { telegramChatId: number; telegramUserId: number },
    localSessionId: string,
  ): Promise<
    Array<{
      message_uuid: string;
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_uuid?: string;
      project_name?: string;
      from_session_id: string;
      from_label: string;
      to_session_id: string;
      to_label: string;
      delivery_status?: string;
    }>
  > {
    return this.projectState.listGatewaySessionHistory(principal, localSessionId);
  }

  private async ensureProjectSessionRegistered(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
  }): Promise<void> {
    await this.projectState.ensureProjectSessionRegistered(input);
  }

  private async loadProjectsContext(
    ctx: TelegramMenuContext,
  ): Promise<{
    principal: { telegramChatId: number; telegramUserId: number } | null;
    session: Awaited<ReturnType<SessionStore["getSession"]>> | null;
    projects: GatewayProjectRecord[] | null;
  }> {
    return this.projectState.loadProjectsContext(ctx);
  }

  private async activateProjectForSession(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    await this.projectState.activateProjectForSession(input);
  }

  private async ensureOpenedProjectIsActive(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    await this.projectState.ensureOpenedProjectIsActive(input);
  }

  private async buildProjectsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.projectState.buildProjectsFingerprint(ctx);
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
      this.startTmuxPromptScan();
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
    this.startTmuxPromptScan();
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
    this.clearTmuxNudgeDebounceTimers();
    this.clearTmuxPromptScanTimer();
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
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.t(locale, "menu:notices.project.new_member");

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.member_joined", {
          projectName: input.project_name,
          memberLabel,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectMemberLeftEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.t(locale, "menu:notices.project.member");

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.member_left", {
          projectName: input.project_name,
          memberLabel,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectDeletedEvent(input: {
    project_uuid: string;
    project_name: string;
  }): Promise<void> {
    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      if (session.activeProjectUuid === input.project_uuid) {
        await this.sessionStore.setSession({
          ...session,
          activeProjectUuid: undefined,
          activeProjectName: undefined,
          updatedAt: new Date().toISOString(),
        });
      }

      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.deleted", {
          projectName: input.project_name,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
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

  private async sendTextChunks(
    telegramChatId: number,
    text: string,
    meta: {
      kind: "request" | "notification";
      sessionId: string;
      requestId?: string;
    },
  ): Promise<SentChunk[]> {
    const safeLimit = Math.min(this.config.telegram.maxMessageChars, 3900);
    const { title, body } = splitTitleAndBody(text);
    const rawChunkLimit = Math.max(256, safeLimit - title.length - 96);
    const rawChunks = splitLongTelegramText(body, rawChunkLimit);
    const bodyChunks = rawChunks.flatMap((chunk) =>
      this.buildSizedBodyChunks(title, chunk, safeLimit),
    );
    const chunkCount = bodyChunks.length;
    const chunks = bodyChunks.map((chunkBody, index) =>
      renderMarkdownChunk(
        chunkCount > 1 ? `${title} (${index + 1}/${chunkCount})` : title,
        chunkBody,
      ),
    );
    const sent: SentChunk[] = [];

    this.logger.debug("Telegram message chunking prepared", {
      kind: meta.kind,
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      chunkCount: chunks.length,
      totalLength: text.length,
      safeLimit,
    });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }

      try {
        const response = await this.sendTelegramMessageWithRetry(
          telegramChatId,
          chunk,
          { parse_mode: "MarkdownV2" },
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            chunkIndex: index + 1,
            chunkCount: chunks.length,
            ...(meta.requestId ? { requestId: meta.requestId } : {}),
          },
        );
        sent.push({
          messageId: response.message_id,
          textLength: chunk.length,
        });

        this.logger.debug("Telegram message chunk sent", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          messageId: response.message_id,
          textLength: chunk.length,
        });
      } catch (error) {
        this.logger.error("Telegram message chunk send failed", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          textLength: chunk.length,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    return sent;
  }

  private buildSizedBodyChunks(
    title: string,
    rawBody: string,
    safeLimit: number,
  ): string[] {
    const queue = [rawBody];
    const bodyChunks: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      const candidate = renderMarkdownChunk(`${title} (88/88)`, current);
      if (candidate.length <= safeLimit) {
        bodyChunks.push(current);
        continue;
      }

      const midpoint = Math.floor(current.length / 2);
      const splitAtNewline = current.lastIndexOf("\n", midpoint);
      const splitIndex = splitAtNewline > 64 ? splitAtNewline : midpoint;
      const head = current.slice(0, splitIndex).trim();
      const tail = current.slice(splitIndex).trim();

      if (!head || !tail) {
        const hardLimit = Math.max(64, safeLimit - title.length - 96);
        for (let index = 0; index < current.length; index += hardLimit) {
          const slice = current.slice(index, index + hardLimit).trim();
          if (slice) {
            bodyChunks.push(slice);
          }
        }
        continue;
      }

      queue.unshift(tail, head);
    }

    return bodyChunks;
  }

  private async sendTelegramMessageWithRetry(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions = {},
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        return await this.bot.api.sendMessage(telegramChatId, text, options);
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn("Telegram rate limit hit, cooling down before retry", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: meta.chunkIndex,
          chunkCount: meta.chunkCount,
          attempt,
          retryAfterSeconds,
          description: error.description,
        });

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  private async sendChatMessage(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions,
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }> {
    return this.sendTelegramMessageWithRetry(
      telegramChatId,
      text,
      options,
      meta,
    );
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

  private async replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options: TelegramSendMessageOptions = {},
  ): Promise<{ message_id: number } | void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        return await ctx.reply(text, options);
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn(
          "Telegram rate limit hit while replying, cooling down",
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            requestId: meta.requestId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  private async editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options: Parameters<TelegramMenuContext["editMessageText"]>[1] = {},
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.editMessageText(text, options);
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
              "Telegram rate limit hit while editing message, cooling down",
              {
                kind: meta.kind,
                sessionId: meta.sessionId,
                requestId: meta.requestId,
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

  private clearWaiter(requestId: string): void {
    this.requestFlow.clearWaiter(requestId);
  }

  private createMainMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createMainMenu();
  }

  private createAdminMainMenu(): Menu<TelegramMenuContext> {
    return this.adminMenus.createAdminMainMenu();
  }

  private createAdminClientsMenu(): Menu<TelegramMenuContext> {
    return this.adminMenus.createAdminClientsMenu();
  }

  private createAdminClientSessionsMenu(): Menu<TelegramMenuContext> {
    return this.adminMenus.createAdminClientSessionsMenu();
  }

  private createAdminClientSessionDetailMenu(): Menu<TelegramMenuContext> {
    return this.adminMenus.createAdminClientSessionDetailMenu();
  }

  private createAdminToolsMenu(): Menu<TelegramMenuContext> {
    return this.adminMenus.createAdminToolsMenu();
  }

  private createBrowserMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createBrowserMenu();
  }

  private createProjectsMenu(): Menu<TelegramMenuContext> {
    return this.projectMenus.createProjectsMenu();
  }

  private createCollabToolsMenu(): Menu<TelegramMenuContext> {
    return this.projectMenus.createCollabToolsMenu();
  }

  private createCollabDeleteMenu(): Menu<TelegramMenuContext> {
    return this.projectMenus.createCollabDeleteMenu();
  }

  private createLocalMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createLocalMenu();
  }

  private createLinkMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createLinkMenu();
  }

  private createPartnerMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createPartnerMenu();
  }

  private createBufferMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createBufferMenu();
  }

  private createSettingsMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createSettingsMenu();
  }

  private createDeveloperMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createDeveloperMenu();
  }

  private createUnpairConfirmMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createUnpairConfirmMenu();
  }

  private createPruneConfirmMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createPruneConfirmMenu();
  }

  private createInboxMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createInboxMenu();
  }

  private createStorageMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createStorageMenu();
  }

  private createScreenshotsMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createScreenshotsMenu();
  }

  private createSessionsMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createSessionsMenu();
  }

  private createInboxMessageMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createInboxMessageMenu();
  }

  private createStorageMessageMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createStorageMessageMenu();
  }

  private createScreenshotMessageMenu(): Menu<TelegramMenuContext> {
    return this.menuFactories.createScreenshotMessageMenu();
  }

  private async handleMessage(ctx: TelegramMenuContext): Promise<void> {
    await this.messageFlow.handleMessage(ctx);
  }

  private async handleGatewayTopLevelMessage(
    ctx: TelegramMenuContext,
    text: string | null,
  ): Promise<boolean> {
    return this.messageFlow.handleGatewayTopLevelMessage(ctx, text);
  }

  private resolveGatewayTelegramSourceLabel(
    ctx: TelegramMenuContext,
  ): string {
    return this.messageFlow.resolveGatewayTelegramSourceLabel(ctx);
  }

  private inferGatewayInboxKind(text: string): PartnerNoteKind {
    return this.messageFlow.inferGatewayInboxKind(text);
  }

  private buildGatewayInboxSummary(text: string): string {
    return this.messageFlow.buildGatewayInboxSummary(text);
  }

  private async routeTelegramInboxToRelaySession(input: {
    ctx: TelegramMenuContext;
    principal: { telegramChatId: number; telegramUserId: number };
    relayTarget: { clientUuid: string; localSessionId: string; sourceClientUuid?: string };
    sourceSessionId: string;
    messageText: string;
    attachments: StoredAttachmentRecord[];
  }): Promise<void> {
    await this.messageFlow.routeTelegramInboxToRelaySession(input);
  }

  private async handlePairingCommand(
    ctx: TelegramMenuContext,
    code: string,
  ): Promise<void> {
    await this.messageFlow.handlePairingCommand(ctx, code);
  }

  private async handleAdminAuthCommand(
    ctx: TelegramMenuContext,
    principal: { telegramChatId: number; telegramUserId: number },
    token: string,
  ): Promise<void> {
    await this.messageFlow.handleAdminAuthCommand(ctx, principal, token);
  }

  private async handleReply(ctx: TelegramMenuContext): Promise<boolean> {
    return this.messageFlow.handleReply(ctx);
  }

  private async handleInboxCapture(ctx: TelegramMenuContext): Promise<void> {
    await this.messageFlow.handleInboxCapture(ctx);
  }

  private async handleAttachmentUpload(
    ctx: TelegramMenuContext,
    attachmentDescriptors: TelegramAttachmentDescriptor[],
  ): Promise<void> {
    await this.messageFlow.handleAttachmentUpload(ctx, attachmentDescriptors);
  }

  private clearTmuxNudgeDebounceTimers(): void {
    for (const timer of this.tmuxNudgeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.tmuxNudgeDebounceTimers.clear();
  }

  private startTmuxPromptScan(): void {
    if (!this.config.tmux.promptScanEnabled) {
      return;
    }

    this.clearTmuxPromptScanTimer();

    const intervalMs = this.config.tmux.promptScanIntervalSeconds * 1000;
    const timer = setInterval(() => {
      void this.runTmuxPromptScanCycle().catch((error) => {
        this.logger.warn("tmux prompt scan cycle failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    this.tmuxPromptScanTimer = timer;

    this.logger.info("tmux prompt scan scheduled", {
      intervalSeconds: this.config.tmux.promptScanIntervalSeconds,
      cooldownSeconds: this.config.tmux.promptScanCooldownSeconds,
      strategy: this.config.tmux.promptScanStrategy,
      minScore: this.config.tmux.promptScanMinScore,
    });

    void this.runTmuxPromptScanCycle().catch((error) => {
      this.logger.warn("initial tmux prompt scan failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
  }

  private clearTmuxPromptScanTimer(): void {
    if (this.tmuxPromptScanTimer) {
      clearInterval(this.tmuxPromptScanTimer);
      this.tmuxPromptScanTimer = undefined;
    }
  }

  private async runTmuxPromptScanCycle(): Promise<void> {
    if (!this.config.tmux.promptScanEnabled || this.tmuxPromptScanInFlight) {
      return;
    }

    this.tmuxPromptScanInFlight = true;
    try {
      const sessions = await this.sessionStore.listSessions();
      for (const session of sessions) {
        await this.tmuxActions.scanPromptForSession(session);
      }
    } finally {
      this.tmuxPromptScanInFlight = false;
    }
  }

  private scheduleTmuxNudgeForInboxMessage(
    sessionId: string,
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): void {
    if (!this.config.tmux.nudgeEnabled) {
      return;
    }

    if (!session?.tmuxTarget) {
      this.logger.debug("tmux nudge scheduling skipped for inbox message", {
        sessionId,
        reason: "no_tmux_target",
      });
      return;
    }

    const existingTimer = this.tmuxNudgeDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.tmuxNudgeDebounceTimers.delete(sessionId);
      void this.tmuxActions.nudgeForInboxMessage(sessionId).catch((error) => {
        const payload = {
          sessionId,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };

        if (isTmuxUnavailableError(error)) {
          void this.sessionStore.getSession(sessionId).then((session) => {
            if (!session?.tmuxTarget) {
              return;
            }

            return this.tmuxActions.notifyUnavailable(sessionId, session, error);
          });
          this.logger.warn(
            "tmux nudge skipped because tmux is unavailable",
            payload,
          );
          return;
        }

        this.logger.error("tmux nudge failed", payload);
      });
    }, this.config.tmux.nudgeDebounceSeconds * 1000);
    timer.unref();
    this.tmuxNudgeDebounceTimers.set(sessionId, timer);

    this.logger.info("tmux nudge scheduled for inbox message", {
      sessionId,
      tmuxTarget: session.tmuxTarget,
      debounceSeconds: this.config.tmux.nudgeDebounceSeconds,
    });
  }

  private async sendTypingForSession(sessionId: string): Promise<void> {
    if (!this.isTelegramEnabled()) {
      this.logger.debug("Telegram typing skipped because transport is disabled", {
        sessionId,
      });
      return;
    }

    const binding = await this.bindingStore.getBinding(sessionId);
    if (!binding) {
      this.logger.debug("Telegram typing skipped because session is unbound", {
        sessionId,
      });
      return;
    }

    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.bot.api.sendChatAction(binding.telegramChatId, "typing");
        this.logger.debug("Telegram typing action sent", {
          sessionId,
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        });
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn(
          "Telegram rate limit hit while sending typing action, cooling down",
          {
            sessionId,
            telegramChatId: binding.telegramChatId,
            telegramUserId: binding.telegramUserId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  private async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuState.showMainMenu(ctx, introText);
  }

  private async buildMainMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.menuState.buildMainMenuText(ctx);
  }

  private async showAdminMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildAdminMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.adminMainMenu,
    );
  }

  private async buildAdminMainMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    let clients: AdminClientViewRecord[] | null = null;
    try {
      clients = await this.listGatewayAdminClients();
    } catch (error) {
      this.logger.warn("Failed to load gateway clients for admin main menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return buildAdminMainMenuText({
      title: this.t(locale, "menu:admin.screen.title"),
      gatewayClientsLine: clients
        ? this.t(locale, "menu:admin.screen.gateway_clients", {
            count: clients.length,
          })
        : null,
      connectedClientsLine: clients
        ? this.t(locale, "menu:admin.screen.gateway_clients_connected", {
            count: clients.filter((client) => client.is_connected).length,
          })
        : null,
      registeredClientsLine: clients
        ? this.t(locale, "menu:admin.screen.gateway_clients_registered", {
            count: clients.filter((client) => client.is_registered).length,
          })
        : null,
      unavailableLine: clients
        ? null
        : this.t(locale, "menu:admin.screen.gateway_clients_unavailable"),
      hintLine: this.t(locale, "menu:admin.screen.hint"),
    });
  }

  private async showAdminClientsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.adminActions.buildClientsMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.adminClientsMenu,
    );
  }

  private async showAdminClientSessionsMenu(
    ctx: TelegramMenuContext,
    client?: AdminClientViewRecord,
  ): Promise<void> {
    await this.adminActions.showClientSessionsMenu(ctx, client);
  }

  private async showAdminClientSessionDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid: string;
      targetLocalSessionId: string;
      projectUuid?: string;
      projectName?: string;
    },
    payloadKey: string,
  ): Promise<void> {
    await this.adminActions.showClientSessionDetail(ctx, input, payloadKey);
  }

  private async showAdminClientSessionList(
    ctx: TelegramMenuContext,
    scope: "collab" | "all",
  ): Promise<void> {
    await this.adminActions.showClientSessionList(ctx, scope);
  }

  private async showAdminToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.adminActions.showToolsMenu(ctx, introText);
  }

  private async getTmuxStatusLine(locale: SupportedLocale): Promise<string> {
    return this.t(locale, "menu:main.screen.tmux_mode_direct");
  }

  private async buildMainMenuFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildMainMenuFingerprint(ctx);
  }

  private async buildInboxFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildInboxFingerprint(ctx);
  }

  private async buildStorageFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildStorageFingerprint(ctx);
  }

  private async buildScreenshotsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildScreenshotsFingerprint(ctx);
  }

  private async buildSessionsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildSessionsFingerprint(ctx);
  }

  private async buildLinkFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildLinkFingerprint(ctx);
  }

  private async buildInboxButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildInboxButtonLabel(ctx);
  }

  private async buildScreenshotsButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildScreenshotsButtonLabel(ctx);
  }

  private async buildLinkButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFingerprints.buildLinkButtonLabel(ctx);
  }

  private async createInboxMenuPayload(
    sessionId: string,
    messageId: string,
  ): Promise<string> {
    return this.payloadState.createInboxMenuPayload(sessionId, messageId);
  }

  private async createFileMenuPayload(
    sessionId: string,
    filePath: string,
  ): Promise<string> {
    return this.payloadState.createFileMenuPayload(sessionId, filePath);
  }

  private async createSessionMenuPayload(sessionId: string): Promise<string> {
    return this.payloadState.createSessionMenuPayload(sessionId);
  }

  private async createLinkMenuPayload(
    sessionId: string,
    targetSessionId: string,
  ): Promise<string> {
    return this.payloadState.createLinkMenuPayload(sessionId, targetSessionId);
  }

  private async createAdminClientMenuPayload(
    client: AdminClientViewRecord,
  ): Promise<string> {
    return this.payloadState.createAdminClientMenuPayload(client);
  }

  private async createAdminClientSessionMenuPayload(
    session: AdminClientSessionViewRecord,
  ): Promise<string> {
    return this.payloadState.createAdminClientSessionMenuPayload(session);
  }

  private async createProjectMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    return this.payloadState.createProjectMenuPayload(sessionId, projectUuid, title);
  }

  private async createProjectDeleteMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    return this.payloadState.createProjectDeleteMenuPayload(sessionId, projectUuid, title);
  }

  private async createProjectMemberMenuPayload(
    sessionId: string,
    projectUuid: string,
    targetSessionId: string,
    title: string,
    options?: {
      filePath?: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<string> {
    return this.payloadState.createProjectMemberMenuPayload(
      sessionId,
      projectUuid,
      targetSessionId,
      title,
      options,
    );
  }

  private async createLiveApprovalMenuPayload(input: {
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  }): Promise<string> {
    return this.payloadState.createLiveApprovalMenuPayload(input);
  }

  private async createPartnerFileTargetPayload(
    sessionId: string,
    targetSessionId: string,
    title: string,
    filePath: string,
  ): Promise<string> {
    return this.payloadState.createPartnerFileTargetPayload(
      sessionId,
      targetSessionId,
      title,
      filePath,
    );
  }

  private async listActiveSessionFiles(sessionId: string): Promise<string[]> {
    return this.xchangeState.listActiveSessionFiles(sessionId);
  }

  private async listActiveSessionStorageEntries(sessionId: string): Promise<
  Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  > {
    return this.xchangeState.listActiveSessionStorageEntries(sessionId);
  }

  private async listActiveSessionScreenshots(
    sessionId: string,
  ): Promise<string[]> {
    return this.xchangeState.listActiveSessionScreenshots(sessionId);
  }

  private async listSessionFilesystemXchangeFiles(
    sessionId: string,
  ): Promise<string[]> {
    return this.xchangeState.listSessionFilesystemXchangeFiles(sessionId);
  }

  private async listReconciledSessionXchangeMetas(
    sessionId: string,
    existingFiles: string[],
  ): Promise<TelegramXchangeFileMeta[]> {
    return this.xchangeState.listReconciledSessionXchangeMetas(
      sessionId,
      existingFiles,
    );
  }

  private async handleInboxMessageOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleInboxMessageOpen(ctx, readMenuPayloadKey(ctx));
  }

  private async beginFileHandoffModeForTarget(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      filePath: string;
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void> {
    await this.fileHandoffActions.beginModeForTarget(ctx, input);
  }

  private async handleLinkButton(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (session?.linkedSessionId) {
      await this.unlinkSessions(sessionId, session.linkedSessionId);
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:link.actions.unlinked"),
      });
      await this.showMainMenu(ctx, this.t(locale, "menu:link.actions.unlinked"));
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:link.actions.choose_partner"),
    });
    await this.showLinkMenu(ctx);
  }

  private async showPartnerEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.showPartnerEntryPoint(ctx);
  }

  private async showPartnerFiles(ctx: TelegramMenuContext): Promise<void> {
    await this.menuCallbacks.showPartnerFiles(ctx);
  }

  private async showLocalEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await ctx.answerCallbackQuery({
      text: await this.tForContext(ctx, "menu:local.actions.open_local"),
    });
    await this.showLocalMenu(ctx);
  }

  private async showProjectsEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    if (!this.config.distributed.gatewayPublicUrl) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:collab.actions.gateway_only"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: await this.tForContext(ctx, "menu:collab.actions.open_collab"),
    });
    await this.showProjectsMenu(ctx);
  }

  private async handleLinkTargetSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleLinkTargetSelect(ctx, readMenuPayloadKey(ctx));
  }

  private async handleScreenshotOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleScreenshotOpen(ctx, readMenuPayloadKey(ctx));
  }

  private async handleScreenshotGet(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleScreenshotGet(ctx, readMenuPayloadKey(ctx));
  }

  private async handleScreenshotDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleScreenshotDelete(ctx, readMenuPayloadKey(ctx));
  }

  private async handleStorageOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleStorageOpen(ctx, readMenuPayloadKey(ctx));
  }

  private async handleStorageGet(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleStorageGet(ctx, readMenuPayloadKey(ctx));
  }

  private async handleStorageDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleStorageDelete(ctx, readMenuPayloadKey(ctx));
  }

  private async handleInboxMessageDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleInboxMessageDelete(ctx, readMenuPayloadKey(ctx));
  }

  private async handleSessionSelection(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuCallbacks.handleSessionSelection(ctx, readMenuPayloadKey(ctx));
  }

  private formatInboxPreviewLabel(message: TelegramInboxMessage): string {
    return formatInboxPreviewLabel(message);
  }

  private formatFilePreviewLabel(
    filePath: string,
    meta?: {
      originalName?: string | undefined;
      relativePath?: string | undefined;
    } | null,
  ): string {
    return formatFilePreviewLabel(filePath, meta);
  }

  private formatStoragePreviewLabel(
    filePath: string,
    meta?: TelegramXchangeFileMeta | null,
  ): string {
    return formatStoragePreviewLabel(filePath, meta);
  }

  private formatStorageDetail(
    sessionId: string,
    filePath: string,
    meta?: TelegramXchangeFileMeta | null,
  ): string {
    return formatStorageDetail(sessionId, filePath, meta);
  }

  private formatSessionMenuLabel(input: {
    sessionId: string;
    sessionLabel?: string;
    linkedSessionLabel?: string;
    active: boolean;
    inboxCount: number;
  }): string {
    return formatSessionMenuLabel(input);
  }

  private formatInboxDetail(message: TelegramInboxMessage): string {
    return formatInboxDetail(message);
  }

  private formatFileDetail(
    sessionId: string,
    filePath: string,
    meta?: {
      originalName?: string | undefined;
      relativePath?: string | undefined;
      caption?: string | undefined;
      uploadedAt?: string | undefined;
    } | null,
  ): string {
    return formatFileDetail(sessionId, filePath, meta);
  }

  private formatScreenshotDetail(
    sessionId: string,
    filePath: string,
    meta?: {
      caption?: string | undefined;
      uploadedAt?: string | undefined;
    } | null,
  ): string {
    return formatScreenshotDetail(sessionId, filePath, meta);
  }

  private extractIncomingText(
    message: TelegramMenuContext["message"] | undefined,
  ): string | null {
    return extractIncomingText(message);
  }

  private collectIncomingAttachments(
    message: TelegramMenuContext["message"] | undefined,
  ): TelegramAttachmentDescriptor[] {
    return collectIncomingAttachments(message);
  }

  private buildInboxText(text: string | null, attachments: string[]): string {
    return buildInboxText(text, attachments);
  }

  private async storeTelegramUploadMetas(input: {
    sessionId: string;
    sourceTelegramMessageId: number;
    uploadedAt: string;
    attachments: StoredAttachmentRecord[];
    descriptors?: TelegramAttachmentDescriptor[] | undefined;
    caption?: string | undefined;
  }): Promise<void> {
    for (let index = 0; index < input.attachments.length; index += 1) {
      const attachment = input.attachments[index];
      if (!attachment) {
        continue;
      }

      const descriptor = input.descriptors?.[index];
      await this.xchangeFileMetaStore.setXchangeFileMeta({
        sessionId: input.sessionId,
        filePath: attachment.filePath,
        relativePath: attachment.relativePath,
        source: "telegram-upload",
        sourceTelegramMessageId: input.sourceTelegramMessageId,
        uploadedAt: input.uploadedAt,
        storageRef: attachment.storageRef,
        bucketName: attachment.bucketName,
        objectName: attachment.objectName,
        vfsNodeId: attachment.vfsNodeId,
        vfsPublicUrl: attachment.vfsPublicUrl,
        vfsParentId: attachment.vfsParentId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(
          descriptor && !descriptor.preferredName.startsWith("photo-")
            ? { originalName: descriptor.preferredName }
            : {}
        ),
        ...(input.caption ? { caption: input.caption } : {}),
      });
    }
  }

  private async ensureStoredXchangeFile(
    sessionId: string,
    filePath: string,
    source: TelegramXchangeFileMeta["source"],
  ): Promise<{ session: Awaited<ReturnType<SessionStore["getSession"]>>; filePath: string }> {
    const session = await this.sessionStore.getSession(sessionId);
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      sessionId,
      filePath,
    );

    if (!meta) {
      return { session, filePath };
    }

    const materializedPath = await this.objectStore.ensureLocalFile({
      sessionId,
      session,
      filePath,
      relativePath: meta.relativePath,
      storageRef: meta.storageRef,
      source,
    });

    return {
      session,
      filePath: materializedPath,
    };
  }

  private async downloadIncomingAttachments(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    sourceTelegramMessageId: number,
    attachments: TelegramAttachmentDescriptor[],
  ): Promise<StoredAttachmentRecord[]> {
    if (attachments.length === 0) {
      return [];
    }

    const savedFiles: StoredAttachmentRecord[] = [];
    for (const attachment of attachments) {
      const savedFile = await this.downloadTelegramFile(
        session,
        sessionId,
        attachment.fileId,
        sourceTelegramMessageId,
        attachment.preferredName,
        attachment.mimeType,
      );
      savedFiles.push(savedFile);
    }

    return savedFiles;
  }

  private async downloadTelegramFile(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    fileId: string,
    _sourceTelegramMessageId: number,
    preferredName: string,
    preferredMimeType?: string | undefined,
  ): Promise<StoredAttachmentRecord> {
    const telegramFile = await this.bot.api.getFile(fileId);
    if (!telegramFile.file_path) {
      throw new Error("Telegram file path is missing");
    }

    const outputName = preferredName;
    const fileUrl = `https://api.telegram.org/file/bot${this.getRequiredBotToken(
      "download Telegram files",
    )}/${telegramFile.file_path}`;
    const response = await this.telegramFetch(fileUrl);

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with status ${response.status}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return this.objectStore.storeFile({
      session,
      sessionId,
      source: "telegram-upload",
      relativePath: buildDatedRelativePath(outputName),
      content: buffer,
      mimeType:
        preferredMimeType ||
        response.headers.get("content-type") ||
        undefined,
    });
  }

  private slugifyPathPart(input: string): string {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    return slug.slice(0, 80) || "item";
  }

  private getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
      return null;
    }

    return {
      telegramChatId: chatId,
      telegramUserId: userId,
    };
  }

  private async resolveLocaleForContext(
    ctx: TelegramMenuContext,
  ): Promise<SupportedLocale> {
    if (this.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.config.telegram.debugLanguage);
    }

    const telegramUserId = ctx.from?.id;
    const telegramLanguageCode = ctx.from?.language_code;
    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  private async resolveLocaleForTelegramUserId(
    telegramUserId?: number,
    telegramLanguageCode?: string | null | undefined,
  ): Promise<SupportedLocale> {
    if (this.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.config.telegram.debugLanguage);
    }

    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  private async tForContext(
    ctx: TelegramMenuContext,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(await this.resolveLocaleForContext(ctx), key, options);
  }

  private async tForTelegramUserId(
    telegramUserId: number | undefined,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(await this.resolveLocaleForTelegramUserId(telegramUserId), key, options);
  }

  private t(
    locale: SupportedLocale,
    key: string,
    options?: Record<string, unknown>,
  ): string {
    return translate(locale, key, options);
  }

  private getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined {
    const firstName = ctx.from?.first_name?.trim();
    const lastName = ctx.from?.last_name?.trim();
    const username = ctx.from?.username?.trim();
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName && !lastName && !username) {
      return undefined;
    }

    return {
      ...(username ? { telegramUsername: username } : {}),
      ...(firstName ? { telegramFirstName: firstName } : {}),
      ...(lastName ? { telegramLastName: lastName } : {}),
      ...(displayName ? { telegramDisplayName: displayName } : {}),
    };
  }

  private async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showSessionsMenu(ctx, introText);
  }

  private async showInboxMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showInboxMenu(ctx, introText);
  }

  private async showStorageMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showStorageMenu(ctx, introText);
  }

  private async showBrowserMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showBrowserMenu(ctx, introText);
  }

  private async showScreenshotsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showScreenshotsMenu(ctx, introText);
  }

  private async showLinkMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showLinkMenu(ctx, introText);
  }

  private async showPartnerMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showPartnerMenu(ctx, introText);
  }

  private async showLocalMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showLocalMenu(ctx, introText);
  }

  private async showProjectsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showProjectsMenu(ctx, introText);
  }

  private async showCollabToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showCollabToolsMenu(ctx, introText);
  }

  private async handleCollabHistoryExport(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuFlow.handleCollabHistoryExport(ctx);
  }

  private async showCollabDeleteMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showCollabDeleteMenu(ctx, introText);
  }

  private async showSettingsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showSettingsMenu(ctx, introText);
  }

  private async showBufferMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showBufferMenu(ctx, introText);
  }

  private async showDeveloperMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showDeveloperMenu(ctx, introText);
  }

  private async showUnpairConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showUnpairConfirmMenu(ctx, introText);
  }

  private async showPruneConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.menuFlow.showPruneConfirmMenu(ctx, introText);
  }

  private async renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    await this.menuFlow.renderMenuScreen(ctx, text, meta, menu);
  }

  private async renderMenuMarkdownScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    await this.menuFlow.renderMenuMarkdownScreen(ctx, text, meta, menu);
  }

  private async renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    await this.menuFlow.renderMenuHtmlScreen(ctx, text, meta, menu);
  }

  private async showHelp(ctx: TelegramMenuContext): Promise<void> {
    await this.menuFlow.showHelp(ctx);
  }

  private async showLiveViewLauncher(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuFlow.showLiveViewLauncher(ctx);
  }

  private clearPendingInteractionsForContext(ctx: TelegramMenuContext): void {
    this.menuFlow.clearPendingInteractionsForContext(ctx);
  }

  private setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void {
    this.menuFlow.setCurrentAttachmentTargetForContext(ctx, target);
  }

  private async sendActiveSessionBuffer(
    ctx: TelegramMenuContext,
    scope: TmuxCaptureScope,
  ): Promise<void> {
    await this.menuFlow.sendActiveSessionBuffer(ctx, scope);
  }

  private async buildSessionsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildSessionsMenuText(ctx);
  }

  private async buildInboxMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.menuFlow.buildInboxMenuText(ctx);
  }

  private async buildBufferMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildBufferMenuText(ctx);
  }

  private async buildBrowserMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildBrowserMenuText(ctx);
  }

  private async buildSettingsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildSettingsMenuText(ctx);
  }

  private async buildScreenshotsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildScreenshotsMenuText(ctx);
  }

  private async buildStorageMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildStorageMenuText(ctx);
  }

  private async buildLinkMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.menuFlow.buildLinkMenuText(ctx);
  }

  private async buildPartnerMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildPartnerMenuText(ctx);
  }

  private async buildLocalMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildLocalMenuText(ctx);
  }

  private async buildProjectsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildProjectsMenuText(ctx);
  }

  private async buildCollabToolsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildCollabToolsMenuText(ctx);
  }

  private async buildCollabDeleteMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildCollabDeleteMenuText(ctx);
  }

  private async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildDeveloperMenuText(ctx);
  }

  private async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildUnpairConfirmText(ctx);
  }

  private async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.menuFlow.buildPruneConfirmText(ctx);
  }

  private async showActiveSessionInfo(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.menuFlow.showActiveSessionInfo(ctx);
  }

  private async linkSessions(
    sessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    if (sessionId === targetSessionId) {
      throw new Error("A session cannot be linked to itself.");
    }

    const sourceSession = await this.sessionStore.getSession(sessionId);
    const targetSession = await this.sessionStore.getSession(targetSessionId);
    if (!sourceSession || !targetSession) {
      throw new Error("Source or target session does not exist.");
    }

    await this.unlinkSessions(sessionId, sourceSession.linkedSessionId);
    await this.unlinkSessions(targetSessionId, targetSession.linkedSessionId);

    await this.sessionStore.setSession({
      ...sourceSession,
      linkedSessionId: targetSessionId,
      updatedAt: new Date().toISOString(),
    });
    await this.sessionStore.setSession({
      ...targetSession,
      linkedSessionId: sessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  private async unlinkSessions(
    sessionId: string,
    linkedSessionId?: string | undefined,
  ): Promise<void> {
    const sourceSession = await this.sessionStore.getSession(sessionId);
    if (!sourceSession) {
      return;
    }

    const partnerId = linkedSessionId ?? sourceSession.linkedSessionId;
    if (sourceSession.linkedSessionId) {
      const { linkedSessionId: _linkedSessionId, ...rest } = sourceSession;
      await this.sessionStore.setSession({
        ...rest,
        updatedAt: new Date().toISOString(),
      });
    }

    if (!partnerId) {
      return;
    }

    const partnerSession = await this.sessionStore.getSession(partnerId);
    if (!partnerSession || partnerSession.linkedSessionId !== sessionId) {
      return;
    }

    const { linkedSessionId: _partnerLinkedSessionId, ...restPartner } =
      partnerSession;
    await this.sessionStore.setSession({
      ...restPartner,
      updatedAt: new Date().toISOString(),
    });
  }

  private async replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: Parameters<TelegramMenuContext["replyWithDocument"]>[1] = {},
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.replyWithDocument(document, options);
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn(
          "Telegram rate limit hit while sending document, cooling down",
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            requestId: meta.requestId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  private async unpairActiveSession(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (session && this.config.distributed.gatewayPublicUrl) {
      const clientUuid = await this.maintenanceStore.getGatewayClientUuid();
      if (clientUuid) {
        await this.callGatewayJson("/sessions/unregister", {
          client_uuid: clientUuid,
          local_session_id: sessionId,
        });
      }
      await this.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.bindingStore.clearBinding(sessionId);

    this.logger.info("Telegram active session unpaired from menu", {
      sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    this.clearPendingInteractionsForContext(ctx);

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:unpair.done", {
        sessionName: session?.label ?? sessionId,
      }),
    });
    await this.showSessionsMenu(
      ctx,
      this.t(locale, "menu:unpair.shown", {
        sessionName: session?.label ?? sessionId,
      }),
    );
  }

  private async beginRenameActiveSession(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingBroadcasts.delete(principalKey);
    this.pendingRenames.set(principalKey, { sessionId });
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:settings.actions.rename_prompt"),
    });
    await this.replyText(
      ctx,
      ["✏ Rename session", "", this.t(locale, "menu:settings.actions.rename_body")].join(
        "\n",
      ),
      { kind: "menu", sessionId },
    );
  }

  private async beginBroadcast(ctx: TelegramMenuContext): Promise<void> {
    await this.broadcastActions.beginBroadcast(ctx);
  }

  private async beginProjectBroadcast(ctx: TelegramMenuContext): Promise<void> {
    await this.broadcastActions.beginProjectBroadcast(ctx);
  }

  private async collectCollabBroadcastTargets(
    principal: { telegramChatId: number; telegramUserId: number },
    _sessionId: string,
  ): Promise<{
    localTargetSessionIds: string[];
    remoteTargets: PendingProjectBroadcastRemoteTarget[];
  }> {
    return this.broadcastActions.listCollabBroadcastTargets(principal);
  }

  private async cancelPendingBroadcast(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.broadcastActions.cancelPendingBroadcast(ctx);
  }

  private async pruneAllSessions(ctx: TelegramMenuContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: "Pruning all state..." });
    const result = await this.maintenanceStore.pruneAll();
    this.clearPendingInteractionsForContext(ctx);
    this.clearTmuxNudgeDebounceTimers();
    await this.showSessionsMenu(
      ctx,
      `Prune complete. Deleted ${result.deletedKeys} Redis keys.`,
    );
  }

  private async handlePendingRename(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const pending = this.pendingRenames.get(buildPrincipalKey(principal));
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingRenames.delete(buildPrincipalKey(principal));
      return false;
    }

    const session = await this.sessionStore.getSession(pending.sessionId);
    const updatedAt = new Date().toISOString();
    const label = redactSecrets(text);

    await this.sessionStore.setSession({
      sessionId: pending.sessionId,
      label,
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.linkedSessionId
        ? { linkedSessionId: session.linkedSessionId }
        : {}),
      ...(session?.task ? { task: session.task } : {}),
      ...(session?.summary ? { summary: session.summary } : {}),
      ...(session?.files ? { files: session.files } : {}),
      ...(session?.decisions ? { decisions: session.decisions } : {}),
      ...(session?.risks ? { risks: session.risks } : {}),
      ...(session?.tmuxSessionName
        ? { tmuxSessionName: session.tmuxSessionName }
        : {}),
      ...(session?.tmuxWindowName
        ? { tmuxWindowName: session.tmuxWindowName }
        : {}),
      ...(typeof session?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: session.tmuxWindowIndex }
        : {}),
      ...(session?.tmuxPaneId ? { tmuxPaneId: session.tmuxPaneId } : {}),
      ...(typeof session?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: session.tmuxPaneIndex }
        : {}),
      ...(session?.tmuxTarget ? { tmuxTarget: session.tmuxTarget } : {}),
      ...(session?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: session.lastTmuxNudgeAt }
        : {}),
      updatedAt,
    });

    this.pendingRenames.delete(buildPrincipalKey(principal));
    this.logger.info("Telegram session renamed from menu", {
      sessionId: pending.sessionId,
      sessionLabel: label,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await this.replyText(
      ctx,
      `Session renamed: ${label}`,
      { kind: "menu", sessionId: pending.sessionId },
      { reply_markup: this.mainMenu },
    );
    return true;
  }

  private async handlePendingBroadcast(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    return this.broadcastActions.handlePendingBroadcast(ctx, text);
  }

  private async beginPartnerNoteMode(
    ctx: TelegramMenuContext,
    kind: PartnerNoteKind,
    target?: {
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void> {
    await this.partnerActions.beginPartnerNoteMode(ctx, kind, target);
  }

  private async cancelPendingPartnerNote(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.partnerActions.cancelPendingPartnerNote(ctx);
  }

  private async beginProjectMode(
    ctx: TelegramMenuContext,
    mode: "create" | "join",
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const sent = await this.replyText(
      ctx,
      mode === "create"
        ? [
            this.t(locale, "menu:project.create_prompt_title"),
            "",
            this.t(locale, "menu:project.create_prompt_body"),
            this.t(locale, "menu:project.prompt_cancel"),
          ].join("\n")
        : [
            this.t(locale, "menu:project.join_prompt_title"),
            "",
            this.t(locale, "menu:project.join_prompt_body"),
            this.t(locale, "menu:project.prompt_cancel"),
          ].join("\n"),
      { kind: "menu", sessionId },
    );

    this.pendingProjects.set(buildPrincipalKey(principal), {
      sessionId,
      mode,
      initiatedAt: new Date().toISOString(),
      ...(sent ? { promptMessageId: sent.message_id } : {}),
    });

    await ctx.answerCallbackQuery({
      text:
        mode === "create"
          ? this.t(locale, "menu:project.start_create")
          : this.t(locale, "menu:project.start_join"),
    });
  }

  private async handleProjectSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_missing"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const project = await this.getProjectPayloadByUuid(
      payload.sessionId,
      payload.projectUuid,
    );
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      return;
    }

    await this.ensureOpenedProjectIsActive({
      principal,
      sessionId: project.sessionId,
      projectUuid: project.projectUuid,
      projectName: project.projectName,
    });
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_members"),
    });
    await this.showProjectMembers(ctx, project);
  }

  private async handleProjectDeleteSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_missing"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-delete-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const projects = await this.listGatewayProjects(principal);
    const project = projects.find((item) => item.project_uuid === payload.projectUuid);
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (project.role !== "owner") {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.delete_only_owner"),
        show_alert: true,
      });
      return;
    }

    await this.handleProjectDeleteByUuid(ctx, payload.projectUuid);
  }

  private async leaveActiveProject(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.activeProjectUuid) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.no_active_project"),
        show_alert: true,
      });
      return;
    }

    const clientUuid = await this.ensureGatewayClientUuid(principal);
    await this.callGatewayJson("/projects/leave", {
      client_uuid: clientUuid,
      project_uuid: session.activeProjectUuid,
    });

    await this.sessionStore.setSession({
      ...session,
      activeProjectUuid: undefined,
      activeProjectName: undefined,
      updatedAt: new Date().toISOString(),
    });

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.left_current"),
    });
    await this.showProjectsMenu(
      ctx,
      this.t(locale, "menu:project.left_current_screen"),
    );
  }

  private async showProjectDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
  ): Promise<void> {
    await this.projectView.showProjectDetail(ctx, input);
  }

  private async showProjectMembers(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
    options?: {
      filePath?: string;
    },
  ): Promise<void> {
    await this.projectView.showProjectMembers(ctx, input, options);
  }

  private async showProjectMemberDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void> {
    await this.projectView.showProjectMemberDetail(ctx, input);
  }

  private async showProjectMemberFiles(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void> {
    await this.projectView.showProjectMemberFiles(ctx, input);
  }

  private async getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
      projectName: string;
      inviteToken: string;
    } | null> {
    return this.projectState.getProjectPayloadByUuid(sessionId, projectUuid);
  }

  private async getProjectMemberPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid?: string;
    targetLocalSessionId?: string;
    filePath?: string;
  } | null> {
    return this.projectState.getProjectMemberPayloadByKey(payloadKey);
  }

  private async getPartnerFileTargetPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    filePath: string;
  } | null> {
    return this.projectState.getPartnerFileTargetPayloadByKey(payloadKey);
  }

  private async getLiveApprovalPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  } | null> {
    return this.projectState.getLiveApprovalPayloadByKey(payloadKey);
  }

  private async getAdminClientSessionPayloadByKey(
    payloadKey: string,
  ): Promise<GatewayRelayBindingPayload | null> {
    return this.projectState.getAdminClientSessionPayloadByKey(payloadKey);
  }

  private buildRelaySessionContext(
    input: GatewayRelayBindingPayload,
  ): SessionContext {
    return this.projectState.buildRelaySessionContext(input);
  }

  private async bindRelaySessionToPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
    payload: GatewayRelayBindingPayload;
  }): Promise<SessionContext> {
    return this.projectState.bindRelaySessionToPrincipal(input);
  }

  private extractCallbackSuffix(
    ctx: TelegramMenuContext,
    prefix: string,
  ): string | null {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith(prefix)) {
      return null;
    }
    return data.slice(prefix.length) || null;
  }

  private async handleAdminClientSelectCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.adminActions.handleClientSelectCallback(ctx, readMenuPayloadKey);
  }

  private async handleAdminClientSessionOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.adminActions.handleClientSessionOpenCallback(ctx, readMenuPayloadKey);
  }

  private async handleAdminClientSessionLiveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.adminActions.handleClientSessionLiveCallback(ctx);
  }

  private async handleAdminClientSessionBindCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.adminActions.handleClientSessionBindCallback(ctx);
  }

  private async handleProjectSetCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectSetCallback(ctx);
  }

  private async handleProjectDetailCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectDetailCallback(ctx);
  }

  private async handleProjectDeleteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectDeleteCallback(ctx);
  }

  private async handleProjectMemberOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectMemberOpenCallback(ctx);
  }

  private async handleProjectMemberNoteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectMemberNoteCallback(ctx);
  }

  private async handleProjectMemberLiveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectMemberLiveCallback(ctx);
  }

  private async handleLiveApprovalCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleLiveApprovalCallback(ctx);
  }

  private async handleProjectMemberFilesCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectMemberFilesCallback(ctx);
  }

  private async handlePartnerFileOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handlePartnerFileOpenCallback(ctx);
  }

  private async handleProjectMembersCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectMembersCallback(ctx);
  }

  private async handleProjectLeaveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.projectActions.handleProjectLeaveCallback(ctx);
  }

  private async handleProjectDeleteByUuid(
    ctx: TelegramMenuContext,
    projectUuid: string,
  ): Promise<void> {
    await this.projectActions.handleProjectDeleteByUuid(ctx, projectUuid);
  }

  private async cancelPendingFileHandoff(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.fileHandoffActions.cancelPending(ctx);
  }

  private async handlePendingPartnerNote(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    return this.partnerActions.handlePendingPartnerNote(ctx, text);
  }

  private async handlePendingFileHandoff(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    return this.fileHandoffActions.handlePending(ctx, text);
  }

  private async handlePendingProject(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    return this.projectActions.handlePendingProject(ctx, text);
  }
}
