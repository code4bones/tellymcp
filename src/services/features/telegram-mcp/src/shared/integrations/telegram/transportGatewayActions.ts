import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type {
  AdminClientViewRecord,
  GatewayActorProfile,
  GatewayClientRecord,
  GatewayClientSessionRecord,
  GatewayConnectedClientRecord,
  GatewayProjectRecord,
  GatewayProjectSessionRecord,
} from "./transportTypes";
import type { TransportGatewayDirectory } from "./transportGatewayDirectory";
import type { TransportProjectState } from "./transportProjectState";

export interface TransportGatewayActionsHost {
  getCollaborationService(): CollaborationService | undefined;
  projectState: TransportProjectState;
  gatewayDirectory: TransportGatewayDirectory;
}

export class TransportGatewayActions {
  public constructor(private readonly host: TransportGatewayActionsHost) {}

  public async sendPartnerNote(
    input: SendPartnerNoteInput,
  ): Promise<SendPartnerNoteOutput> {
    const collaborationService = this.host.getCollaborationService();
    if (collaborationService) {
      return collaborationService.sendPartnerNote(input);
    }

    throw new Error("Collaboration service is not configured");
  }

  public async ensureGatewayClientUuid(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<string> {
    return this.host.projectState.ensureGatewayClientUuid(principal, actor);
  }

  public async listGatewayProjects(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<GatewayProjectRecord[]> {
    return this.host.projectState.listGatewayProjects(principal, actor);
  }

  public async listGatewayClients(): Promise<GatewayClientRecord[]> {
    return this.host.gatewayDirectory.listGatewayClients();
  }

  public async listGatewayConnectedClients(): Promise<GatewayConnectedClientRecord[]> {
    return this.host.gatewayDirectory.listGatewayConnectedClients();
  }

  public async listGatewayAdminClients(): Promise<AdminClientViewRecord[]> {
    return this.host.gatewayDirectory.listGatewayAdminClients();
  }

  public async listGatewayClientSessions(
    clientUuid: string,
  ): Promise<GatewayClientSessionRecord[]> {
    return this.host.gatewayDirectory.listGatewayClientSessions(clientUuid);
  }

  public async listGatewayProjectSessions(
    principal: { telegramChatId: number; telegramUserId: number },
    projectUuid: string,
  ): Promise<GatewayProjectSessionRecord[]> {
    return this.host.projectState.listGatewayProjectSessions(principal, projectUuid);
  }

  public async listGatewaySessionHistory(
    principal: { telegramChatId: number; telegramUserId: number },
    localSessionId: string,
  ) {
    return this.host.projectState.listGatewaySessionHistory(principal, localSessionId);
  }

  public async ensureProjectSessionRegistered(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
  }): Promise<void> {
    await this.host.projectState.ensureProjectSessionRegistered(input);
  }

  public async loadProjectsContext(ctx: unknown) {
    return this.host.projectState.loadProjectsContext(ctx as never);
  }

  public async activateProjectForSession(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    await this.host.projectState.activateProjectForSession(input);
  }

  public async ensureOpenedProjectIsActive(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    await this.host.projectState.ensureOpenedProjectIsActive(input);
  }

  public async buildProjectsFingerprint(ctx: unknown): Promise<string> {
    return this.host.projectState.buildProjectsFingerprint(ctx as never);
  }
}
