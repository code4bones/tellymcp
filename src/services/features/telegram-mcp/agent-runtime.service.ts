import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  AgentRuntimeService,
  type ListAgentRuntimeInput,
  type StartAgentRuntimeInput,
} from "./src/features/agent-runtime/model/agentRuntimeService";

export const TELEGRAM_MCP_AGENT_RUNTIME_SERVICE_NAME =
  "telegramMcp.agentRuntime";

type AgentRuntimeServiceCarrier = Service & {
  agentRuntimeService?: AgentRuntimeService | null;
  getAgentRuntimeService?: () => AgentRuntimeService;
};

const TelegramMcpAgentRuntimeService: ServiceSchema = {
  name: TELEGRAM_MCP_AGENT_RUNTIME_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    listRemote: {
      params: { type: "object" },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: ListAgentRuntimeInput },
      ) {
        return this.getAgentRuntimeService!().listAgents(ctx.params);
      },
    },
    startRemote: {
      params: { type: "object" },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: StartAgentRuntimeInput },
      ) {
        return this.getAgentRuntimeService!().startAgent(ctx.params);
      },
    },
  },

  created(this: AgentRuntimeServiceCarrier) {
    this.agentRuntimeService = null;
  },

  methods: {
    getAgentRuntimeService(
      this: AgentRuntimeServiceCarrier,
    ): AgentRuntimeService {
      if (!this.agentRuntimeService) {
        throw new Error(
          "telegram_mcp agent-runtime service is not initialized yet",
        );
      }
      return this.agentRuntimeService;
    },
  },

  async started(this: AgentRuntimeServiceCarrier) {
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
    this.agentRuntimeService = new AgentRuntimeService(
      runtime.config,
      runtime.sessionStore,
      runtime.logger,
    );
    this.logger.info("telegram_mcp agent-runtime service is ready");
  },

  stopped(this: AgentRuntimeServiceCarrier) {
    this.agentRuntimeService?.stopTracking();
    this.agentRuntimeService = null;
  },
};

export default TelegramMcpAgentRuntimeService;
