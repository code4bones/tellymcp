import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { GatewayActorProfile, TelegramMenuContext } from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportProjectHost {
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<"ru" | "en">;
  t(
    locale: "ru" | "en",
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  extractCallbackSuffix(ctx: TelegramMenuContext, prefix: string): string | null;
  getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined;
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
  };
  sessionStore: {
    getSession(sessionId: string): Promise<SessionContext | null>;
    setSession(session: SessionContext): Promise<void>;
  };
  pendingProjects: Map<string, { sessionId: string; mode: "create" | "join"; initiatedAt: string; promptMessageId?: number }>;
  ensureGatewayClientUuid(
    principal: Principal,
    actor?: GatewayActorProfile,
  ): Promise<string>;
  listGatewayProjects(principal: Principal): Promise<Array<{ project_uuid: string; name: string; invite_token: string; role: string }>>;
  callGatewayJson<T>(path: string, payload: Record<string, unknown>): Promise<T>;
  activateProjectForSession(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void>;
  ensureOpenedProjectIsActive(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void>;
  getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
  } | null>;
  getProjectMemberPayloadByKey(
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
  } | null>;
  getPartnerFileTargetPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    filePath: string;
  } | null>;
  getLiveApprovalPayloadByKey(
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
  } | null>;
  beginFileHandoffModeForTarget(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      filePath: string;
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void>;
  beginPartnerNoteMode(
    ctx: TelegramMenuContext,
    kind: PartnerNoteKind,
    target?: {
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void>;
  showProjectMembers(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
  ): Promise<void>;
  showProjectMemberDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void>;
  showProjectMemberFiles(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void>;
  showProjectsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showCollabDeleteMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
  ): Promise<void | { message_id: number }>;
  editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
  ): Promise<void>;
}

export class TransportProjectActions {
  public constructor(private readonly host: TransportProjectHost) {}

  public async handleProjectSetCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const projectUuid = this.host.extractCallbackSuffix(ctx, "project-set:");
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_action"), show_alert: true });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_active_session"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.not_found"), show_alert: true });
      return;
    }
    await this.host.activateProjectForSession({
      principal,
      sessionId,
      projectUuid: payload.projectUuid,
      projectName: payload.projectName,
    });
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.opening_members") });
    await this.host.showProjectMembers(ctx, payload);
  }

  public async handleProjectDetailCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const projectUuid = this.host.extractCallbackSuffix(ctx, "project-detail:");
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_action"), show_alert: true });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_active_session"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.not_found"), show_alert: true });
      return;
    }
    await this.host.ensureOpenedProjectIsActive({
      principal,
      sessionId,
      projectUuid: payload.projectUuid,
      projectName: payload.projectName,
    });
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.opening_members") });
    await this.host.showProjectMembers(ctx, payload);
  }

  public async handleProjectDeleteCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const projectUuid = this.host.extractCallbackSuffix(ctx, "project-delete:");
    if (!projectUuid) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_action"), show_alert: true });
      return;
    }
    await this.handleProjectDeleteByUuid(ctx, projectUuid);
  }

  public async handleProjectMemberOpenCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(ctx, "project-member-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_member_payload"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.stale_member_payload"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    if (payload.filePath) {
      await this.host.beginFileHandoffModeForTarget(ctx, {
        sessionId: payload.sessionId,
        filePath: payload.filePath,
        targetSessionId: payload.targetSessionId,
        targetSessionLabel: payload.targetSessionLabel,
        projectUuid: payload.projectUuid,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.opening_session") });
    await this.host.showProjectMemberDetail(ctx, payload);
  }

  public async handleProjectMemberNoteCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^project-member-note:(question|share):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_member_action"), show_alert: true });
      return;
    }
    const [, kind, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_member_payload"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.stale_member_payload"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    await this.host.beginPartnerNoteMode(ctx, kind as PartnerNoteKind, {
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.targetSessionLabel,
      projectUuid: payload.projectUuid,
    });
  }

  public async handleProjectMemberLiveCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(ctx, "project-member-live:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_live_payload"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectMemberPayloadByKey(payloadKey);
    if (!payload || !payload.targetClientUuid || !payload.targetLocalSessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.stale_live_payload"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.no_telegram_user"), show_alert: true });
      return;
    }
    const session = await this.host.sessionStore.getSession(payload.sessionId);
    const actor = this.host.getGatewayActorFromContext(ctx);
    const sourceClientUuid = await this.host.ensureGatewayClientUuid(principal, actor);
    const result = await this.host.callGatewayJson<{ delivered?: boolean }>("/live/request-approval", {
      client_uuid: payload.targetClientUuid,
      payload: {
        ...(payload.projectUuid ? { project_uuid: payload.projectUuid } : {}),
        ...(payload.projectName ? { project_name: payload.projectName } : {}),
        source_session_id: payload.sessionId,
        source_session_label: session?.label ?? payload.sessionId,
        source_client_uuid: sourceClientUuid,
        source_local_session_id: payload.sessionId,
        target_session_id: payload.targetSessionId,
        target_session_label: payload.targetSessionLabel,
        target_client_uuid: payload.targetClientUuid,
        target_local_session_id: payload.targetLocalSessionId,
      },
    });
    await ctx.answerCallbackQuery({
      text: result?.delivered
        ? this.host.t(locale, "menu:project.request_live_sent")
        : this.host.t(locale, "menu:live.actions.approval_unavailable"),
      ...(result?.delivered ? {} : { show_alert: true }),
    });
  }

  public async handleLiveApprovalCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^live-approval:(approve|deny):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_approval"), show_alert: true });
      return;
    }
    const [, decision, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_approval_data"), show_alert: true });
      return;
    }
    const payload = await this.host.getLiveApprovalPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.approval_stale"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const approved = decision === "approve";
    const result = await this.host.callGatewayJson<{ delivered?: boolean }>("/live/resolve-approval", {
      client_uuid: payload.sourceClientUuid,
      approved,
      payload: {
        ...(payload.projectUuid ? { project_uuid: payload.projectUuid } : {}),
        ...(payload.projectName ? { project_name: payload.projectName } : {}),
        source_session_id: payload.sourceSessionId,
        source_session_label: payload.sourceSessionLabel,
        source_client_uuid: payload.sourceClientUuid,
        source_local_session_id: payload.sourceLocalSessionId,
        target_session_id: payload.targetSessionId,
        target_session_label: payload.targetSessionLabel,
        target_client_uuid: payload.targetClientUuid,
        target_local_session_id: payload.targetLocalSessionId,
      },
    });
    await ctx.answerCallbackQuery({
      text: approved
        ? this.host.t(locale, "menu:live.approval.approved")
        : this.host.t(locale, "menu:live.approval.denied"),
    });
    if (ctx.callbackQuery?.message) {
      await this.host.editText(
        ctx,
        [
          approved
            ? this.host.t(locale, "menu:live.approval.approved")
            : this.host.t(locale, "menu:live.approval.denied"),
          "",
          ...(payload.projectName
            ? [this.host.t(locale, "menu:live.approval.project", { projectName: payload.projectName })]
            : []),
          this.host.t(locale, "menu:live.approval.route", {
            sourceSessionName: payload.sourceSessionLabel,
            targetSessionName: payload.targetSessionLabel,
          }),
          "",
          result?.delivered
            ? approved
              ? this.host.t(locale, "menu:live.approval.source_open")
              : this.host.t(locale, "menu:live.approval.result_denied", {
                  sourceSessionName: payload.sourceSessionLabel,
                  targetSessionName: payload.targetSessionLabel,
                })
            : this.host.t(locale, "menu:live.actions.approval_unavailable"),
        ].join("\n"),
        { kind: "menu", sessionId: payload.sessionId },
      );
    }
  }

  public async handleProjectMemberFilesCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(ctx, "project-member-files:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_member_payload"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.stale_member_payload"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.opening_files") });
    await this.host.showProjectMemberFiles(ctx, payload);
  }

  public async handlePartnerFileOpenCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = this.host.extractCallbackSuffix(ctx, "partner-file-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_member_payload"), show_alert: true });
      return;
    }
    const payload = await this.host.getPartnerFileTargetPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.data_stale"), show_alert: true });
      return;
    }
    await this.host.beginFileHandoffModeForTarget(ctx, {
      sessionId: payload.sessionId,
      filePath: payload.filePath,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.targetSessionLabel,
    });
  }

  public async handleProjectMembersCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const projectUuid = this.host.extractCallbackSuffix(ctx, "project-members:");
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_action"), show_alert: true });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_active_session"), show_alert: true });
      return;
    }
    const payload = await this.host.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.not_found"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.loading_members") });
    await this.host.showProjectMembers(ctx, payload);
  }

  public async handleProjectLeaveCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const projectUuid = this.host.extractCallbackSuffix(ctx, "project-leave:");
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.invalid_action"), show_alert: true });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_active_session"), show_alert: true });
      return;
    }
    const session = await this.host.sessionStore.getSession(sessionId);
    const clientUuid = await this.host.ensureGatewayClientUuid(principal);
    await this.host.callGatewayJson("/projects/leave", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });
    if (session?.activeProjectUuid === projectUuid) {
      await this.host.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.left_callback") });
    await this.host.showProjectsMenu(ctx, this.host.t(locale, "menu:project.left_screen"));
  }

  public async handleProjectDeleteByUuid(ctx: TelegramMenuContext, projectUuid: string): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_telegram_identity"), show_alert: true });
      return;
    }
    const sessionId = await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "common:errors.no_active_session"), show_alert: true });
      return;
    }
    const projects = await this.host.listGatewayProjects(principal);
    const project = projects.find((item) => item.project_uuid === projectUuid);
    if (!project) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.not_found"), show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    if (project.role !== "owner") {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.delete_only_owner"), show_alert: true });
      return;
    }
    const clientUuid = await this.host.ensureGatewayClientUuid(principal);
    await this.host.callGatewayJson("/projects/delete", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });
    const session = await this.host.sessionStore.getSession(sessionId);
    if (session?.activeProjectUuid === projectUuid) {
      await this.host.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:project.deleted_callback") });
    await this.host.showCollabDeleteMenu(
      ctx,
      this.host.t(locale, "menu:project.deleted_screen", { projectName: project.name }),
    );
  }

  public async handlePendingProject(ctx: TelegramMenuContext, text: string): Promise<boolean> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }
    const principalKey = `${principal.telegramChatId}:${principal.telegramUserId}`;
    const pending = this.host.pendingProjects.get(principalKey);
    if (!pending) {
      return false;
    }
    if (text.startsWith("/")) {
      this.host.pendingProjects.delete(principalKey);
      return false;
    }
    const value = text.trim();
    if (!value) {
      return true;
    }
    const clientUuid = await this.host.ensureGatewayClientUuid(principal);
    let projectName = "";
    let projectUuid = "";
    if (pending.mode === "create") {
      const created = await this.host.callGatewayJson<{
        project_uuid: string;
        invite_token: string;
        name: string;
      }>("/projects/create", { client_uuid: clientUuid, name: value });
      projectUuid = created.project_uuid;
      projectName = created.name;
      await this.host.activateProjectForSession({
        principal,
        sessionId: pending.sessionId,
        projectUuid,
        projectName,
      });
      await this.host.replyText(
        ctx,
        this.host.t(locale, "menu:project.created", {
          projectName,
          inviteToken: created.invite_token,
        }),
        { kind: "menu", sessionId: pending.sessionId },
      );
    } else {
      const joined = await this.host.callGatewayJson<{
        project_uuid: string;
        invite_token: string;
        name: string;
      }>("/projects/join", { client_uuid: clientUuid, invite_token: value });
      projectUuid = joined.project_uuid;
      projectName = joined.name;
      await this.host.activateProjectForSession({
        principal,
        sessionId: pending.sessionId,
        projectUuid,
        projectName,
      });
      await this.host.replyText(
        ctx,
        this.host.t(locale, "menu:project.joined", { projectName }),
        { kind: "menu", sessionId: pending.sessionId },
      );
    }
    this.host.pendingProjects.delete(principalKey);
    await this.host.showProjectsMenu(
      ctx,
      this.host.t(locale, "menu:project.opened", { projectName }),
    );
    return true;
  }
}
