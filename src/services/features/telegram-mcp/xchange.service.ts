import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { XchangeService } from "./src/features/xchange/model/xchangeService";

export const TELEGRAM_MCP_XCHANGE_SERVICE_NAME = "telegramMcp.xchange";

export type TelegramMcpXchangeServiceInstance = Service & {
  xchangeService: XchangeService | null;
  getXchangeService: () => XchangeService;
};

type XchangeServiceCarrier = Service & {
  xchangeService?: XchangeService | null;
  getXchangeService?: () => XchangeService;
};

const TelegramMcpXchangeService: ServiceSchema = {
  name: TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: XchangeServiceCarrier) {
    this.xchangeService = null;
  },

  methods: {
    getXchangeService(this: XchangeServiceCarrier): XchangeService {
      if (!this.xchangeService) {
        throw new Error("telegram_mcp xchange service is not initialized yet");
      }

      return this.xchangeService;
    },
  },

  async started(this: XchangeServiceCarrier) {
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
    this.logger.info("Starting telegram_mcp xchange service");
    this.xchangeService = new XchangeService(
      runtime.config,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp xchange service is ready");
  },
};

export default TelegramMcpXchangeService;
