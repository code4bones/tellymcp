import type { Service, ServiceSchema } from "moleculer";

import {
  createAppRuntime,
  type AppRuntime,
} from "./src/app/bootstrap/runtime";

export const TELEGRAM_MCP_RUNTIME_SERVICE_NAME = "telegramMcp.runtime";

export type TelegramMcpRuntimeServiceInstance = Service & {
  runtime: AppRuntime | null;
  getRuntime: () => AppRuntime;
};

type RuntimeCarrier = Service & {
  runtime?: AppRuntime | null;
  getRuntime?: () => AppRuntime;
};

const TelegramMcpRuntimeService: ServiceSchema = {
  name: TELEGRAM_MCP_RUNTIME_SERVICE_NAME,

  created(this: RuntimeCarrier) {
    this.runtime = null;
  },

  methods: {
    getRuntime(this: RuntimeCarrier): AppRuntime {
      if (!this.runtime) {
        throw new Error("telegram_mcp runtime is not initialized yet");
      }

      return this.runtime;
    },
  },

  async started(this: RuntimeCarrier) {
    this.logger.info("Starting telegram_mcp runtime service");
    this.runtime = await createAppRuntime();
    this.logger.info("telegram_mcp runtime service is ready");
  },

  async stopped(this: RuntimeCarrier) {
    if (!this.runtime) {
      return;
    }

    const runtime = this.runtime;
    this.runtime = null;
    this.logger.info("Stopping telegram_mcp runtime service");
    await runtime.shutdown();
  },
};

export default TelegramMcpRuntimeService;
