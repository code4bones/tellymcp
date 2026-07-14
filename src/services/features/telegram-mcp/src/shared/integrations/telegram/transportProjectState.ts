import type { AppConfig } from "../../../app/config/env";
import { buildLiveRelaySessionId, parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  GatewayActorProfile,
  GatewayProjectRecord,
  GatewayProjectSessionRecord,
  GatewayRelayBindingPayload,
  TelegramMenuContext,
} from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportProjectStateHost {
  config: AppConfig;
  getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  callGatewayJson<T>(path: string, payload: Record<string, unknown>): Promise<T>;
  sessionStore: {
    getSession(sessionId: string): Promise<SessionContext | null>;
    setSession(session: SessionContext): Promise<void>;
  };
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
    getBinding(sessionId: string): Promise<{
      sessionId: string;
      telegramChatId: number;
      telegramUserId: number;
      telegramUsername?: string | undefined;
      linkedAt: string;
    } | null>;
    setBinding(input: {
      sessionId: string;
      telegramChatId: number;
      telegramUserId: number;
      telegramUsername?: string | undefined;
      linkedAt: string;
    }): Promise<void>;
    setActiveSessionIdForPrincipal(
      principal: Principal,
      sessionId: string,
    ): Promise<void>;
  };
  maintenanceStore: {
    getGatewayClientUuid(): Promise<string | null>;
    setGatewayClientUuid(clientUuid: string): Promise<void>;
  };
  menuPayloadStore: {
    getMenuPayload(payloadKey: string): Promise<Record<string, unknown> | null>;
  };
}

export class TransportProjectState {
  public constructor(private readonly host: TransportProjectStateHost) {}

  private extractShortSessionLabel(session: SessionContext, fallback: string): string {
    const label = session.label?.trim() || fallback;
    const separator = " · ";
    const separatorIndex = label.indexOf(separator);
    if (separatorIndex <= 0) {
      return label;
    }
    return label.slice(0, separatorIndex).trim() || fallback;
  }

  private async resolveProjectClientTarget(input: {
    principal: Principal;
    sessionId?: string;
    actor?: GatewayActorProfile;
  }): Promise<{
    clientUuid: string;
    localSessionId: string | null;
    sessionId: string | null;
  }> {
    const resolvedSessionId =
      input.sessionId ??
      (await this.host.bindingStore.getActiveSessionIdForPrincipal(input.principal));
    if (resolvedSessionId) {
      const relay = parseLiveRelaySessionId(resolvedSessionId);
      if (relay) {
        return {
          clientUuid: relay.clientUuid,
          localSessionId: relay.localSessionId,
          sessionId: resolvedSessionId,
        };
      }
    }

    return {
      clientUuid: await this.ensureGatewayClientUuid(input.principal, input.actor),
      localSessionId: resolvedSessionId ?? null,
      sessionId: resolvedSessionId ?? null,
    };
  }

  public async ensureGatewayClientUuid(
    principal: Principal,
    actor?: GatewayActorProfile,
  ): Promise<string> {
    const existing = await this.host.maintenanceStore.getGatewayClientUuid();
    if (existing && !actor) {
      return existing;
    }

    const response = await this.host.callGatewayJson<{
      client_uuid: string;
    }>("/client/register", {
      ...(existing ? { client_uuid: existing } : {}),
      client_label:
        this.host.config.project.name ||
        this.host.config.telegram.botUsername ||
        "telegram-mcp client",
      bot_username: this.host.config.telegram.botUsername,
      ...(this.host.config.distributed.gatewayScopeToken
        ? { gateway_token: this.host.config.distributed.gatewayScopeToken }
        : {}),
      meta: {
        telegram_chat_id: principal.telegramChatId,
        telegram_user_id: principal.telegramUserId,
        ...(actor?.telegramUsername
          ? { telegram_username: actor.telegramUsername }
          : {}),
        ...(actor?.telegramFirstName
          ? { telegram_first_name: actor.telegramFirstName }
          : {}),
        ...(actor?.telegramLastName ? { telegram_last_name: actor.telegramLastName } : {}),
        ...(actor?.telegramDisplayName
          ? { telegram_display_name: actor.telegramDisplayName }
          : {}),
      },
    });

    await this.host.maintenanceStore.setGatewayClientUuid(response.client_uuid);
    return response.client_uuid;
  }

