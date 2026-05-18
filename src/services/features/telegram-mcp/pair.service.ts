import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { PairSessionService } from "./src/features/pair-session/model/generatePairCode";

export const TELEGRAM_MCP_PAIR_SERVICE_NAME = "telegramMcp.pair";

export type TelegramMcpPairServiceInstance = Service & {
  pairSessionService: PairSessionService | null;
  getPairSessionService: () => PairSessionService;
};

type PairServiceCarrier = Service & {
  pairSessionService?: PairSessionService | null;
  getPairSessionService?: () => PairSessionService;
};

const TelegramMcpPairService: ServiceSchema = {
  name: TELEGRAM_MCP_PAIR_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: PairServiceCarrier) {
    this.pairSessionService = null;
  },

  methods: {
    getPairSessionService(this: PairServiceCarrier): PairSessionService {
      if (!this.pairSessionService) {
        throw new Error("telegram_mcp pair service is not initialized yet");
      }

      return this.pairSessionService;
    },
  },

  async started(this: PairServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp pair service");
    this.pairSessionService = new PairSessionService(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp pair service is ready");
  },
};

export default TelegramMcpPairService;
