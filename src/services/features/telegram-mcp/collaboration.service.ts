import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { CollaborationService } from "./src/features/collaboration/model/collaborationService";
import { GatewayCollaborationBackend } from "./src/features/distributed-client/model/gatewayCollaborationBackend";
import { LocalCollaborationBackend } from "./src/features/collaboration/model/localCollaborationBackend";

export const TELEGRAM_MCP_COLLABORATION_SERVICE_NAME =
  "telegramMcp.collaboration";

export type TelegramMcpCollaborationServiceInstance = Service & {
  collaborationService: CollaborationService | null;
  getCollaborationService: () => CollaborationService;
};

type CollaborationServiceCarrier = Service & {
  collaborationService?: CollaborationService | null;
  getCollaborationService?: () => CollaborationService;
};

const TelegramMcpCollaborationService: ServiceSchema = {
  name: TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: CollaborationServiceCarrier) {
    this.collaborationService = null;
  },

  methods: {
    getCollaborationService(
      this: CollaborationServiceCarrier,
    ): CollaborationService {
      if (!this.collaborationService) {
        throw new Error(
          "telegram_mcp collaboration service is not initialized yet",
        );
      }

      return this.collaborationService;
    },
  },

  async started(this: CollaborationServiceCarrier) {
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

    this.logger.info("Starting telegram_mcp collaboration service");
    const localBackend = new LocalCollaborationBackend(
      runtime.config,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.objectStore,
      runtime.telegramTransport,
      runtime.logger,
    );
    runtime.gatewayHttpService.setPartnerNoteRelayHandler(async (input) => {
      const resolved = runtime.projectIdentityResolver.resolveSessionDefaults(input);
      return localBackend.sendPartnerNote(input, resolved);
    });

    const backend =
      runtime.config.distributed.gatewayPublicUrl
        ? new GatewayCollaborationBackend(
            runtime.logger,
            runtime.config.distributed.gatewayPublicUrl,
            runtime.config.distributed.gatewayAuthToken,
          )
        : localBackend;

    this.collaborationService = new CollaborationService(
      backend,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    runtime.telegramTransport.setCollaborationService(
      this.collaborationService,
    );
    this.logger.info("telegram_mcp collaboration service is ready");
  },
};

export default TelegramMcpCollaborationService;
