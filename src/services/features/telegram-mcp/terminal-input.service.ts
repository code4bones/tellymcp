import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  TerminalInputService,
  type SubmitHumanTerminalMessageInput,
} from "./src/features/terminal-input/model/terminalInputService";

export const TELEGRAM_MCP_TERMINAL_INPUT_SERVICE_NAME =
  "telegramMcp.terminalInput";

export type TelegramMcpTerminalInputServiceInstance = Service & {
  terminalInputService: TerminalInputService | null;
  getTerminalInputService: () => TerminalInputService;
};

type TerminalInputServiceCarrier = Service & {
  terminalInputService?: TerminalInputService | null;
  getTerminalInputService?: () => TerminalInputService;
};

const TelegramMcpTerminalInputService: ServiceSchema = {
  name: TELEGRAM_MCP_TERMINAL_INPUT_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    submitHumanMessageRemote: {
      params: { type: "object" },
      async handler(
        this: TerminalInputServiceCarrier,
        ctx: { params: SubmitHumanTerminalMessageInput },
      ) {
        return this.getTerminalInputService!().submitHumanMessage(ctx.params);
      },
    },
  },

  created(this: TerminalInputServiceCarrier) {
    this.terminalInputService = null;
  },

  methods: {
    getTerminalInputService(
      this: TerminalInputServiceCarrier,
    ): TerminalInputService {
      if (!this.terminalInputService) {
        throw new Error("telegram_mcp terminal-input service is not initialized yet");
      }

      return this.terminalInputService;
    },
  },

  async started(this: TerminalInputServiceCarrier) {
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
    this.logger.info("Starting telegram_mcp terminal-input service");
    this.terminalInputService = new TerminalInputService(
      runtime.config,
      runtime.sessionStore,
      runtime.logger,
    );
    this.logger.info("telegram_mcp terminal-input service is ready");
  },
};

export default TelegramMcpTerminalInputService;
