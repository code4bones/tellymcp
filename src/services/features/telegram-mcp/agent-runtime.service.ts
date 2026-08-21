import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
  type TelegramMcpApprovalServiceInstance,
} from "./approval.service";
import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
  type TelegramMcpNotifyServiceInstance,
} from "./notify.service";
import {
  AgentRuntimeService,
  type AttachAgentRuntimeInput,
  type ListAgentRuntimeInput,
  type StartAgentRuntimeInput,
  type StopAgentTurnInput,
  type SubmitAgentMessageInput,
} from "./src/features/agent-runtime/model/agentRuntimeService";

export const TELEGRAM_MCP_AGENT_RUNTIME_SERVICE_NAME =
  "telegramMcp.agentRuntime";

type AgentRuntimeServiceCarrier = Service & {
  agentRuntimeService?: AgentRuntimeService | null;
  getAgentRuntimeService?: () => AgentRuntimeService;
};

const TelegramMcpAgentRuntimeService: ServiceSchema = {
  name: TELEGRAM_MCP_AGENT_RUNTIME_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
    TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
  ],

  actions: {
    listRemote: {
      params: { session_id: "string" },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: ListAgentRuntimeInput },
      ) {
        return this.getAgentRuntimeService!().listAgents(ctx.params);
      },
    },
    startRemote: {
      params: {
        session_id: "string",
        agent_id: "string",
      },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: StartAgentRuntimeInput },
      ) {
        return this.getAgentRuntimeService!().startAgent(ctx.params);
      },
    },
    attachRemote: {
      params: {
        session_id: "string",
        agent_id: "string",
      },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: AttachAgentRuntimeInput },
      ) {
        return this.getAgentRuntimeService!().attachAgent(ctx.params);
      },
    },
    submitRemote: {
      params: {
        session_id: "string",
        message: "string",
        agent_id: { type: "string", optional: true },
      },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: SubmitAgentMessageInput },
      ) {
        return this.getAgentRuntimeService!().submitMessage(ctx.params);
      },
    },
    stopRemote: {
      params: { session_id: "string" },
      async handler(
        this: AgentRuntimeServiceCarrier,
        ctx: { params: StopAgentTurnInput },
      ) {
        return this.getAgentRuntimeService!().stopTurn(ctx.params);
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
    const notifyService = this.broker.getLocalService(
      TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
    ) as TelegramMcpNotifyServiceInstance | null;
    if (!notifyService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_NOTIFY_SERVICE_NAME}' is unavailable`,
      );
    }
    const approvalService = this.broker.getLocalService(
      TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
    ) as TelegramMcpApprovalServiceInstance | null;
    if (!approvalService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_APPROVAL_SERVICE_NAME}' is unavailable`,
      );
    }
    this.agentRuntimeService = new AgentRuntimeService(
      runtime.config,
      runtime.sessionStore,
      runtime.logger,
      {
        requestApproval: async ({ sessionId, request }) => {
          const details = [
            `Thread: ${request.threadId}`,
            `Turn: ${request.turnId}`,
            ...(request.reason ? [`Reason: ${request.reason}`] : []),
            ...(request.command ? [`Command: ${request.command}`] : []),
            ...(request.cwd ? [`Working directory: ${request.cwd}`] : []),
            ...(request.grantRoot
              ? [`Requested file root: ${request.grantRoot}`]
              : []),
            ...(request.networkHost
              ? [
                  `Network destination: ${request.networkProtocol ? `${request.networkProtocol}://` : ""}${request.networkHost}`,
                ]
              : []),
          ]
            .join("\n")
            .slice(0, 3_000);
          const result = await approvalService
            .getApprovalOrchestrator()
            .submit({
              session_id: sessionId,
              question:
                request.kind === "command"
                  ? "Codex requests permission to run this command."
                  : "Codex requests permission to apply file changes.",
              task: "Codex approval",
              context: details,
              ...(request.grantRoot
                ? { affected_files: [request.grantRoot] }
                : {}),
              options: ["✅ Разрешить / Approve", "❌ Отклонить / Deny"],
              recommended_option: "❌ Отклонить / Deny",
              risk_level: request.kind === "command" ? "high" : "medium",
              fallback_if_timeout: "❌ Отклонить / Deny",
              use_saved_context: false,
            });
          const answer = result.answer?.trim().toLocaleLowerCase() ?? "";
          return answer.includes("разрешить") || answer.includes("approve")
            ? "accept"
            : "decline";
        },
        notifyTelegram: async ({ sessionId, message }) => {
          await notifyService.getNotifyService().send({
            session_id: sessionId,
            message,
          });
        },
      },
    );
    this.logger.info("telegram_mcp agent-runtime service is ready");
  },

  stopped(this: AgentRuntimeServiceCarrier) {
    this.agentRuntimeService?.stopTracking();
    this.agentRuntimeService = null;
  },
};

export default TelegramMcpAgentRuntimeService;
