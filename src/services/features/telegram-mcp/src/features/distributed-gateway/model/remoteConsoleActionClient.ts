import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

function isBackendErrorLike(
  value: unknown,
): value is { message?: string; statusCode: number; code: string; name?: string; data?: unknown } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { statusCode?: unknown }).statusCode === "number" &&
      typeof (value as { code?: unknown }).code === "string",
  );
}

function formatBackendErrorLike(
  value: { message?: string; statusCode: number; code: string; name?: string; data?: unknown },
): string {
  const details: string[] = [];
  if (typeof value.code === "string" && value.code.trim()) {
    details.push(`code=${value.code.trim()}`);
  }
  if (typeof value.statusCode === "number") {
    details.push(`statusCode=${value.statusCode}`);
  }
  if (value.data !== undefined) {
    try {
      details.push(`data=${JSON.stringify(value.data)}`);
    } catch {
      details.push(`data=${String(value.data)}`);
    }
  }
  const base =
    typeof value.message === "string" && value.message.trim()
      ? value.message.trim()
      : `${value.name ?? "BackendError"} (${value.code})`;
  return details.length > 0 ? `${base}\n${details.join("\n")}` : base;
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
  ): Promise<{ clientUuid: string; localSessionId: string }> {
    const relayTarget = parseLiveRelaySessionId(sessionId);
    if (relayTarget) {
      return {
        clientUuid: relayTarget.clientUuid,
        localSessionId: relayTarget.localSessionId,
      };
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
      throw new Error(
        "Gateway-routed action requires a non-empty canonical session_id in the format client_uuid:local_session_id.",
      );
    }

    const resolved = await this.callBroker<{
      client_uuid: string;
      local_session_id: string;
    } | null>("telegramMcp.gatewaySocket.resolveConnectedSessionTarget", {
      sessionId: trimmedSessionId,
    });

    if (!resolved) {
      throw new Error(
        `Could not resolve live console target for session_id '${trimmedSessionId}'.`,
      );
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
  ): Promise<T> {
    const target = await this.resolveTarget(sessionId, params);

    const result = await this.callBroker<T>("telegramMcp.gatewaySocket.requestClientAction", {
      clientUuid: target.clientUuid,
      actionName,
      params: {
        ...params,
        session_id: target.localSessionId,
      },
    });

    if (isBackendErrorLike(result)) {
      throw new Error(formatBackendErrorLike(result));
    }

    return result;
  }
}
