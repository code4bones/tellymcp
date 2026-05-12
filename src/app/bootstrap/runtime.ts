import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig, type AppConfig } from "../config/env.js";
import { WebAppLaunchRegistry } from "../webapp/auth.js";
import {
  createRedisClient,
  type RedisClient,
} from "../providers/redis/client.js";
import { createMcpServer } from "../providers/mcp/server.js";
import { createLogger, type Logger } from "../../shared/lib/logger/logger.js";
import { ProjectIdentityResolver } from "../../shared/lib/project-identity/projectIdentity.js";
import { RedisStateStore } from "../../shared/integrations/redis/stateStore.js";
import { TelegramTransport } from "../../shared/integrations/telegram/transport.js";
import { HumanApprovalOrchestrator } from "../../processes/human-approval/model/orchestrator.js";
import { PairSessionService } from "../../features/pair-session/model/generatePairCode.js";
import { ClearSessionPairingTool } from "../../features/pair-session/model/clearSessionPairingTool.js";
import { CreateSessionPairCodeTool } from "../../features/pair-session/model/createSessionPairCodeTool.js";
import { NotifyService } from "../../features/notify/model/notifyService.js";
import { NotifyTelegramTool } from "../../features/notify/model/notifyTelegramTool.js";
import { AskUserTelegramTool } from "../../features/ask-user/model/askUserTelegram.js";
import { InboxService } from "../../features/inbox/model/inboxService.js";
import { GetTelegramInboxCountTool } from "../../features/inbox/model/getTelegramInboxCountTool.js";
import { GetTelegramInboxTool } from "../../features/inbox/model/getTelegramInboxTool.js";
import { DeleteTelegramInboxMessageTool } from "../../features/inbox/model/deleteTelegramInboxMessageTool.js";
import { SessionContextService } from "../../features/session-context/model/sessionContextService.js";
import { SetSessionContextTool } from "../../features/session-context/model/setSessionContextTool.js";
import { GetSessionContextTool } from "../../features/session-context/model/getSessionContextTool.js";
import { GetTmuxTargetTool } from "../../features/session-context/model/getTmuxTargetTool.js";
import { RenameSessionTool } from "../../features/session-context/model/renameSessionTool.js";
import { ClearSessionContextTool } from "../../features/session-context/model/clearSessionContextTool.js";
import { SetTmuxTargetTool } from "../../features/session-context/model/setTmuxTargetTool.js";
import { BrowserService } from "../../features/browser/model/browserService.js";
import { BrowserOpenTool } from "../../features/browser/model/browserOpenTool.js";
import { BrowserReloadTool } from "../../features/browser/model/browserReloadTool.js";
import { BrowserClickTool } from "../../features/browser/model/browserClickTool.js";
import { BrowserFillTool } from "../../features/browser/model/browserFillTool.js";
import { BrowserPressTool } from "../../features/browser/model/browserPressTool.js";
import { BrowserWaitForTool } from "../../features/browser/model/browserWaitForTool.js";
import { BrowserWaitForUrlTool } from "../../features/browser/model/browserWaitForUrlTool.js";
import { BrowserConsoleTool } from "../../features/browser/model/browserConsoleTool.js";
import { BrowserErrorsTool } from "../../features/browser/model/browserErrorsTool.js";
import { BrowserNetworkFailuresTool } from "../../features/browser/model/browserNetworkFailuresTool.js";
import { BrowserClearLogsTool } from "../../features/browser/model/browserClearLogsTool.js";
import { BrowserDomTool } from "../../features/browser/model/browserDomTool.js";
import { BrowserComputedStyleTool } from "../../features/browser/model/browserComputedStyleTool.js";
import { BrowserScreenshotTool } from "../../features/browser/model/browserScreenshotTool.js";
import { BrowserCloseTool } from "../../features/browser/model/browserCloseTool.js";
import { CollaborationService } from "../../features/collaboration/model/collaborationService.js";
import type { CollaborationBackend } from "../../features/collaboration/model/backend.js";
import { LocalCollaborationBackend } from "../../features/collaboration/model/localCollaborationBackend.js";
import { SendPartnerNoteTool } from "../../features/collaboration/model/sendPartnerNoteTool.js";
import { GatewayCollaborationBackend } from "../../features/distributed-client/model/gatewayCollaborationBackend.js";
import { GatewayHttpService } from "../../features/distributed-gateway/model/gatewayHttpService.js";
import type { ToolModule } from "../../shared/api/tool-registry/types.js";
import type {
  MaintenanceStore,
  SessionStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramXchangeFileMetaStore,
} from "../../shared/api/storage/contract.js";

