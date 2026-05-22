import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

function isBackendErrorLike(
  value: unknown,
): value is { message?: string; statusCode: number; code: string; name?: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { statusCode?: unknown }).statusCode === "number" &&
      typeof (value as { code?: unknown }).code === "string",
  );
}

export class RemoteConsoleActionClient {
  public constructor(
    private readonly callBroker: <T>(
      actionName: string,
      params?: Record<string, unknown>,
    ) => Promise<T>,
  ) {}

  private async resolveTarget(
    sessionId: string,
    _params: Record<string, unknown>,
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
    const target = await this.resolveTarget(sessionId, params);
    if (!target) {
      return null;
    }

    const result = await this.callBroker<T>("telegramMcp.gatewaySocket.requestClientAction", {
      clientUuid: target.clientUuid,
      actionName,
      params: {
        ...params,
        session_id: target.localSessionId,
      },
    });

    if (isBackendErrorLike(result)) {
      throw new Error(
        typeof result.message === "string" && result.message.trim()
          ? result.message
          : `${result.name ?? "BackendError"} (${result.code})`,
      );
    }

    return result;
  }
}
