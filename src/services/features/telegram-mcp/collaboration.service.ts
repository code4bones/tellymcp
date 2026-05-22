import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { CollaborationService } from "./src/features/collaboration/model/collaborationService";
import { SendPartnerFileService } from "./src/features/collaboration/model/sendPartnerFileService";
import { GatewaySessionsService } from "./src/features/collaboration/model/gatewaySessionsService";
import { GatewayCollaborationBackend } from "./src/features/distributed-client/model/gatewayCollaborationBackend";
import { LocalCollaborationBackend } from "./src/features/collaboration/model/localCollaborationBackend";

export const TELEGRAM_MCP_COLLABORATION_SERVICE_NAME =
  "telegramMcp.collaboration";

export type TelegramMcpCollaborationServiceInstance = Service & {
  collaborationService: CollaborationService | null;
  sendPartnerFileService: SendPartnerFileService | null;
  gatewaySessionsService: GatewaySessionsService | null;
  getCollaborationService: () => CollaborationService;
  getSendPartnerFileService: () => SendPartnerFileService;
  getGatewaySessionsService: () => GatewaySessionsService;
};

type CollaborationServiceCarrier = Service & {
  collaborationService?: CollaborationService | null;
  sendPartnerFileService?: SendPartnerFileService | null;
  gatewaySessionsService?: GatewaySessionsService | null;
  getCollaborationService?: () => CollaborationService;
  getSendPartnerFileService?: () => SendPartnerFileService;
  getGatewaySessionsService?: () => GatewaySessionsService;
};

const TelegramMcpCollaborationService: ServiceSchema = {
  name: TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: CollaborationServiceCarrier) {
    this.collaborationService = null;
    this.sendPartnerFileService = null;
    this.gatewaySessionsService = null;
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
    getSendPartnerFileService(
      this: CollaborationServiceCarrier,
    ): SendPartnerFileService {
      if (!this.sendPartnerFileService) {
        throw new Error(
          "telegram_mcp send partner file service is not initialized yet",
        );
      }

      return this.sendPartnerFileService;
    },
    getGatewaySessionsService(
      this: CollaborationServiceCarrier,
    ): GatewaySessionsService {
      if (!this.gatewaySessionsService) {
        throw new Error(
          "telegram_mcp gateway sessions service is not initialized yet",
        );
      }

      return this.gatewaySessionsService;
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

    const runtime = await runtimeService.waitUntilReady();

    this.logger.info("Starting telegram_mcp collaboration service");
    const localBackend = new LocalCollaborationBackend(
      runtime.config,
      runtime.sessionStore,
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
            runtime.stateStore,
            runtime.config.distributed.gatewayPublicUrl,
            runtime.config.distributed.gatewayAuthToken,
            runtime.config.distributed.gatewayToken,
            runtime.config.distributed.gatewayUserUuid,
            runtime.config.project.name,
            runtime.config.telegram.botUsername,
          )
        : localBackend;

    this.collaborationService = new CollaborationService(
      backend,
      runtime.logger,
      runtime.projectIdentityResolver,
    );
    this.sendPartnerFileService = new SendPartnerFileService(
      runtime.config,
      runtime.sessionStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      this.collaborationService,
    );
    this.gatewaySessionsService = new GatewaySessionsService(
      runtime.logger,
      runtime.stateStore,
      runtime.config.distributed.gatewayPublicUrl,
      runtime.config.distributed.gatewayAuthToken,
      runtime.config.distributed.gatewayToken,
      runtime.config.distributed.gatewayUserUuid,
      runtime.config.project.name,
      runtime.config.telegram.botUsername,
    );
    runtime.telegramTransport.setCollaborationService(
      this.collaborationService,
    );
    this.logger.info("telegram_mcp collaboration service is ready");
  },
};

export default TelegramMcpCollaborationService;
