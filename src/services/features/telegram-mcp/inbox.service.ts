import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import type {
  DeleteTelegramInboxMessageInput,
  GetTelegramInboxCountInput,
  GetTelegramInboxInput,
} from "./src/entities/inbox/model/types";
import { InboxService } from "./src/features/inbox/model/inboxService";

export const TELEGRAM_MCP_INBOX_SERVICE_NAME = "telegramMcp.inbox";

export type TelegramMcpInboxServiceInstance = Service & {
  inboxService: InboxService | null;
  getInboxService: () => InboxService;
};

type InboxServiceCarrier = Service & {
  inboxService?: InboxService | null;
  getInboxService?: () => InboxService;
};

const TelegramMcpInboxService: ServiceSchema = {
  name: TELEGRAM_MCP_INBOX_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    getInboxCountRemote: {
      params: { type: "object" },
      async handler(
        this: InboxServiceCarrier,
        ctx: { params: GetTelegramInboxCountInput },
      ) {
        return this.getInboxService!().getInboxCount(ctx.params);
      },
    },
    getInboxRemote: {
      params: { type: "object" },
      async handler(
        this: InboxServiceCarrier,
        ctx: { params: GetTelegramInboxInput },
      ) {
        return this.getInboxService!().getInbox(ctx.params);
      },
    },
    deleteInboxMessageRemote: {
      params: { type: "object" },
      async handler(
        this: InboxServiceCarrier,
        ctx: { params: DeleteTelegramInboxMessageInput },
      ) {
        return this.getInboxService!().deleteInboxMessage(ctx.params);
      },
    },
  },

  created(this: InboxServiceCarrier) {
    this.inboxService = null;
  },

  methods: {
    getInboxService(this: InboxServiceCarrier): InboxService {
      if (!this.inboxService) {
        throw new Error("telegram_mcp inbox service is not initialized yet");
      }

      return this.inboxService;
    },
  },

  async started(this: InboxServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp inbox service");
    this.inboxService = new InboxService(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
    );
    this.logger.info("telegram_mcp inbox service is ready");
  },
};

export default TelegramMcpInboxService;
