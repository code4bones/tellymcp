import type { Service, ServiceSchema } from "moleculer";

import {
  createAppRuntime,
  type AppRuntime,
} from "./src/app/bootstrap/runtime";
import {
  TELLYMCP_PROTOCOL_VERSION,
  getTellyMcpPackageVersion,
} from "./src/shared/lib/version/versionHandshake";

export const TELEGRAM_MCP_RUNTIME_SERVICE_NAME = "telegramMcp.runtime";

export type TelegramMcpRuntimeServiceInstance = Service & {
  runtime: AppRuntime | null;
  getRuntime: () => AppRuntime;
  waitUntilReady: () => Promise<AppRuntime>;
};

type RuntimeCarrier = Service & {
  runtime?: AppRuntime | null;
  getRuntime?: () => AppRuntime;
  waitUntilReady?: () => Promise<AppRuntime>;
  readyPromise?: Promise<AppRuntime>;
  resolveReady?: (runtime: AppRuntime) => void;
  rejectReady?: (error: unknown) => void;
};

const TelegramMcpRuntimeService: ServiceSchema = {
  name: TELEGRAM_MCP_RUNTIME_SERVICE_NAME,

  created(this: RuntimeCarrier) {
    this.runtime = null;
    this.readyPromise = new Promise<AppRuntime>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  },

  methods: {
    getRuntime(this: RuntimeCarrier): AppRuntime {
      if (!this.runtime) {
        throw new Error("telegram_mcp runtime is not initialized yet");
      }

      return this.runtime;
    },
    waitUntilReady(this: RuntimeCarrier): Promise<AppRuntime> {
      if (this.runtime) {
        return Promise.resolve(this.runtime);
      }

      if (!this.readyPromise) {
        return Promise.reject(
          new Error("telegram_mcp runtime readiness promise is unavailable"),
        );
      }

      return this.readyPromise;
    },
  },

  async started(this: RuntimeCarrier) {
    this.logger.info("Starting telegram_mcp runtime service", {
      packageVersion: getTellyMcpPackageVersion(__dirname),
      protocolVersion: TELLYMCP_PROTOCOL_VERSION,
    });
    try {
      this.runtime = await createAppRuntime({
        callBroker: (actionName, params, options) =>
          this.broker.call(actionName, params, options),
      });
      this.resolveReady?.(this.runtime);
      this.logger.info("telegram_mcp runtime service is ready", {
        packageVersion: getTellyMcpPackageVersion(__dirname),
        protocolVersion: TELLYMCP_PROTOCOL_VERSION,
      });
    } catch (error) {
      this.rejectReady?.(error);
      throw error;
    }
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