  public async listGatewayProjects(
    principal: Principal,
    actor?: GatewayActorProfile,
  ): Promise<GatewayProjectRecord[]> {
    const target = await this.resolveProjectClientTarget({
      principal,
      ...(actor ? { actor } : {}),
    });
    const response = await this.host.callGatewayJson<{
      projects: GatewayProjectRecord[];
    }>("/projects/list", {
      client_uuid: target.clientUuid,
      ...(target.localSessionId
        ? { local_session_id: target.localSessionId }
        : {}),
    });
    return response.projects;
  }

  public async listGatewayProjectSessions(
    principal: Principal,
    projectUuid: string,
  ): Promise<GatewayProjectSessionRecord[]> {
    const { clientUuid } = await this.resolveProjectClientTarget({
      principal,
    });
    const response = await this.host.callGatewayJson<{
      sessions: GatewayProjectSessionRecord[];
    }>("/projects/sessions", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });
    return response.sessions;
  }

  public async listGatewaySessionHistory(
    principal: Principal,
    localSessionId: string,
  ): Promise<
    Array<{
      message_uuid: string;
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_uuid?: string;
      project_name?: string;
      from_session_id: string;
      from_label: string;
      to_session_id: string;
      to_label: string;
      delivery_status?: string;
    }>
  > {
    const { clientUuid } = await this.resolveProjectClientTarget({
      principal,
    });
    const response = await this.host.callGatewayJson<{
      history: Array<{
        message_uuid: string;
        kind: string;
        summary: string;
        created_at: string;
        direction: "outgoing" | "incoming";
        project_uuid?: string;
        project_name?: string;
        from_session_id: string;
        from_label: string;
        to_session_id: string;
        to_label: string;
        delivery_status?: string;
      }>;
    }>("/history/list", {
      client_uuid: clientUuid,
      local_session_id: localSessionId,
      limit: 5,
    });
    return Array.isArray(response.history) ? response.history : [];
  }

  public async ensureProjectSessionRegistered(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error("Active session not found.");
    }

    const target = await this.resolveProjectClientTarget({
      principal: input.principal,
      sessionId: input.sessionId,
    });
    const localSessionId = target.localSessionId ?? session.sessionId;
    await this.host.callGatewayJson("/sessions/register", {
      client_uuid: target.clientUuid,
      project_uuid: input.projectUuid,
      local_session_id: localSessionId,
      label: this.extractShortSessionLabel(session, localSessionId),
      cwd: session.cwd,
      status: "active",
    });
  }

  public async loadProjectsContext(
    ctx: TelegramMenuContext,
  ): Promise<{
    principal: Principal | null;
    session: SessionContext | null;
    projects: GatewayProjectRecord[] | null;
  }> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal || !this.host.config.distributed.gatewayPublicUrl) {
      return { principal, session: null, projects: null };
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return { principal, session: null, projects: null };
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    if (!session) {
      return { principal, session: null, projects: null };
    }

    const projects = await this.listGatewayProjects(
      principal,
      this.host.getGatewayActorFromContext(ctx),
    );
    return { principal, session, projects };
  }

  public async activateProjectForSession(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error("Active session not found.");
    }

    await this.host.sessionStore.setSession({
      ...session,
      activeProjectUuid: input.projectUuid,
      activeProjectName: input.projectName,
      updatedAt: new Date().toISOString(),
    });
  }

  public async ensureOpenedProjectIsActive(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.sessionId);
    if (
      session?.activeProjectUuid === input.projectUuid &&
      session.activeProjectName === input.projectName
    ) {
      return;
    }

    await this.activateProjectForSession(input);
  }

  public async buildProjectsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const { session, projects } = await this.loadProjectsContext(ctx);
    return `${session?.sessionId ?? "none"}:${session?.activeProjectUuid ?? "none"}:${projects?.map((item) => item.project_uuid).join(",") ?? "none"}`;
  }

  public async getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
  } | null> {
    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session) {
      return null;
    }

    const principalBinding = await this.host.bindingStore.getBinding(sessionId);
    if (!principalBinding) {
      return null;
    }

    const projects = await this.listGatewayProjects({
      telegramChatId: principalBinding.telegramChatId,
      telegramUserId: principalBinding.telegramUserId,
    });
    const project = projects.find((item) => item.project_uuid === projectUuid);
    if (!project) {
      return null;
    }

    return {
      sessionId,
      projectUuid,
      projectName: project.name,
      inviteToken: project.invite_token,
    };
  }

  public async getProjectMemberPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid?: string;
    targetLocalSessionId?: string;
    filePath?: string;
  } | null> {
    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      (payload.kind !== "project-member" &&
        payload.kind !== "project-file-target") ||
      !payload.sessionId ||
      !payload.projectUuid ||
      !payload.targetSessionId
    ) {
      return null;
    }

    const project = await this.getProjectPayloadByUuid(
      String(payload.sessionId),
      String(payload.projectUuid),
    );
    if (!project) {
      return null;
    }

    return {
      sessionId: String(payload.sessionId),
      projectUuid: String(payload.projectUuid),
      projectName: project.projectName,
      inviteToken: project.inviteToken,
      targetSessionId: String(payload.targetSessionId),
      targetSessionLabel: String(payload.title ?? payload.targetSessionId),
      ...(payload.targetClientUuid
        ? { targetClientUuid: String(payload.targetClientUuid) }
        : {}),
      ...(payload.targetLocalSessionId
        ? { targetLocalSessionId: String(payload.targetLocalSessionId) }
        : {}),
      ...(payload.filePath ? { filePath: String(payload.filePath) } : {}),
    };
  }

  public async getPartnerFileTargetPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    filePath: string;
  } | null> {
    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "partner-file-target" ||
      !payload.sessionId ||
      !payload.targetSessionId ||
      !payload.filePath
    ) {
      return null;
    }

    return {
      sessionId: String(payload.sessionId),
      targetSessionId: String(payload.targetSessionId),
      targetSessionLabel: String(payload.title ?? payload.targetSessionId),
      filePath: String(payload.filePath),
    };
  }

  public async getLiveApprovalPayloadByKey(
    payloadKey: string,
  ): Promise<{
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
  } | null> {
    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "live-approval" ||
      !payload.sessionId ||
      !payload.sourceSessionId ||
      !payload.sourceSessionLabel ||
      !payload.sourceClientUuid ||
      !payload.sourceLocalSessionId ||
      !payload.targetSessionId ||
      !payload.title ||
      !payload.targetClientUuid ||
      !payload.targetLocalSessionId
    ) {
      return null;
    }

    return {
      sessionId: String(payload.sessionId),
      sourceSessionId: String(payload.sourceSessionId),
      sourceSessionLabel: String(payload.sourceSessionLabel),
      sourceClientUuid: String(payload.sourceClientUuid),
      sourceLocalSessionId: String(payload.sourceLocalSessionId),
      targetSessionId: String(payload.targetSessionId),
      targetSessionLabel: String(payload.title),
      targetClientUuid: String(payload.targetClientUuid),
      targetLocalSessionId: String(payload.targetLocalSessionId),
      ...(payload.projectUuid ? { projectUuid: String(payload.projectUuid) } : {}),
      ...(payload.projectName ? { projectName: String(payload.projectName) } : {}),
    };
  }

  public buildRelaySessionContext(
    input: GatewayRelayBindingPayload,
  ): SessionContext {
    const relaySessionId = buildLiveRelaySessionId(
      input.targetClientUuid,
      input.targetLocalSessionId,
    );
    const now = new Date().toISOString();
    return {
      sessionId: relaySessionId,
      label: input.targetSessionLabel,
      ...(input.projectUuid ? { activeProjectUuid: input.projectUuid } : {}),
      ...(input.projectName ? { activeProjectName: input.projectName } : {}),
      updatedAt: now,
    };
  }

  public async bindRelaySessionToPrincipal(input: {
    principal: Principal;
    ctx: TelegramMenuContext;
    payload: GatewayRelayBindingPayload;
  }): Promise<SessionContext> {
    const session = this.buildRelaySessionContext(input.payload);
    const existingSession = await this.host.sessionStore.getSession(session.sessionId);
    await this.host.sessionStore.setSession({
      ...(existingSession ?? session),
      ...session,
      ...(existingSession?.cwd ? { cwd: existingSession.cwd } : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions
        ? { decisions: existingSession.decisions }
        : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      ...(existingSession?.lastSeenToolsHash
        ? { lastSeenToolsHash: existingSession.lastSeenToolsHash }
        : {}),
      ...(existingSession?.lastNotifiedToolsHash
        ? { lastNotifiedToolsHash: existingSession.lastNotifiedToolsHash }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    await this.host.bindingStore.setBinding({
      sessionId: session.sessionId,
      telegramChatId: input.principal.telegramChatId,
      telegramUserId: input.principal.telegramUserId,
      ...(input.ctx.from?.username
        ? { telegramUsername: input.ctx.from.username }
        : {}),
      linkedAt: new Date().toISOString(),
    });
    await this.host.bindingStore.setActiveSessionIdForPrincipal(
      input.principal,
      session.sessionId,
    );
    return session;
  }
}
