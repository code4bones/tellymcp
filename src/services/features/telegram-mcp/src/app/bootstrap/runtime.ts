import { loadConfig, type AppConfig } from "../config/env";
import { WebAppLaunchRegistry } from "../webapp/auth";
import {
  createRedisClient,
  type RedisClient,
} from "../providers/redis/client";
import { createLogger, type Logger } from "../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../shared/lib/project-identity/projectIdentity";
import { RedisStateStore } from "../../shared/integrations/redis/stateStore";
import { TelegramTransport } from "../../shared/integrations/telegram/transport";
import { MinioExchangeStore } from "../../shared/integrations/object-storage/minioExchangeStore";
import { GatewayHttpService } from "../../features/distributed-gateway/model/gatewayHttpService";
import type {
  MaintenanceStore,
  SessionStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramXchangeFileMetaStore,
} from "../../shared/api/storage/contract";

export type AppRuntime = {
  config: AppConfig;
  logger: Logger;
  redis: RedisClient;
  stateStore: RedisStateStore;
  telegramTransport: TelegramTransport;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  inboxStore: TelegramInboxStore;
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
  const objectStore = new MinioExchangeStore(
    input.callBroker,
    stateStore,
    config.tmux,
    config.exchange.dir,
    config.mcp.vfsScope,
    logger,
  );
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
    objectStore,
    webAppLaunchRegistry,
    logger,
  );
  await telegramTransport.start();
  logger.info("Telegram transport ready");
  await telegramTransport.recoverPendingInboxNudges();
  logger.info("Startup inbox nudge recovery completed");

  const gatewayHttpService = new GatewayHttpService(config, input.callBroker);

  return {
    config,
    logger,
    redis,
    stateStore,
    telegramTransport,
    sessionStore: stateStore,
    bindingStore: stateStore,
    inboxStore: stateStore,
    xchangeFileMetaStore: stateStore,
    maintenanceStore: stateStore,
    objectStore,
    projectIdentityResolver,
    webAppLaunchRegistry,
    gatewayHttpService,
    shutdown: async () => {
      logger.info("Shutdown started");
      await telegramTransport.stop();
      redis.disconnect();
      logger.info("Shutdown completed");
    },
  };
}