export type AppRuntime = {
  config: AppConfig;
  logger: Logger;
  redis: RedisClient;
  telegramTransport: TelegramTransport;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  inboxStore: TelegramInboxStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
  maintenanceStore: MaintenanceStore;
  webAppLaunchRegistry: WebAppLaunchRegistry;
  gatewayHttpService: GatewayHttpService;
  createServer: () => McpServer;
  shutdown: () => Promise<void>;
};

export async function createAppRuntime(): Promise<AppRuntime> {
  const config = loadConfig();
  const logger = createLogger(config);
  const projectIdentityResolver = new ProjectIdentityResolver(config, logger);
  logger.info("Configuration loaded", {
    mode: config.mode,
    redis: {
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db,
    },
    logging: {
      level: config.logging.level,
      filePath: config.logging.filePath,
    },
    mcp: {
      httpHost: config.mcp.httpHost,
      httpPort: config.mcp.httpPort,
      httpPath: config.mcp.httpPath,
      bearerAuthEnabled: Boolean(config.mcp.bearerToken),
      enableDebugRoutes: config.mcp.enableDebugRoutes,
      enablePruneRoute: config.mcp.enablePruneRoute,
    },
    distributed: {
      mode: config.distributed.mode,
      gatewayPublicUrlConfigured: Boolean(config.distributed.gatewayPublicUrl),
      gatewayBindHost: config.distributed.gatewayBindHost,
      gatewayBindPort: config.distributed.gatewayBindPort,
      gatewayAuthEnabled: Boolean(config.distributed.gatewayAuthToken),
      gatewayDatabaseConfigured: Boolean(
        config.distributed.gatewayDatabaseUrl,
      ),
      gatewayS3Configured: Boolean(config.distributed.gatewayS3Bucket),
    },
    webapp: {
      enabled: config.webapp.enabled,
      basePath: config.webapp.basePath,
      publicUrlConfigured: Boolean(config.webapp.publicUrl),
      initDataTtlSeconds: config.webapp.initDataTtlSeconds,
      sessionTtlSeconds: config.webapp.sessionTtlSeconds,
      pollIntervalMs: config.webapp.pollIntervalMs,
      actionCooldownMs: config.webapp.actionCooldownMs,
    },
    tmux: {
      nudgeEnabled: config.tmux.nudgeEnabled,
      nudgeDebounceSeconds: config.tmux.nudgeDebounceSeconds,
      nudgeCooldownSeconds: config.tmux.nudgeCooldownSeconds,
    },
    project: projectIdentityResolver.getIdentity(),
  });

  const redis = await createRedisClient(config);
  logger.info("Redis connected", {
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
  });

  const stateStore = new RedisStateStore(redis);
  const webAppLaunchRegistry = new WebAppLaunchRegistry();
  await stateStore.resetRuntimeState();
  logger.info("Runtime pending state reset");

  const telegramTransport = new TelegramTransport(
    config,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    webAppLaunchRegistry,
    logger,
  );
  await telegramTransport.start();
  logger.info("Telegram transport ready");
  await telegramTransport.recoverPendingInboxNudges();
  logger.info("Startup inbox nudge recovery completed");

  const pairSessionService = new PairSessionService(
    config,
    stateStore,
    stateStore,
    logger,
    projectIdentityResolver,
  );
  const sessionContextService = new SessionContextService(
    stateStore,
    stateStore,
    logger,
    projectIdentityResolver,
  );
  const notifyService = new NotifyService(
    config,
    stateStore,
    stateStore,
    telegramTransport,
    logger,
    projectIdentityResolver,
  );
  const inboxService = new InboxService(
    config,
    stateStore,
    stateStore,
    logger,
    projectIdentityResolver,
  );
  const orchestrator = new HumanApprovalOrchestrator(
    config,
    stateStore,
    stateStore,
    stateStore,
    telegramTransport,
    logger,
    projectIdentityResolver,
  );
  const browserService = new BrowserService(
    config,
    stateStore,
    stateStore,
    stateStore,
    telegramTransport,
    logger,
    projectIdentityResolver,
  );
  const collaborationBackend: CollaborationBackend =
    config.distributed.mode === "client"
      ? new LocalCollaborationBackend(
          config,
          stateStore,
          stateStore,
          stateStore,
          telegramTransport,
          logger,
        )
      : new LocalCollaborationBackend(
          config,
          stateStore,
          stateStore,
          stateStore,
          telegramTransport,
          logger,
        );
  if (config.distributed.mode !== "client") {
    logger.warn("Distributed mode is enabled, but collaboration still uses local backend", {
      mode: config.distributed.mode,
    });
  }
  const collaborationService = new CollaborationService(
    collaborationBackend,
    logger,
    projectIdentityResolver,
  );
  telegramTransport.setCollaborationService(collaborationService);
  const gatewayHttpService = new GatewayHttpService(config);
  if (config.distributed.mode === "gateway" || config.distributed.mode === "both") {
    void new GatewayCollaborationBackend(
      logger,
      config.distributed.gatewayPublicUrl,
    );
  }

  const createTools = (): ToolModule[] => [
    new CreateSessionPairCodeTool(pairSessionService),
    new ClearSessionPairingTool(pairSessionService),
    new SetSessionContextTool(sessionContextService),
    new RenameSessionTool(sessionContextService),
    new SetTmuxTargetTool(sessionContextService),
    new GetTmuxTargetTool(sessionContextService),
    new GetSessionContextTool(sessionContextService),
    new ClearSessionContextTool(sessionContextService),
    new NotifyTelegramTool(notifyService),
    new GetTelegramInboxCountTool(inboxService),
    new GetTelegramInboxTool(inboxService),
    new DeleteTelegramInboxMessageTool(inboxService),
    new AskUserTelegramTool(orchestrator),
    new BrowserOpenTool(browserService),
    new BrowserReloadTool(browserService),
    new BrowserClickTool(browserService),
    new BrowserFillTool(browserService),
    new BrowserPressTool(browserService),
    new BrowserWaitForTool(browserService),
    new BrowserWaitForUrlTool(browserService),
    new BrowserConsoleTool(browserService),
    new BrowserErrorsTool(browserService),
    new BrowserNetworkFailuresTool(browserService),
    new BrowserClearLogsTool(browserService),
    new BrowserDomTool(browserService),
    new BrowserComputedStyleTool(browserService),
    new BrowserScreenshotTool(browserService),
    new BrowserCloseTool(browserService),
    new SendPartnerNoteTool(collaborationService),
  ];

  return {
    config,
    logger,
    redis,
    telegramTransport,
    sessionStore: stateStore,
    bindingStore: stateStore,
    inboxStore: stateStore,
    xchangeFileMetaStore: stateStore,
    maintenanceStore: stateStore,
    webAppLaunchRegistry,
    gatewayHttpService,
    createServer: () => createMcpServer(createTools()),
    shutdown: async () => {
      logger.info("Shutdown started");
      await browserService.shutdown();
      await telegramTransport.stop();
      redis.disconnect();
      logger.info("Shutdown completed");
    },
  };
}
