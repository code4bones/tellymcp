export class ExternalInboxToolService {
  public constructor(
    private readonly callBroker: <T>(
      actionName: string,
      params: Record<string, unknown>,
    ) => Promise<T>,
  ) {}

  public async put(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.callBroker("telegramMcp.externalInbox.put", input);
  }

  public async responses(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.callBroker("telegramMcp.externalInbox.responses", input);
  }

  public async bindIdentity(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.callBroker("telegramMcp.externalInbox.bindIdentity", input);
  }

  public async bindRoute(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.callBroker("telegramMcp.externalInbox.bindRoute", input);
  }
}
