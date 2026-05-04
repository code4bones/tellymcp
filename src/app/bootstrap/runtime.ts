import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig, type AppConfig } from "../config/env.js";
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
import { GetHumanChannelModeTool } from "../../features/session-context/model/getHumanChannelModeTool.js";
import { GetTmuxTargetTool } from "../../features/session-context/model/getTmuxTargetTool.js";
import { ClearSessionContextTool } from "../../features/session-context/model/clearSessionContextTool.js";
import { SetHumanChannelModeTool } from "../../features/session-context/model/setHumanChannelModeTool.js";
import { SetTmuxTargetTool } from "../../features/session-context/model/setTmuxTargetTool.js";
import type { ToolModule } from "../../shared/api/tool-registry/types.js";

export type AppRuntime = {
  config: AppConfig;
  logger: Logger;
  redis: RedisClient;
  telegramTransport: TelegramTransport;
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
  await stateStore.resetRuntimeState();
  logger.info("Runtime pending state reset");

  const telegramTransport = new TelegramTransport(
    config,
    stateStore,
    stateStore,
    stateStore,
    stateStore,
    logger,
  );
  await telegramTransport.start();
  logger.info("Telegram transport ready");

  const pairSessionService = new PairSessionService(
    config,
    stateStore,
    stateStore,
    logger,
    projectIdentityResolver,
  );
  const sessionContextService = new SessionContextService(
    config,
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

  const createTools = (): ToolModule[] => [
    new CreateSessionPairCodeTool(pairSessionService),
    new ClearSessionPairingTool(pairSessionService),
    new SetSessionContextTool(sessionContextService),
    new SetHumanChannelModeTool(sessionContextService),
    new GetHumanChannelModeTool(sessionContextService),
    new SetTmuxTargetTool(sessionContextService),
    new GetTmuxTargetTool(sessionContextService),
    new GetSessionContextTool(sessionContextService),
    new ClearSessionContextTool(sessionContextService),
    new NotifyTelegramTool(notifyService),
    new GetTelegramInboxCountTool(inboxService),
    new GetTelegramInboxTool(inboxService),
    new DeleteTelegramInboxMessageTool(inboxService),
    new AskUserTelegramTool(orchestrator),
  ];

  return {
    config,
    logger,
    redis,
    telegramTransport,
    createServer: () => createMcpServer(createTools()),
    shutdown: async () => {
      logger.info("Shutdown started");
      await telegramTransport.stop();
      redis.disconnect();
      logger.info("Shutdown completed");
    },
  };
}
