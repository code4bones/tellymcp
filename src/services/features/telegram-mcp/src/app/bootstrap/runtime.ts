import { loadConfig, type AppConfig } from "../config/env";
import { WebAppLaunchRegistry } from "../webapp/auth";
import {
  createRedisClient,
  type RedisClient,
} from "../providers/redis/client";
import { createLogger, type Logger } from "../../shared/lib/logger/logger";
import {
  ProjectIdentityResolver,
  readTellySessionRuntimeState,
} from "../../shared/lib/project-identity/projectIdentity";
import { RedisStateStore } from "../../shared/integrations/redis/stateStore";
import { ProcessLocalSessionStore } from "../../shared/integrations/memory/processLocalSessionStore";
import { TelegramTransport } from "../../shared/integrations/telegram/transport";
import { MinioExchangeStore } from "../../shared/integrations/object-storage/minioExchangeStore";
import { GatewayHttpService } from "../../features/distributed-gateway/model/gatewayHttpService";
import { ensureGatewayClientUuid } from "../../features/distributed-client/model/gatewayClientAccess";
import {
  ensureTerminalTargetForSession,
} from "../../shared/integrations/terminal/client";
import { stopAllPtyTargets } from "../../shared/integrations/terminal/ptyRegistry";
import type {
  MaintenanceStore,
  SessionStore,
  SessionBindingStore,
  TelegramAdminAuthStore,
  TelegramUserLocaleStore,
  TelegramXchangeFileMetaStore,
} from "../../shared/api/storage/contract";

export type AppRuntime = {
  callBroker: <T>(
    actionName: string,
    params?: unknown,
    options?: { meta?: Record<string, unknown> },
  ) => Promise<T>;
  config: AppConfig;
  logger: Logger;
  redis: RedisClient;
  stateStore: RedisStateStore;
  telegramTransport: TelegramTransport;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  adminAuthStore: TelegramAdminAuthStore;
  localeStore: TelegramUserLocaleStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
  maintenanceStore: MaintenanceStore;
  objectStore: MinioExchangeStore;
  projectIdentityResolver: ProjectIdentityResolver;
  webAppLaunchRegistry: WebAppLaunchRegistry;
  gatewayHttpService: GatewayHttpService;
  shutdown: () => Promise<void>;
};

