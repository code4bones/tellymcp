import { resolveGatewayControlBaseUrl } from "./transportUtils";
import { mergeGatewayAdminClients } from "./transportAdminView";
import type {
  AdminClientViewRecord,
  GatewayClientRecord,
  GatewayClientSessionRecord,
  GatewayConnectedClientRecord,
} from "./transportTypes";
import type { AppConfig } from "../../../app/config/env";
import type { Logger } from "../../lib/logger/logger";

export interface TransportGatewayDirectoryHost {
  logger: Logger;
  config: AppConfig;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportGatewayDirectory {
  public constructor(private readonly host: TransportGatewayDirectoryHost) {}

  public async listGatewayClients(): Promise<GatewayClientRecord[]> {
    this.host.logger.info("Telegram admin requested gateway clients list", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.host.config),
    });
    const response = await this.host.callGatewayJson<{
      clients: GatewayClientRecord[];
    }>("/clients/list", {});
    const clients = Array.isArray(response.clients) ? response.clients : [];
    this.host.logger.info("Telegram admin received gateway clients list", {
      count: clients.length,
      clientUuids: clients.map((client) => client.client_uuid),
    });
    return clients;
  }

  public async listGatewayConnectedClients(): Promise<GatewayConnectedClientRecord[]> {
    this.host.logger.info("Telegram admin requested connected gateway clients list", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.host.config),
    });
    const response = await this.host.callGatewayJson<{
      clients: GatewayConnectedClientRecord[];
    }>("/clients/connected", {});
    const clients = Array.isArray(response.clients) ? response.clients : [];
    this.host.logger.info("Telegram admin received connected gateway clients list", {
      count: clients.length,
      clientUuids: clients.map((client) => client.client_uuid),
    });
    return clients;
  }

  public async listGatewayAdminClients(): Promise<AdminClientViewRecord[]> {
    const [registeredClients, connectedClients] = await Promise.all([
      this.listGatewayClients(),
      this.listGatewayConnectedClients(),
    ]);
    return mergeGatewayAdminClients({
      registeredClients,
      connectedClients,
    });
  }

  public async listGatewayClientSessions(
    clientUuid: string,
  ): Promise<GatewayClientSessionRecord[]> {
    this.host.logger.info("Telegram admin requested gateway client sessions", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.host.config),
      clientUuid,
    });
    const response = await this.host.callGatewayJson<{
      sessions: GatewayClientSessionRecord[];
    }>("/clients/sessions", {
      client_uuid: clientUuid,
    });
    const sessions = Array.isArray(response.sessions) ? response.sessions : [];
    this.host.logger.info("Telegram admin received gateway client sessions", {
      clientUuid,
      count: sessions.length,
      localSessionIds: sessions.map((session) => session.local_session_id),
    });
    return sessions;
  }
}
