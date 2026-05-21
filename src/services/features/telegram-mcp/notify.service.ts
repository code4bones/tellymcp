import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import { NotifyService } from "./src/features/notify/model/notifyService";
import type { RiskLevel } from "./src/shared/types/common";

export const TELEGRAM_MCP_NOTIFY_SERVICE_NAME = "telegramMcp.notify";

export type TelegramMcpNotifyServiceInstance = Service & {
  notifyService: NotifyService | null;
  getNotifyService: () => NotifyService;
};

type NotifyServiceCarrier = Service & {
  notifyService?: NotifyService | null;
  getNotifyService?: () => NotifyService;
};

const TelegramMcpNotifyService: ServiceSchema = {
  name: TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    sendForGatewaySession: {
      params: {
        client_uuid: "string",
        local_session_id: "string",
        message: "string",
        session_label: { type: "string", optional: true },
        task: { type: "string", optional: true },
        context: { type: "string", optional: true },
        risk_level: { type: "string", optional: true },
      },
      async handler(this: NotifyServiceCarrier, ctx) {
        const service = this.getNotifyService!();
        return service.sendForGatewayBoundSession({
          clientUuid: String(ctx.params.client_uuid),
          localSessionId: String(ctx.params.local_session_id),
          message: String(ctx.params.message),
          ...(typeof ctx.params.session_label === "string"
            ? { sessionLabel: ctx.params.session_label }
            : {}),
          ...(typeof ctx.params.task === "string" ? { task: ctx.params.task } : {}),
          ...(typeof ctx.params.context === "string"
            ? { context: ctx.params.context }
            : {}),
          ...(typeof ctx.params.risk_level === "string"
            ? { riskLevel: ctx.params.risk_level as RiskLevel }
            : {}),
        });
      },
    },
    sendRequestForGatewaySession: {
      params: {
        client_uuid: "string",
        local_session_id: "string",
        request_id: "string",
        telegram_chat_id: "number",
        telegram_user_id: "number",
        question: "string",
        session_label: { type: "string", optional: true },
        task: { type: "string", optional: true },
        context: { type: "string", optional: true },
        affected_files: { type: "array", optional: true, items: "string" },
        options: { type: "array", optional: true, items: "string" },
        recommended_option: { type: "string", optional: true },
        risk_level: { type: "string", optional: true },
        fallback_if_timeout: { type: "string", optional: true },
      },
      async handler(this: NotifyServiceCarrier, ctx) {
        const service = this.getNotifyService!();
        return service.sendRequestForGatewayBoundSession({
          clientUuid: String(ctx.params.client_uuid),
          localSessionId: String(ctx.params.local_session_id),
          requestId: String(ctx.params.request_id),
          telegramChatId: Number(ctx.params.telegram_chat_id),
          telegramUserId: Number(ctx.params.telegram_user_id),
          question: String(ctx.params.question),
          ...(typeof ctx.params.session_label === "string"
            ? { sessionLabel: ctx.params.session_label }
            : {}),
          ...(typeof ctx.params.task === "string" ? { task: ctx.params.task } : {}),
          ...(typeof ctx.params.context === "string"
            ? { context: ctx.params.context }
            : {}),
          ...(Array.isArray(ctx.params.affected_files)
            ? { affectedFiles: ctx.params.affected_files as string[] }
            : {}),
          ...(Array.isArray(ctx.params.options)
            ? { options: ctx.params.options as string[] }
            : {}),
          ...(typeof ctx.params.recommended_option === "string"
            ? { recommendedOption: ctx.params.recommended_option }
            : {}),
          ...(typeof ctx.params.risk_level === "string"
            ? { riskLevel: ctx.params.risk_level as RiskLevel }
            : {}),
          ...(typeof ctx.params.fallback_if_timeout === "string"
            ? { fallbackIfTimeout: ctx.params.fallback_if_timeout }
            : {}),
        });
      },
    },
  },

  created(this: NotifyServiceCarrier) {
    this.notifyService = null;
  },

  methods: {
    getNotifyService(this: NotifyServiceCarrier): NotifyService {
      if (!this.notifyService) {
        throw new Error("telegram_mcp notify service is not initialized yet");
      }

      return this.notifyService;
    },
  },

  async started(this: NotifyServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp notify service");
    this.notifyService = new NotifyService(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.telegramTransport,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
    );
    this.logger.info("telegram_mcp notify service is ready");
  },
};

export default TelegramMcpNotifyService;