export async function createAppRuntime(input: {
  callBroker: <T>(
    actionName: string,
    params?: unknown,
    options?: { meta?: Record<string, unknown> },
  ) => Promise<T>;
}): Promise<AppRuntime> {
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
      gatewayWsUrlConfigured: Boolean(config.distributed.gatewayWsUrl),
      gatewayWsPath: config.distributed.gatewayWsPath,
      gatewayAuthEnabled: Boolean(config.distributed.gatewayAuthToken),
      gatewayDatabaseConfigured: Boolean(
        config.distributed.gatewayDatabaseUrl,
      ),
      gatewayS3Configured: Boolean(config.distributed.gatewayS3Bucket),
      gatewayRmqConfigured: Boolean(config.distributed.rmq?.host),
    },
    webapp: {
      enabled: config.webapp.enabled,
      basePath: config.webapp.basePath,
      publicUrlConfigured: Boolean(config.webapp.publicUrl),
      initDataTtlSeconds: config.webapp.initDataTtlSeconds,
      sessionTtlSeconds: config.webapp.sessionTtlSeconds,
      launchMode: config.webapp.launchMode,
      pollIntervalMs: config.webapp.pollIntervalMs,
      actionCooldownMs: config.webapp.actionCooldownMs,
    },
    terminal: {
      nudgeEnabled: config.terminal.nudgeEnabled,
      nudgeDebounceSeconds: config.terminal.nudgeDebounceSeconds,
      nudgeCooldownSeconds: config.terminal.nudgeCooldownSeconds,
    },
    telegram: {
      webhookEnabled: config.telegram.webhook.enabled,
      webhookPath: config.telegram.webhook.path,
      webhookPublicUrlConfigured: Boolean(config.telegram.webhook.publicUrl),
      webhookTrace: config.telegram.webhook.trace,
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
  let sessionStore: SessionStore = stateStore;
  const webAppLaunchRegistry = new WebAppLaunchRegistry();
  const objectStore = new MinioExchangeStore(
    input.callBroker,
    stateStore,
    config.terminal,
    config.exchange.dir,
    config.mcp.vfsScope,
    logger,
    config.distributed.mode,
    config.distributed.gatewayPublicUrl,
    config.distributed.gatewayAuthToken,
  );

  if (config.distributed.mode === "client") {
    const resolvedSession = projectIdentityResolver.resolveSessionDefaults({
      cwd: process.cwd(),
    });
    const existingSession = await stateStore.getSession(resolvedSession.sessionId);
    const persistedToolsState = readTellySessionRuntimeState(
      resolvedSession.cwd,
      resolvedSession.sessionId,
      logger,
    );
    const terminalTarget = ensureTerminalTargetForSession(config.terminal, {
      sessionId: resolvedSession.sessionId,
      cwd: resolvedSession.cwd,
      ...(typeof existingSession?.terminalTarget === "string"
        ? { target: existingSession.terminalTarget }
        : {}),
    });

    if (!terminalTarget) {
      throw new Error("PTY terminal target could not be created during runtime bootstrap");
    }

    const initialSession = {
      sessionId: resolvedSession.sessionId,
      ...(typeof existingSession?.label === "string"
        ? { label: existingSession.label }
        : { label: resolvedSession.sessionLabel }),
      ...(typeof existingSession?.cwd === "string"
        ? { cwd: existingSession.cwd }
        : { cwd: resolvedSession.cwd }),
      ...(typeof existingSession?.activeProjectUuid === "string"
        ? { activeProjectUuid: existingSession.activeProjectUuid }
        : {}),
      ...(typeof existingSession?.activeProjectName === "string"
        ? { activeProjectName: existingSession.activeProjectName }
        : {}),
      ...(typeof existingSession?.task === "string"
        ? { task: existingSession.task }
        : {}),
      ...(typeof existingSession?.summary === "string"
        ? { summary: existingSession.summary }
        : {}),
      ...(Array.isArray(existingSession?.files)
        ? { files: existingSession.files }
        : {}),
      ...(Array.isArray(existingSession?.decisions)
        ? { decisions: existingSession.decisions }
        : {}),
      ...(Array.isArray(existingSession?.risks)
        ? { risks: existingSession.risks }
        : {}),
      terminalTarget: terminalTarget,
      ...(typeof existingSession?.lastTerminalNudgeAt === "string"
        ? { lastTerminalNudgeAt: existingSession.lastTerminalNudgeAt }
        : {}),
      ...(typeof existingSession?.lastSeenToolsHash === "string"
        ? { lastSeenToolsHash: existingSession.lastSeenToolsHash }
        : typeof persistedToolsState?.lastSeenToolsHash === "string"
          ? { lastSeenToolsHash: persistedToolsState.lastSeenToolsHash }
        : {}),
      ...(typeof existingSession?.lastNotifiedToolsHash === "string"
        ? { lastNotifiedToolsHash: existingSession.lastNotifiedToolsHash }
        : typeof persistedToolsState?.lastNotifiedToolsHash === "string"
          ? { lastNotifiedToolsHash: persistedToolsState.lastNotifiedToolsHash }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    sessionStore = new ProcessLocalSessionStore({
      initialSessions: [initialSession],
      onClearSession: async (sessionId) => {
        await stateStore.clearSession(sessionId);
      },
    });

    logger.info("Client PTY process-local session store initialized", {
      sessionId: resolvedSession.sessionId,
      terminalTarget,
    });
  }
  await stateStore.resetRuntimeState();
  logger.info("Runtime pending state reset");

  if (config.distributed.mode === "client" && config.distributed.gatewayPublicUrl) {
    const clientUuid = await ensureGatewayClientUuid({
      maintenanceStore: stateStore,
      gatewayPublicUrl: config.distributed.gatewayPublicUrl,
      ...(config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: config.distributed.gatewayAuthToken }
        : {}),
      ...(config.project.name ? { projectName: config.project.name } : {}),
      ...(config.telegram.botUsername ? { botUsername: config.telegram.botUsername } : {}),
      ...(config.distributed.gatewayToken
        ? { gatewayToken: config.distributed.gatewayToken }
        : {}),
      ...(config.distributed.gatewayUserUuid
        ? { gatewayUserUuid: config.distributed.gatewayUserUuid }
        : {}),
      ...(process.env.NAMESPACE?.trim()
        ? { namespace: process.env.NAMESPACE.trim() }
        : {}),
      ...(process.env.NODE_ID?.trim() ? { nodeId: process.env.NODE_ID.trim() } : {}),
    });
    logger.info("Gateway client identity ensured", {
      clientUuid,
      gatewayPublicUrl: config.distributed.gatewayPublicUrl,
    });
  }

  const sessions = await sessionStore.listSessions();
  let recoveredCount = 0;
  for (const session of sessions) {
    if (!session.terminalTarget?.startsWith("pty:")) {
      continue;
    }

    ensureTerminalTargetForSession(config.terminal, {
      sessionId: session.sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      target: session.terminalTarget,
    });
    recoveredCount += 1;
  }
  logger.info("PTY terminal sessions recovered", { recoveredCount });

  const telegramTransport = new TelegramTransport(
    config,
    sessionStore,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    objectStore,
    webAppLaunchRegistry,
    logger,
  );
  await telegramTransport.start();
  logger.info("Telegram transport ready");
  await telegramTransport.sendStartupNotifications();
  logger.info("Startup Telegram notifications completed");

  const gatewayHttpService = new GatewayHttpService(config, input.callBroker);

  return {
    callBroker: input.callBroker,
    config,
    logger,
    redis,
    stateStore,
    telegramTransport,
    sessionStore,
    bindingStore: stateStore,
    adminAuthStore: stateStore,
    localeStore: stateStore,
    xchangeFileMetaStore: stateStore,
    maintenanceStore: stateStore,
    objectStore,
    projectIdentityResolver,
    webAppLaunchRegistry,
    gatewayHttpService,
    shutdown: async () => {
      logger.info("Shutdown started");
      await telegramTransport.stop();
      stopAllPtyTargets();
      redis.disconnect();
      logger.info("Shutdown completed");
    },
  };
}
