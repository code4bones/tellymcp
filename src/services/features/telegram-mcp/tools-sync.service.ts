import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import type { RefreshToolsMarkdownInput } from "./src/entities/request/model/types";
import { RefreshToolsMarkdownService } from "./src/features/tools-sync/model/refreshToolsMarkdownService";

export const TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME = "telegramMcp.toolsSync";

export type TelegramMcpToolsSyncServiceInstance = Service & {
  refreshToolsMarkdownService: RefreshToolsMarkdownService | null;
  getRefreshToolsMarkdownService: () => RefreshToolsMarkdownService;
};

type ToolsSyncServiceCarrier = Service & {
  refreshToolsMarkdownService?: RefreshToolsMarkdownService | null;
  getRefreshToolsMarkdownService?: () => RefreshToolsMarkdownService;
};

const TelegramMcpToolsSyncService: ServiceSchema = {
  name: TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    refreshToolsMarkdownRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, empty: false },
        cwd: { type: "string", optional: true, empty: false },
        known_hash: { type: "string", optional: true, empty: false },
      },
      async handler(
        this: ToolsSyncServiceCarrier,
        ctx: { params: RefreshToolsMarkdownInput },
      ) {
        return this.getRefreshToolsMarkdownService!().refresh(ctx.params);
      },
    },
  },

  created(this: ToolsSyncServiceCarrier) {
    this.refreshToolsMarkdownService = null;
  },

  methods: {
    getRefreshToolsMarkdownService(
      this: ToolsSyncServiceCarrier,
    ): RefreshToolsMarkdownService {
      if (!this.refreshToolsMarkdownService) {
        throw new Error("telegram_mcp tools sync service is not initialized yet");
      }

      return this.refreshToolsMarkdownService;
    },
  },

  async started(this: ToolsSyncServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp tools sync service");
    this.refreshToolsMarkdownService = new RefreshToolsMarkdownService(
      runtime.config,
      runtime.sessionStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
    );
    this.logger.info("telegram_mcp tools sync service is ready");
  },
};

export default TelegramMcpToolsSyncService;
