import type {
  GatewayKnownSessionRecord,
  ListGatewaySessionsInput,
  ListGatewaySessionsOutput,
} from "../../../entities/collaboration/model/types";
import type { MaintenanceStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import {
  callGatewayJson,
  ensureGatewayClientUuid,
} from "../../distributed-client/model/gatewayClientAccess";

export class GatewaySessionsService {
  public constructor(
    private readonly logger: Logger,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly gatewayPublicUrl?: string,
    private readonly gatewayAuthToken?: string,
    private readonly gatewayToken?: string,
    private readonly projectName?: string,
    private readonly botUsername?: string,
  ) {}

  public async listKnownSessions(
    input: ListGatewaySessionsInput = {},
  ): Promise<ListGatewaySessionsOutput> {
    if (!this.gatewayPublicUrl) {
      throw new Error(
        "Gateway session listing requires GATEWAY_PUBLIC_URL.",
      );
    }

    await ensureGatewayClientUuid({
      maintenanceStore: this.maintenanceStore,
      gatewayPublicUrl: this.gatewayPublicUrl,
      ...(this.gatewayAuthToken
        ? { gatewayAuthToken: this.gatewayAuthToken }
        : {}),
      ...(this.gatewayToken ? { gatewayToken: this.gatewayToken } : {}),
      ...(this.projectName ? { projectName: this.projectName } : {}),
      ...(this.botUsername ? { botUsername: this.botUsername } : {}),
    });

    const response = await callGatewayJson<{
      total?: number;
      sessions?: GatewayKnownSessionRecord[];
    }>({
      gatewayPublicUrl: this.gatewayPublicUrl,
      ...(this.gatewayAuthToken
        ? { gatewayAuthToken: this.gatewayAuthToken }
        : {}),
      endpointPath: "/sessions/known",
      body: {
        ...(input.client_uuid?.trim()
          ? { client_uuid: input.client_uuid.trim() }
          : {}),
        ...(this.gatewayToken ? { gateway_token: this.gatewayToken } : {}),
        ...(typeof input.connected_only === "boolean"
          ? { connected_only: input.connected_only }
          : {}),
      },
    });

    const sessions = Array.isArray(response.sessions) ? response.sessions : [];
    this.logger.info("Known gateway sessions listed", {
      total: sessions.length,
      connectedOnly: input.connected_only ?? false,
    });
    return {
      total:
        typeof response.total === "number" && Number.isFinite(response.total)
          ? response.total
          : sessions.length,
      sessions,
    };
  }
}
