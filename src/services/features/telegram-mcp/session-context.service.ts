import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import { SessionContextService } from "./src/features/session-context/model/sessionContextService";
import type {
  ClearSessionContextInput,
  GetRuntimeDiagnosticsInput,
  GetSessionContextInput,
  RenameSessionInput,
  SetSessionContextInput,
} from "./src/entities/session/model/types";
import {
  TELLYMCP_PROTOCOL_VERSION,
  getTellyMcpPackageVersion,
} from "./src/shared/lib/version/versionHandshake";

export const TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME =
  "telegramMcp.sessionContext";

export type TelegramMcpSessionContextServiceInstance = Service & {
  sessionContextService: SessionContextService | null;
  getSessionContextService: () => SessionContextService;
};

type SessionContextServiceCarrier = Service & {
  sessionContextService?: SessionContextService | null;
  getSessionContextService?: () => SessionContextService;
};

const TelegramMcpSessionContextService: ServiceSchema = {
  name: TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    getContextRemote: {
      params: { $$strict: false },
      async handler(
        this: SessionContextServiceCarrier,
        ctx: { params: GetSessionContextInput },
      ) {
        return this.getSessionContextService!().getContext(ctx.params);
      },
    },
    getRuntimeDiagnosticsRemote: {
      params: { $$strict: false },
      async handler(
        this: SessionContextServiceCarrier,
        ctx: { params: GetRuntimeDiagnosticsInput },
      ) {
        return this.getSessionContextService!().getRuntimeDiagnostics(
          ctx.params,
        );
      },
    },
    setContextRemote: {
      params: { $$strict: false },
      async handler(
        this: SessionContextServiceCarrier,
        ctx: { params: SetSessionContextInput },
      ) {
        return this.getSessionContextService!().setContext(ctx.params);
      },
    },
    renameSessionRemote: {
      params: { $$strict: false },
      async handler(
        this: SessionContextServiceCarrier,
        ctx: { params: RenameSessionInput },
      ) {
        return this.getSessionContextService!().renameSession(ctx.params);
      },
    },
    clearContextRemote: {
      params: { $$strict: false },
      async handler(
        this: SessionContextServiceCarrier,
        ctx: { params: ClearSessionContextInput },
      ) {
        return this.getSessionContextService!().clearContext(ctx.params);
      },
    },
  },

  created(this: SessionContextServiceCarrier) {
    this.sessionContextService = null;
  },

  methods: {
    getSessionContextService(
      this: SessionContextServiceCarrier,
    ): SessionContextService {
      if (!this.sessionContextService) {
        throw new Error(
          "telegram_mcp session-context service is not initialized yet",
        );
      }

      return this.sessionContextService;
    },
  },

  async started(this: SessionContextServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp session-context service");
    this.sessionContextService = new SessionContextService(
      runtime.sessionStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      runtime.config.distributed.mode === "client"
        ? undefined
        : new RemoteConsoleActionClient((actionName, params) =>
            this.broker.call(actionName, params, {
              meta: { internal_call: true },
            }),
          ),
      {
        mode: runtime.config.distributed.mode,
        packageVersion: getTellyMcpPackageVersion(__dirname),
        protocolVersion: TELLYMCP_PROTOCOL_VERSION,
        ...(process.env.NODE_ID?.trim()
          ? { nodeId: process.env.NODE_ID.trim() }
          : {}),
        gatewayWsUrlConfigured: Boolean(
          runtime.config.distributed.gatewayWsUrl,
        ),
        gatewayAuthConfigured: Boolean(
          runtime.config.distributed.gatewayAuthToken ||
          runtime.config.distributed.gatewayScopeToken,
        ),
        ...(runtime.redis
          ? { pingRedis: async () => await runtime.redis!.ping() }
          : {}),
      },
    );
    this.logger.info("telegram_mcp session-context service is ready");
  },
};

export default TelegramMcpSessionContextService;
