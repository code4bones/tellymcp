import { Buffer } from "node:buffer";

import { InlineKeyboard, InputFile } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import { buildProjectMemberDetailText } from "./collabUi";
import {
  buildCollabDeleteMenuText,
  buildCollabToolsMenuText,
  buildProjectsMenuText,
} from "./transportMenuText";
import type {
  CurrentAttachmentTargetRecord,
  GatewayActorProfile,
  GatewayProjectRecord,
  GatewayProjectSessionRecord,
  PendingProjectBroadcastRemoteTarget,
  TelegramMenuContext,
} from "./transportTypes";
import { escapeHtml, slugifyFilenamePart } from "./transportUtils";

type Principal = { telegramChatId: number; telegramUserId: number };
type SupportedLocale = "en" | "ru";

export interface TransportProjectViewHost {
  config: AppConfig;
  projectsMenu: unknown;
  collabToolsMenu: unknown;
  collabDeleteMenu: unknown;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  resolveLocaleForTelegramUserId(
    telegramUserId?: number,
    telegramLanguageCode?: string | null | undefined,
  ): Promise<SupportedLocale>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined;
  ensureGatewayClientUuid(
    principal: Principal,
    actor?: GatewayActorProfile,
  ): Promise<string>;
  loadProjectsContext(
    ctx: TelegramMenuContext,
  ): Promise<{
    principal: Principal | null;
    session: {
      sessionId: string;
      label?: string | undefined;
      activeProjectUuid?: string | undefined;
      activeProjectName?: string | undefined;
    } | null;
    projects: GatewayProjectRecord[] | null;
  }>;
  listGatewayProjects(
    principal: Principal,
    actor?: GatewayActorProfile,
  ): Promise<GatewayProjectRecord[]>;
  listGatewayProjectSessions(
    principal: Principal,
    projectUuid: string,
  ): Promise<GatewayProjectSessionRecord[]>;
  listGatewaySessionHistory(
    principal: Principal,
    localSessionId: string,
  ): Promise<
    Array<{
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_name?: string;
      from_label: string;
      to_label: string;
      delivery_status?: string;
    }>
  >;
  collectCollabBroadcastTargets(
    principal: Principal,
    sessionId: string,
  ): Promise<{
    localTargetSessionIds: string[];
    remoteTargets: PendingProjectBroadcastRemoteTarget[];
  }>;
  ensureOpenedProjectIsActive(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void>;
  setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void;
  renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: {
      parse_mode?: "HTML";
      reply_markup?: InlineKeyboard;
    },
  ): Promise<void | { message_id: number }>;
  editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: {
      parse_mode?: "HTML";
      reply_markup?: InlineKeyboard;
    },
  ): Promise<void>;
  replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: Parameters<TelegramMenuContext["replyWithDocument"]>[1],
    meta: { kind: "menu"; sessionId?: string },
  ): Promise<void>;
  sessionStore: {
    getSession(sessionId: string): Promise<{
      sessionId: string;
      label?: string | undefined;
    } | null>;
  };
  bindingStore: {
    getBinding(sessionId: string): Promise<{
      sessionId: string;
      telegramChatId: number;
      telegramUserId: number;
      telegramUsername?: string | undefined;
      linkedAt: string;
    } | null>;
  };
  maintenanceStore: {
    setProjectMenuViewState(input: {
      sessionId: string;
      projectUuid: string;
      telegramChatId: number;
      telegramMessageId: number;
      updatedAt: string;
    }): Promise<void>;
  };
  xchangeFileMetaStore: {
    getXchangeFileMeta(
      sessionId: string,
      filePath: string,
    ): Promise<{
      originalName?: string | undefined;
      relativePath?: string | undefined;
      caption?: string | undefined;
      uploadedAt?: string | undefined;
    } | null>;
  };
  webAppLaunchRegistry: {
    set(
      telegramUserId: number,
      sessionId: string,
      ttlSeconds: number,
      value: {
        telegramChatId?: number;
        telegramMessageId?: number;
        allowForeignBinding?: boolean;
      },
    ): void;
  };
  createProjectMemberMenuPayload(
    sessionId: string,
    projectUuid: string,
    targetSessionId: string,
    title: string,
    extra?: Record<string, unknown>,
  ): Promise<string>;
  listActiveSessionFiles(sessionId: string): Promise<string[]>;
  formatFilePreviewLabel(
    filePath: string,
    meta?: {
      originalName?: string | undefined;
      relativePath?: string | undefined;
    } | null,
  ): string;
}

