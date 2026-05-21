import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

export class RemoteConsoleActionClient {
  public constructor(
    private readonly callBroker: <T>(
      actionName: string,
      params?: Record<string, unknown>,
    ) => Promise<T>,
  ) {}

  private async resolveTarget(
    sessionId: string,
  ): Promise<{ clientUuid: string; localSessionId: string } | null> {
    const relayTarget = parseLiveRelaySessionId(sessionId);
    if (relayTarget) {
      return {
        clientUuid: relayTarget.clientUuid,
        localSessionId: relayTarget.localSessionId,
      };
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
      return null;
    }

    const resolved = await this.callBroker<{
      client_uuid: string;
      local_session_id: string;
    } | null>("telegramMcp.gatewaySocket.resolveConnectedSessionTarget", {
      sessionId: trimmedSessionId,
    });

    if (!resolved) {
      return null;
    }

    return {
      clientUuid: resolved.client_uuid,
      localSessionId: resolved.local_session_id,
    };
  }

  public async invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    const target = await this.resolveTarget(sessionId);
    if (!target) {
      return null;
    }

    return this.callBroker<T>("telegramMcp.gatewaySocket.requestClientAction", {
      clientUuid: target.clientUuid,
      actionName,
      params: {
        ...params,
        session_id: target.localSessionId,
      },
    });
  }
}
