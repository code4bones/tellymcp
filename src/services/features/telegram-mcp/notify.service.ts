import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { NotifyService } from "./src/features/notify/model/notifyService";

export const TELEGRAM_MCP_NOTIFY_SERVICE_NAME = "telegramMcp.notify";

export type TelegramMcpNotifyServiceInstance = Service & {
  notifyService: NotifyService | null;
  getNotifyService: () => NotifyService;
};

type NotifyServiceCarrier = Service & {
  notifyService?: NotifyService | null;
  getNotifyService?: () => NotifyService;
};

const TelegramMcpNotifyService: ServiceSchema = {
  name: TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: NotifyServiceCarrier) {
    this.notifyService = null;
  },

  methods: {
    getNotifyService(this: NotifyServiceCarrier): NotifyService {
      if (!this.notifyService) {
        throw new Error("telegram_mcp notify service is not initialized yet");
      }

      return this.notifyService;
    },
  },

  async started(this: NotifyServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp notify service");
    this.notifyService = new NotifyService(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.telegramTransport,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp notify service is ready");
  },
};

export default TelegramMcpNotifyService;