export class TransportProjectView {
  public constructor(private readonly host: TransportProjectViewHost) {}

  public async buildProjectsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const { session, projects } = await this.host.loadProjectsContext(ctx);
    if (!this.host.config.distributed.gatewayPublicUrl) {
      return buildProjectsMenuText({
        title: this.host.t(locale, "menu:collab.screen.title"),
        gatewayNotConfiguredLine: this.host.t(
          locale,
          "menu:collab.screen.gateway_not_configured",
        ),
      });
    }

    if (!session || !projects) {
      return this.host.t(locale, "menu:collab.screen.unavailable");
    }

    return buildProjectsMenuText({
      title: this.host.t(locale, "menu:collab.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:collab.screen.active_session", {
        sessionName: session.label ?? session.sessionId,
      }),
      openProjectLine: session.activeProjectName
        ? this.host.t(locale, "menu:collab.screen.open_project", {
            projectName: session.activeProjectName,
          })
        : this.host.t(locale, "menu:collab.screen.open_project_none"),
      projectCountLine: this.host.t(locale, "menu:collab.screen.project_count", {
        count: projects.length,
      }),
      inviteHintLine: this.host.t(locale, "menu:collab.screen.invite_hint"),
    });
  }

  public async buildCollabToolsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal || !this.host.config.distributed.gatewayPublicUrl) {
      return this.host.t(locale, "menu:collab.screen.gateway_not_configured");
    }

    const { session } = await this.host.loadProjectsContext(ctx);
    if (!session) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const projects = await this.host.listGatewayProjects(principal);
    if (projects.length === 0) {
      return [
        this.host.t(locale, "menu:collab.screen.tools_title"),
        "",
        this.host.t(locale, "menu:collab.screen.active_session", {
          sessionName: session.label ?? session.sessionId,
        }),
        "",
        this.host.t(locale, "menu:collab.screen.tools_empty"),
      ].join("\n");
    }

    const targets = await this.host.collectCollabBroadcastTargets(
      principal,
      session.sessionId,
    );
    const uniqueCount =
      targets.localTargetSessionIds.length + targets.remoteTargets.length;

    return buildCollabToolsMenuText({
      title: this.host.t(locale, "menu:collab.screen.tools_title"),
      activeSessionLine: this.host.t(locale, "menu:collab.screen.active_session", {
        sessionName: session.label ?? session.sessionId,
      }),
      projectCountLine: this.host.t(locale, "menu:collab.screen.tools_project_count", {
        count: projects.length,
      }),
      sessionCountLine: this.host.t(locale, "menu:collab.screen.tools_session_count", {
        count: uniqueCount,
      }),
      broadcastLine: this.host.t(locale, "menu:collab.screen.tools_broadcast"),
      historyLine: this.host.t(locale, "menu:collab.screen.tools_history"),
      hintLine: this.host.t(locale, "menu:broadcast.collab_hint"),
    });
  }

  public async buildCollabDeleteMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const { session, projects } = await this.host.loadProjectsContext(ctx);
    if (!this.host.config.distributed.gatewayPublicUrl) {
      return this.host.t(locale, "menu:collab.screen.gateway_not_configured");
    }

    if (!session || !projects) {
      return this.host.t(locale, "menu:collab.screen.unavailable");
    }

    const ownerCount = projects.filter((project) => project.role === "owner").length;

    return buildCollabDeleteMenuText({
      title: this.host.t(locale, "menu:project.delete_menu_title"),
      activeSessionLine: this.host.t(locale, "menu:project.active_session", {
        sessionName: session.label ?? session.sessionId,
      }),
      totalCountLine: this.host.t(locale, "menu:project.total_count", {
        count: projects.length,
      }),
      ownerCountLine: this.host.t(locale, "menu:project.owner_count", {
        count: ownerCount,
      }),
      chooseLine: this.host.t(locale, "menu:project.delete_choose"),
      bodyLine: this.host.t(locale, "menu:project.delete_body"),
      ownerHintLine: this.host.t(locale, "menu:project.delete_owner_hint"),
    });
  }

  public async showProjectsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildProjectsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.projectsMenu,
    );
  }

  public async showCollabToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildCollabToolsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.collabToolsMenu,
    );
  }

  public async showCollabDeleteMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildCollabDeleteMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.collabDeleteMenu,
    );
  }

  public buildCollabHistoryMarkdown(input: {
    locale?: SupportedLocale;
    sessionLabel: string;
    history: Array<{
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_name?: string;
      from_label: string;
      to_label: string;
      delivery_status?: string;
    }>;
  }): string {
    const locale = input.locale ?? "en";
    const lines = [
      this.host.t(locale, "menu:history.title"),
      "",
      this.host.t(locale, "menu:history.session", {
        sessionName: input.sessionLabel,
      }),
      `Generated at: ${new Date().toISOString()}`,
      "",
    ];

    if (input.history.length === 0) {
      lines.push(this.host.t(locale, "menu:history.empty"));
      lines.push("");
      return lines.join("\n");
    }

    lines.push("Last 5 events:");
    lines.push("");

    for (const item of input.history) {
      lines.push(`## ${item.kind}`);
      lines.push(`- Time: ${item.created_at}`);
      lines.push(`- Direction: ${item.direction}`);
      lines.push(`- Route: ${item.from_label} -> ${item.to_label}`);
      if (item.project_name) {
        lines.push(
          this.host.t(locale, "menu:history.project", {
            projectName: item.project_name,
          }),
        );
      }
      if (item.delivery_status) {
        lines.push(`- Status: ${item.delivery_status}`);
      }
      lines.push(`- Summary: ${item.summary || "(empty)"}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  public async handleCollabHistoryExport(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const { principal, session } = await this.host.loadProjectsContext(ctx);
    if (!this.host.config.distributed.gatewayPublicUrl || !principal || !session) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:collab.screen.unavailable"),
        show_alert: true,
      });
      return;
    }

    const history = await this.host.listGatewaySessionHistory(
      principal,
      session.sessionId,
    );
    const markdown = this.buildCollabHistoryMarkdown({
      locale,
      sessionLabel: session.label ?? session.sessionId,
      history,
    });
    const fileName = `collab-history-${slugifyFilenamePart(
      session.label ?? session.sessionId,
    ) || "session"}.md`;

    await this.host.replyDocumentWithRetry(
      ctx,
      new InputFile(Buffer.from(markdown, "utf8"), fileName),
      {
        caption: this.host.t(locale, "menu:history.caption", {
          sessionName: session.label ?? session.sessionId,
        }),
      },
      {
        kind: "menu",
        sessionId: session.sessionId,
      },
    );

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:collab.buttons.history"),
    });
  }

  public async showProjectDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
  ): Promise<void> {
    await this.showProjectMembers(ctx, input);
  }

  public async showProjectMembers(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
    options?: {
      filePath?: string;
    },
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      throw new Error("Telegram identity is unavailable.");
    }

    await this.host.ensureOpenedProjectIsActive({
      principal,
      sessionId: input.sessionId,
      projectUuid: input.projectUuid,
      projectName: input.projectName,
    });
    const screen = await this.buildProjectMembersScreen(input, options);
    if (ctx.callbackQuery?.message) {
      await this.host.editText(
        ctx,
        screen.text,
        { kind: "menu", sessionId: input.sessionId },
        { parse_mode: "HTML", reply_markup: screen.keyboard },
      );
      if (ctx.chat && "message_id" in ctx.callbackQuery.message) {
        await this.host.maintenanceStore.setProjectMenuViewState({
          sessionId: input.sessionId,
          projectUuid: input.projectUuid,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.callbackQuery.message.message_id,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    const sent = await this.host.replyText(
      ctx,
      screen.text,
      { kind: "menu", sessionId: input.sessionId },
      { parse_mode: "HTML", reply_markup: screen.keyboard },
    );
    if (sent && "message_id" in sent && ctx.chat) {
      await this.host.maintenanceStore.setProjectMenuViewState({
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        telegramChatId: ctx.chat.id,
        telegramMessageId: sent.message_id,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  public async showProjectMemberDetail(
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
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (principal) {
      await this.host.ensureOpenedProjectIsActive({
        principal,
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        projectName: input.projectName,
      });
      this.host.setCurrentAttachmentTargetForContext(ctx, {
        sessionId: input.sessionId,
        targetSessionId: input.targetSessionId,
        targetSessionLabel: input.targetSessionLabel,
        projectUuid: input.projectUuid,
      });
    }
    const session = await this.host.sessionStore.getSession(input.sessionId);
    const actor = this.host.getGatewayActorFromContext(ctx);
    const sourceClientUuid =
      this.host.config.distributed.gatewayPublicUrl && principal
        ? await this.host.ensureGatewayClientUuid(principal, actor)
        : null;

    const text = buildProjectMemberDetailText({
      projectName: input.projectName,
      sourceLabel: session?.label ?? input.sessionId,
      targetLabel: input.targetSessionLabel,
    });

    const payloadKey = await this.host.createProjectMemberMenuPayload(
      input.sessionId,
      input.projectUuid,
      input.targetSessionId,
      input.targetSessionLabel,
      {
        ...(input.targetClientUuid
          ? { targetClientUuid: input.targetClientUuid }
          : {}),
        ...(input.targetLocalSessionId
          ? { targetLocalSessionId: input.targetLocalSessionId }
          : {}),
      },
    );
    const keyboard = new InlineKeyboard()
      .text(this.host.t(locale, "menu:project.ask"), `project-member-note:question:${payloadKey}`)
      .text(this.host.t(locale, "menu:project.share_button"), `project-member-note:share:${payloadKey}`)
      .row();
    if (
      this.host.config.webapp.enabled &&
      this.host.config.distributed.gatewayPublicUrl &&
      sourceClientUuid &&
      input.targetClientUuid &&
      input.targetLocalSessionId
    ) {
      keyboard.text("🖥 Live", `project-member-live:${payloadKey}`).row();
    }
    keyboard.text(this.host.t(locale, "menu:project.back_to_members"), `project-members:${input.projectUuid}`);

    if (ctx.callbackQuery?.message) {
      if (principal && ctx.chat && "message_id" in ctx.callbackQuery.message) {
        this.host.webAppLaunchRegistry.set(
          principal.telegramUserId,
          input.sessionId,
          this.host.config.webapp.initDataTtlSeconds,
          {
            telegramChatId: ctx.chat.id,
            telegramMessageId: ctx.callbackQuery.message.message_id,
          },
        );
      }
      try {
        await this.host.editText(
          ctx,
          text,
          { kind: "menu", sessionId: input.sessionId },
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      } catch {
        await this.host.replyText(
          ctx,
          text,
          { kind: "menu", sessionId: input.sessionId },
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      }
      return;
    }

    const sent = await this.host.replyText(
      ctx,
      text,
      { kind: "menu", sessionId: input.sessionId },
      { parse_mode: "HTML", reply_markup: keyboard },
    );
    if (principal) {
      this.host.webAppLaunchRegistry.set(
        principal.telegramUserId,
        input.sessionId,
        this.host.config.webapp.initDataTtlSeconds,
        {
          ...(ctx.chat ? { telegramChatId: ctx.chat.id } : {}),
          ...(sent && "message_id" in sent
            ? { telegramMessageId: sent.message_id }
            : {}),
        },
      );
    }
  }

  public async showProjectMemberFiles(
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
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (principal) {
      await this.host.ensureOpenedProjectIsActive({
        principal,
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        projectName: input.projectName,
      });
    }

    const files = await this.host.listActiveSessionFiles(input.sessionId);
    const lines = [
      this.host.t(locale, "menu:project.file_title"),
      "",
      this.host.t(locale, "menu:project.file_project", {
        projectName: input.projectName,
      }),
      this.host.t(locale, "menu:project.file_recipient", {
        label: input.targetSessionLabel,
      }),
      "",
      files.length > 0
        ? this.host.t(locale, "menu:project.file_choose")
        : this.host.t(locale, "menu:project.file_none"),
    ];

    const keyboard = new InlineKeyboard();
    for (const filePath of files) {
      const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
        input.sessionId,
        filePath,
      );
      const label = this.host.formatFilePreviewLabel(filePath, meta).slice(0, 56);
      const payloadKey = await this.host.createProjectMemberMenuPayload(
        input.sessionId,
        input.projectUuid,
        input.targetSessionId,
        input.targetSessionLabel,
        {
          filePath,
          ...(input.targetClientUuid
            ? { targetClientUuid: input.targetClientUuid }
            : {}),
          ...(input.targetLocalSessionId
            ? { targetLocalSessionId: input.targetLocalSessionId }
            : {}),
        },
      );
      keyboard.text(label, `project-member-open:${payloadKey}`).row();
    }

    keyboard.text(
      this.host.t(locale, "menu:project.back_to_session"),
      `project-member-open:${await this.host.createProjectMemberMenuPayload(
        input.sessionId,
        input.projectUuid,
        input.targetSessionId,
        input.targetSessionLabel,
        {
          ...(input.targetClientUuid
            ? { targetClientUuid: input.targetClientUuid }
            : {}),
          ...(input.targetLocalSessionId
            ? { targetLocalSessionId: input.targetLocalSessionId }
            : {}),
        },
      )}`,
    );

    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      try {
        await this.host.editText(
          ctx,
          text,
          { kind: "menu", sessionId: input.sessionId },
          { reply_markup: keyboard },
        );
      } catch {
        await this.host.replyText(
          ctx,
          text,
          { kind: "menu", sessionId: input.sessionId },
          { reply_markup: keyboard },
        );
      }
      return;
    }

    await this.host.replyText(
      ctx,
      text,
      { kind: "menu", sessionId: input.sessionId },
      { reply_markup: keyboard },
    );
  }

  private async buildProjectMembersScreen(
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
    options?: {
      filePath?: string;
    },
  ): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const session = await this.host.sessionStore.getSession(input.sessionId);
    const binding = await this.host.bindingStore.getBinding(input.sessionId);
    if (!binding) {
      throw new Error("Binding is missing for project members screen.");
    }
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );
    const sessions = await this.host.listGatewayProjectSessions(
      {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      input.projectUuid,
    );
    const activeRelay = parseLiveRelaySessionId(input.sessionId);
    const activeSessionId =
      activeRelay?.localSessionId ?? session?.sessionId ?? null;
    const activeClientUuid = activeRelay?.clientUuid ?? null;
    const selectableMembers = sessions.filter(
      (item) =>
        item.local_session_id !== activeSessionId &&
        item.client_uuid !== activeClientUuid,
    );

    const lines = [
      this.host.t(locale, "menu:project.members_title", {
        projectName: escapeHtml(input.projectName),
      }),
      "",
      `UUID: ${input.projectUuid}`,
      `Invite: <code>${escapeHtml(input.inviteToken)}</code>`,
      "",
      this.host.t(locale, "menu:project.current_session", {
        sessionName: escapeHtml(session?.label ?? input.sessionId),
      }),
      this.host.t(locale, "menu:project.other_sessions", {
        count: selectableMembers.length,
      }),
      "",
      selectableMembers.length > 0
        ? options?.filePath
          ? this.host.t(locale, "menu:project.choose_file_target")
          : this.host.t(locale, "menu:project.choose_member_action")
        : this.host.t(locale, "menu:project.no_other_active"),
    ];

    const keyboard = new InlineKeyboard();
    for (const member of selectableMembers) {
      const sessionLabel = member.label?.trim() || member.local_session_id;
      const displayNameRaw = member.display_name?.trim() || null;
      const telegramUsernameRaw = member.telegram_username?.trim() || null;
      const systemUsernameRaw = member.system_username?.trim() || null;
      const clientLabelRaw = member.client_label?.trim() || null;
      const normalizedTelegramUsername =
        telegramUsernameRaw?.replace(/^@/u, "") || null;
      const primaryIdentity =
        displayNameRaw ||
        (normalizedTelegramUsername ? `@${normalizedTelegramUsername}` : null) ||
        clientLabelRaw ||
        systemUsernameRaw ||
        sessionLabel;
      const targetDisplayLabel =
        primaryIdentity !== sessionLabel
          ? `${primaryIdentity}/${sessionLabel}`
          : primaryIdentity;
      const payloadKey = await this.host.createProjectMemberMenuPayload(
        input.sessionId,
        input.projectUuid,
        member.session_uuid,
        targetDisplayLabel,
        {
          ...(options?.filePath ? { filePath: options.filePath } : {}),
          targetClientUuid: member.client_uuid,
          targetLocalSessionId: member.local_session_id,
        },
      );
      keyboard.text(targetDisplayLabel.slice(0, 56), `project-member-open:${payloadKey}`).row();
    }

    keyboard
      .text(this.host.t(locale, "menu:project.leave"), `project-leave:${input.projectUuid}`)
      .text(this.host.t(locale, "menu:project.back_to_projects"), "project-back");

    return { text: lines.join("\n"), keyboard };
  }
}
