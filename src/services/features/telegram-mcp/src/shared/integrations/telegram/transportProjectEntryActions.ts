import { buildPrincipalKey, readMenuPayloadKey } from "./transportUtils";
import type {
  PendingProjectRecord,
  TelegramMenuContext,
} from "./transportTypes";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramMenuPayloadStore,
} from "../../api/storage/contract";
import type { SupportedLocale } from "../../i18n";

export interface TransportProjectEntryActionsHost {
  bindingStore: SessionBindingStore;
  sessionStore: SessionStore;
  menuPayloadStore: TelegramMenuPayloadStore;
  pendingProjects: Map<string, PendingProjectRecord>;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  t(locale: SupportedLocale, key: string, options?: Record<string, unknown>): string;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId: string },
  ): Promise<{ message_id: number } | void>;
  showProjectsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  listGatewayProjects(
    principal: { telegramChatId: number; telegramUserId: number },
  ): Promise<Array<{ project_uuid: string; role: string }>>;
  getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
  } | null>;
  ensureOpenedProjectIsActive(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void>;
  showProjectMembers(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
  ): Promise<void>;
  ensureGatewayClientUuid(
    principal: { telegramChatId: number; telegramUserId: number },
  ): Promise<string>;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportProjectEntryActions {
  public constructor(private readonly host: TransportProjectEntryActionsHost) {}

  public async beginProjectMode(
    ctx: TelegramMenuContext,
    mode: "create" | "join",
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const sent = await this.host.replyText(
      ctx,
      mode === "create"
        ? [
            this.host.t(locale, "menu:project.create_prompt_title"),
            "",
            this.host.t(locale, "menu:project.create_prompt_body"),
            this.host.t(locale, "menu:project.prompt_cancel"),
          ].join("\n")
        : [
            this.host.t(locale, "menu:project.join_prompt_title"),
            "",
            this.host.t(locale, "menu:project.join_prompt_body"),
            this.host.t(locale, "menu:project.prompt_cancel"),
          ].join("\n"),
      { kind: "menu", sessionId },
    );

    this.host.pendingProjects.set(buildPrincipalKey(principal), {
      sessionId,
      mode,
      initiatedAt: new Date().toISOString(),
      ...(sent ? { promptMessageId: sent.message_id } : {}),
    });

    await ctx.answerCallbackQuery({
      text:
        mode === "create"
          ? this.host.t(locale, "menu:project.start_create")
          : this.host.t(locale, "menu:project.start_join"),
    });
  }

  public async handleProjectSelect(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.data_missing"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      return;
    }

    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const project = await this.host.getProjectPayloadByUuid(
      payload.sessionId,
      payload.projectUuid,
    );
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      return;
    }

    await this.host.ensureOpenedProjectIsActive({
      principal,
      sessionId: project.sessionId,
      projectUuid: project.projectUuid,
      projectName: project.projectName,
    });
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:project.opening_members"),
    });
    await this.host.showProjectMembers(ctx, project);
  }

  public async handleProjectDeleteSelect(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.data_missing"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-delete-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const projects = await this.host.listGatewayProjects(principal);
    const project = projects.find((item) => item.project_uuid === payload.projectUuid);
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (project.role !== "owner") {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.delete_only_owner"),
        show_alert: true,
      });
      return;
    }

    await this.host.callGatewayJson("/projects/delete", {
      project_uuid: payload.projectUuid,
    });
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:project.deleted"),
    });
    await this.host.showProjectsMenu(
      ctx,
      this.host.t(locale, "menu:project.deleted_screen"),
    );
  }

  public async leaveActiveProject(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.activeProjectUuid) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:project.no_active_project"),
        show_alert: true,
      });
      return;
    }

    const clientUuid = await this.host.ensureGatewayClientUuid(principal);
    await this.host.callGatewayJson("/projects/leave", {
      client_uuid: clientUuid,
      project_uuid: session.activeProjectUuid,
    });

    await this.host.sessionStore.setSession({
      ...session,
      activeProjectUuid: undefined,
      activeProjectName: undefined,
      updatedAt: new Date().toISOString(),
    });

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:project.left_current"),
    });
    await this.host.showProjectsMenu(
      ctx,
      this.host.t(locale, "menu:project.left_current_screen"),
    );
  }
}
