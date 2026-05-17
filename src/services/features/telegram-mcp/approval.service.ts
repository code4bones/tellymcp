import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { HumanApprovalOrchestrator } from "./src/processes/human-approval/model/orchestrator";

export const TELEGRAM_MCP_APPROVAL_SERVICE_NAME = "telegramMcp.approval";

export type TelegramMcpApprovalServiceInstance = Service & {
  approvalOrchestrator: HumanApprovalOrchestrator | null;
  getApprovalOrchestrator: () => HumanApprovalOrchestrator;
};

type ApprovalServiceCarrier = Service & {
  approvalOrchestrator?: HumanApprovalOrchestrator | null;
  getApprovalOrchestrator?: () => HumanApprovalOrchestrator;
};

const TelegramMcpApprovalService: ServiceSchema = {
  name: TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: ApprovalServiceCarrier) {
    this.approvalOrchestrator = null;
  },

  methods: {
    getApprovalOrchestrator(
      this: ApprovalServiceCarrier,
    ): HumanApprovalOrchestrator {
      if (!this.approvalOrchestrator) {
        throw new Error(
          "telegram_mcp approval service is not initialized yet",
        );
      }

      return this.approvalOrchestrator;
    },
  },

  async started(this: ApprovalServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp approval service");
    this.approvalOrchestrator = new HumanApprovalOrchestrator(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.telegramTransport,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.logger.info("telegram_mcp approval service is ready");
  },
};

export default TelegramMcpApprovalService;
