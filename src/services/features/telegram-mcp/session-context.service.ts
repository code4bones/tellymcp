import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { SessionContextService } from "./src/features/session-context/model/sessionContextService";

export const TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME =
  "telegramMcp.sessionContext";

export type TelegramMcpSessionContextServiceInstance = Service & {
  sessionContextService: SessionContextService | null;
  getSessionContextService: () => SessionContextService;
};

type SessionContextServiceCarrier = Service & {
  sessionContextService?: SessionContextService | null;
  getSessionContextService?: () => SessionContextService;
};

const TelegramMcpSessionContextService: ServiceSchema = {
  name: TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: SessionContextServiceCarrier) {
    this.sessionContextService = null;
  },

  methods: {
    getSessionContextService(
      this: SessionContextServiceCarrier,
    ): SessionContextService {
      if (!this.sessionContextService) {
        throw new Error(
          "telegram_mcp session-context service is not initialized yet",
        );
      }

      return this.sessionContextService;
    },
  },

  async started(this: SessionContextServiceCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = await runtimeService.waitUntilReady();

    this.logger.info("Starting telegram_mcp session-context service");
    this.sessionContextService = new SessionContextService(
      runtime.stateStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp session-context service is ready");
  },
};

export default TelegramMcpSessionContextService;
