import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import {
  TerminalBufferService,
  type CaptureTerminalBufferInput,
} from "./src/features/terminal-buffer/model/terminalBufferService";

export const TELEGRAM_MCP_TERMINAL_BUFFER_SERVICE_NAME =
  "telegramMcp.terminalBuffer";

type TerminalBufferServiceCarrier = Service & {
  terminalBufferService?: TerminalBufferService | null;
  getTerminalBufferService?: () => TerminalBufferService;
};

const TelegramMcpTerminalBufferService: ServiceSchema = {
  name: TELEGRAM_MCP_TERMINAL_BUFFER_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    captureBufferRemote: {
      params: { type: "object" },
      async handler(
        this: TerminalBufferServiceCarrier,
        ctx: { params: CaptureTerminalBufferInput },
      ) {
        return this.getTerminalBufferService!().captureBuffer(ctx.params);
      },
    },
  },

  created(this: TerminalBufferServiceCarrier) {
    this.terminalBufferService = null;
  },

  methods: {
    getTerminalBufferService(
      this: TerminalBufferServiceCarrier,
    ): TerminalBufferService {
      if (!this.terminalBufferService) {
        throw new Error(
          "telegram_mcp terminal-buffer service is not initialized yet",
        );
      }

      return this.terminalBufferService;
    },
  },

  async started(this: TerminalBufferServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp terminal-buffer service");
    this.terminalBufferService = new TerminalBufferService(
      runtime.config,
      runtime.sessionStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
    );
    this.logger.info("telegram_mcp terminal-buffer service is ready");
  },
};

export default TelegramMcpTerminalBufferService;
