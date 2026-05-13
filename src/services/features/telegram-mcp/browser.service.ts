import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { BrowserService } from "./src/features/browser/model/browserService";

export const TELEGRAM_MCP_BROWSER_SERVICE_NAME = "telegramMcp.browser";

export type TelegramMcpBrowserServiceInstance = Service & {
  browserService: BrowserService | null;
  getBrowserService: () => BrowserService;
};

type BrowserServiceCarrier = Service & {
  browserService?: BrowserService | null;
  getBrowserService?: () => BrowserService;
};

const TelegramMcpBrowserService: ServiceSchema = {
  name: TELEGRAM_MCP_BROWSER_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: BrowserServiceCarrier) {
    this.browserService = null;
  },

  methods: {
    getBrowserService(this: BrowserServiceCarrier): BrowserService {
      if (!this.browserService) {
        throw new Error("telegram_mcp browser service is not initialized yet");
      }

      return this.browserService;
    },
  },

  async started(this: BrowserServiceCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = runtimeService.getRuntime();

    this.logger.info("Starting telegram_mcp browser service");
    this.browserService = new BrowserService(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.telegramTransport,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp browser service is ready");
  },

  async stopped(this: BrowserServiceCarrier) {
    if (!this.browserService) {
      return;
    }

    const browserService = this.browserService;
    this.browserService = null;
    this.logger.info("Stopping telegram_mcp browser service");
    await browserService.shutdown();
  },
};

export default TelegramMcpBrowserService;
