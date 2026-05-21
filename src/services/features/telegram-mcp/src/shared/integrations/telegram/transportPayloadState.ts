import { createMenuPayloadKey } from "../../lib/ids/ids";

export interface TransportPayloadStateHost {
  menuPayloadStore: {
    createMenuPayload(
      payload: Record<string, unknown>,
      ttlSeconds: number,
    ): Promise<void>;
  };
  menuPayloadTtlSeconds: number;
}

export class TransportPayloadState {
  public constructor(private readonly host: TransportPayloadStateHost) {}

  public async createInboxMenuPayload(
    sessionId: string,
    messageId: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "inbox-message",
      sessionId,
      messageId,
    });
  }

  public async createFileMenuPayload(
    sessionId: string,
    filePath: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "file-entry",
      sessionId,
      filePath,
    });
  }

  public async createSessionMenuPayload(sessionId: string): Promise<string> {
    return this.createPayload({
      kind: "active-session",
      sessionId,
    });
  }

  public async createLinkMenuPayload(
    sessionId: string,
    targetSessionId: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "link-target",
      sessionId,
      targetSessionId,
    });
  }

  public async createProjectMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "project-entry",
      sessionId,
      projectUuid,
      title,
    });
  }

  public async createProjectDeleteMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "project-delete-entry",
      sessionId,
      projectUuid,
      title,
    });
  }

  public async createProjectMemberMenuPayload(
    sessionId: string,
    projectUuid: string,
    targetSessionId: string,
    title: string,
    options?: {
      filePath?: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<string> {
    return this.createPayload({
      kind: options?.filePath ? "project-file-target" : "project-member",
      sessionId,
      projectUuid,
      targetSessionId,
      title,
      ...(options?.filePath ? { filePath: options.filePath } : {}),
      ...(options?.targetClientUuid
        ? { targetClientUuid: options.targetClientUuid }
        : {}),
      ...(options?.targetLocalSessionId
        ? { targetLocalSessionId: options.targetLocalSessionId }
        : {}),
    });
  }

  public async createLiveApprovalMenuPayload(input: {
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  }): Promise<string> {
    return this.createPayload({
      kind: "live-approval",
      sessionId: input.sessionId,
      sourceSessionId: input.sourceSessionId,
      sourceSessionLabel: input.sourceSessionLabel,
      sourceClientUuid: input.sourceClientUuid,
      sourceLocalSessionId: input.sourceLocalSessionId,
      targetSessionId: input.targetSessionId,
      title: input.targetSessionLabel,
      targetClientUuid: input.targetClientUuid,
      targetLocalSessionId: input.targetLocalSessionId,
      ...(input.projectUuid ? { projectUuid: input.projectUuid } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {}),
    });
  }

  public async createPartnerFileTargetPayload(
    sessionId: string,
    targetSessionId: string,
    title: string,
    filePath: string,
  ): Promise<string> {
    return this.createPayload({
      kind: "partner-file-target",
      sessionId,
      targetSessionId,
      title,
      filePath,
    });
  }

  private async createPayload(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.host.menuPayloadStore.createMenuPayload(
      {
        key,
        ...payload,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.host.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.host.menuPayloadTtlSeconds,
    );
    return key;
  }
}
