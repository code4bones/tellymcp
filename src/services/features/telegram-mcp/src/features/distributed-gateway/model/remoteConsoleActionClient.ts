import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

export class RemoteConsoleActionClient {
  public constructor(
    private readonly callBroker: <T>(
      actionName: string,
      params?: Record<string, unknown>,
    ) => Promise<T>,
  ) {}

  public async invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    const relayTarget = parseLiveRelaySessionId(sessionId);
    if (!relayTarget) {
      return null;
    }

    return this.callBroker<T>("telegramMcp.gatewaySocket.requestClientAction", {
      clientUuid: relayTarget.clientUuid,
      actionName,
      params: {
        ...params,
        session_id: relayTarget.localSessionId,
      },
    });
  }
}
