import { InlineKeyboard } from "grammy";

import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type {
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import { createInboxMessageId } from "../../lib/ids/ids";
import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import { parsePartnerNoteText } from "./transportFormatting";
import type {
  PendingBroadcastRecord,
  PendingProjectBroadcastRemoteTarget,
  TelegramMenuContext,
} from "./transportTypes";
import { buildPrincipalKey } from "./transportUtils";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportBroadcastHost {
  logger: Logger;
  pendingBroadcasts: Map<string, PendingBroadcastRecord>;
  pendingRenames: Map<string, { sessionId: string }>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): Principal | null;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<"ru" | "en">;
  t(
    locale: "ru" | "en",
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: { reply_markup?: InlineKeyboard },
  ): Promise<{ message_id: number } | void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  showCollabToolsMenu(ctx: TelegramMenuContext): Promise<void>;
  showDeveloperMenu(ctx: TelegramMenuContext): Promise<void>;
  ensureGatewayClientUuid(principal: Principal): Promise<string>;
  listGatewayProjects(principal: Principal): Promise<Array<{ project_uuid: string; name: string }>>;
  listGatewayProjectSessions(
    principal: Principal,
    projectUuid: string,
  ): Promise<Array<{
    session_uuid: string;
    label?: string | null;
    client_uuid: string;
    local_session_id: string;
    project_uuid: string;
  }>>;
  bindingStore: {
    listBoundSessionIdsForPrincipal(principal: Principal): Promise<string[]>;
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
  };
  sessionStore: {
    getSession(sessionId: string): Promise<SessionContext | null>;
  };
  inboxStore: {
    createInboxMessage(message: TelegramInboxMessage): Promise<void>;
  };
  routeTelegramInboxToRelaySession(input: {
    ctx: TelegramMenuContext;
    principal: Principal;
    relayTarget: { clientUuid: string; localSessionId: string };
    sourceSessionId: string;
    messageText: string;
    attachments: [];
  }): Promise<void>;
  scheduleTmuxNudgeForInboxMessage(
    sessionId: string,
    session: SessionContext | null,
  ): void;
  sendPartnerNote(input: {
    session_id?: string;
    target_session_id: string;
    project_uuid?: string;
    kind: "request";
    summary: string;
    message: string;
    requires_reply: false;
  }): Promise<SendPartnerNoteOutput>;
}

export class TransportBroadcastActions {
  public constructor(private readonly host: TransportBroadcastHost) {}

  public async beginBroadcast(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionIds =
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);
    if (sessionIds.length === 0) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:broadcast.no_linked_sessions"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.host.pendingRenames.delete(principalKey);

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:broadcast.begin", { count: sessionIds.length }),
    });
    const sent = await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:broadcast.title"),
        "",
        this.host.t(locale, "menu:broadcast.body", { count: sessionIds.length }),
        this.host.t(locale, "menu:broadcast.hint"),
        this.host.t(locale, "menu:broadcast.cancel_hint"),
      ].join("\n"),
      { kind: "menu" },
      { reply_markup: new InlineKeyboard().text("Cancel", "broadcast-cancel") },
    );

    this.host.pendingBroadcasts.set(principalKey, {
      initiatedAt: new Date().toISOString(),
      scope: "linked",
      ...(sent ? { promptMessageId: sent.message_id } : {}),
      ...(ctx.callbackQuery?.message?.message_id
        ? { menuMessageId: ctx.callbackQuery.message.message_id }
        : {}),
    });
  }

  public async beginProjectBroadcast(ctx: TelegramMenuContext): Promise<void> {
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

    const projects = await this.host.listGatewayProjects(principal);
    if (projects.length === 0) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:broadcast.no_projects_first"),
        show_alert: true,
      });
      return;
    }

    const targets = await this.collectCollabBroadcastTargets(principal);
    const totalTargets =
      targets.localTargetSessionIds.length + targets.remoteTargets.length;
    if (totalTargets === 0) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:broadcast.no_collab_targets"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.host.pendingRenames.delete(principalKey);

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:broadcast.collab_begin", { count: totalTargets }),
    });
    const sent = await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:broadcast.collab_title"),
        "",
        this.host.t(locale, "menu:broadcast.collab_projects", { count: projects.length }),
        this.host.t(locale, "menu:broadcast.collab_sessions", { count: totalTargets }),
        "",
        this.host.t(locale, "menu:broadcast.collab_body"),
        this.host.t(locale, "menu:broadcast.collab_hint"),
        this.host.t(locale, "menu:broadcast.cancel_hint"),
      ].join("\n"),
      { kind: "menu", sessionId },
      { reply_markup: new InlineKeyboard().text("Cancel", "broadcast-cancel") },
    );

    this.host.pendingBroadcasts.set(principalKey, {
      initiatedAt: new Date().toISOString(),
      scope: "project",
      sessionId,
      localTargetSessionIds: targets.localTargetSessionIds,
      remoteTargets: targets.remoteTargets,
      ...(sent ? { promptMessageId: sent.message_id } : {}),
      ...(ctx.callbackQuery?.message?.message_id
        ? { menuMessageId: ctx.callbackQuery.message.message_id }
        : {}),
    });
  }

  public async cancelPendingBroadcast(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.host.pendingBroadcasts.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:broadcast.mode_not_active"),
        show_alert: true,
      });
      return;
    }

    this.host.pendingBroadcasts.delete(principalKey);
    await this.deletePendingBroadcastArtifacts(ctx, pending, false);
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:broadcast.cancelled"),
    });
    if (pending.scope === "project") {
      await this.host.showCollabToolsMenu(ctx);
      return;
    }
    await this.host.showDeveloperMenu(ctx);
  }

  public async handlePendingBroadcast(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.host.pendingBroadcasts.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.host.pendingBroadcasts.delete(principalKey);
      await this.deletePendingBroadcastArtifacts(ctx, pending, false);
      return false;
    }

    const broadcastText = text.trim();
    if (
      pending.scope === "linked" &&
      (await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)).length === 0
    ) {
      this.host.pendingBroadcasts.delete(principalKey);
      await this.deletePendingBroadcastArtifacts(ctx, pending, false);
      await this.host.replyText(
        ctx,
        "Broadcast cancelled because no linked sessions were found.",
        { kind: "menu" },
      );
      return true;
    }

    const receivedAt = new Date(
      ctx.message?.date ? ctx.message.date * 1000 : Date.now(),
    ).toISOString();
    let storedCount = 0;
    let remoteCount = 0;

    if (pending.scope === "project") {
      const parsed = parsePartnerNoteText(broadcastText);
      const sourceSession = pending.sessionId
        ? await this.host.sessionStore.getSession(pending.sessionId)
        : null;
      const sourceLabel = sourceSession?.label ?? pending.sessionId ?? "session";

      for (const sessionId of pending.localTargetSessionIds ?? []) {
        const inboxMessage: TelegramInboxMessage = {
          id: createInboxMessageId(),
          sessionId,
          telegramChatId: principal.telegramChatId,
          telegramUserId: principal.telegramUserId,
          sourceTelegramMessageId: ctx.message?.message_id ?? 0,
          text: [
            "Collab broadcast from Telegram user.",
            `Source session: ${sourceLabel}`,
            `Summary: ${parsed.summary}`,
            "",
            "Message:",
            parsed.message,
          ].join("\n"),
          receivedAt,
        };
        await this.host.inboxStore.createInboxMessage(inboxMessage);
        storedCount += 1;
        const session = await this.host.sessionStore.getSession(sessionId);
        try {
          this.host.scheduleTmuxNudgeForInboxMessage(sessionId, session);
        } catch (error) {
          this.host.logger.error("tmux nudge failed after project broadcast inbox capture", {
            sessionId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        }
      }

      for (const target of pending.remoteTargets ?? []) {
        await this.host.sendPartnerNote({
          target_session_id: target.sessionUuid,
          kind: "request",
          summary: parsed.summary,
          message: [
            "Collab broadcast from Telegram user.",
            ...(target.projectName ? [`Project: ${target.projectName}`] : []),
            `Source session: ${sourceLabel}`,
            "",
            "Message:",
            parsed.message,
          ].join("\n"),
          requires_reply: false,
          ...(pending.sessionId ? { session_id: pending.sessionId } : {}),
          ...(target.projectUuid ? { project_uuid: target.projectUuid } : {}),
        });
        remoteCount += 1;
      }
    } else {
      const sessionIds =
        await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);

      for (const sessionId of sessionIds) {
        const relayTarget = parseLiveRelaySessionId(sessionId);
        if (relayTarget) {
          try {
            await this.host.routeTelegramInboxToRelaySession({
              ctx,
              principal,
              relayTarget,
              sourceSessionId: sessionId,
              messageText: broadcastText,
              attachments: [],
            });
            remoteCount += 1;
            this.host.logger.info("Telegram broadcast routed to gateway relay session", {
              sessionId,
              chatId: principal.telegramChatId,
              userId: principal.telegramUserId,
              targetClientUuid: relayTarget.clientUuid,
              targetLocalSessionId: relayTarget.localSessionId,
              text: redactSecrets(broadcastText),
            });
            continue;
          } catch (error) {
            this.host.logger.error("Failed to route Telegram broadcast to gateway relay session", {
              sessionId,
              chatId: principal.telegramChatId,
              userId: principal.telegramUserId,
              targetClientUuid: relayTarget.clientUuid,
              targetLocalSessionId: relayTarget.localSessionId,
              error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
            continue;
          }
        }

        const inboxMessage: TelegramInboxMessage = {
          id: createInboxMessageId(),
          sessionId,
          telegramChatId: principal.telegramChatId,
          telegramUserId: principal.telegramUserId,
          sourceTelegramMessageId: ctx.message?.message_id ?? 0,
          text: broadcastText,
          receivedAt,
        };
        await this.host.inboxStore.createInboxMessage(inboxMessage);
        storedCount += 1;
        this.host.logger.info("Telegram broadcast message stored in inbox", {
          sessionId,
          chatId: principal.telegramChatId,
          userId: principal.telegramUserId,
          inboxMessageId: inboxMessage.id,
          text: redactSecrets(broadcastText),
        });
        const session = await this.host.sessionStore.getSession(sessionId);
        try {
          this.host.scheduleTmuxNudgeForInboxMessage(sessionId, session);
        } catch (error) {
          this.host.logger.error("tmux nudge failed after broadcast inbox capture", {
            sessionId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        }
      }
    }

    this.host.pendingBroadcasts.delete(principalKey);
    await this.deletePendingBroadcastArtifacts(ctx, pending, false);
    this.host.logger.info("Telegram broadcast completed", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
      scope: pending.scope,
      storedCount,
      remoteCount,
      sessionCount: storedCount + remoteCount,
      initiatedAt: pending.initiatedAt,
      text: redactSecrets(broadcastText),
    });
    const locale = await this.host.resolveLocaleForContext(ctx);
    await this.host.replyText(
      ctx,
      pending.scope === "project"
        ? [
            this.host.t(locale, "menu:broadcast.completed_collab", {
              count: storedCount + remoteCount,
            }),
            this.host.t(locale, "menu:broadcast.completed_collab_local", { count: storedCount }),
            this.host.t(locale, "menu:broadcast.completed_collab_remote", { count: remoteCount }),
            this.host.t(locale, "menu:broadcast.completed_collab_total", {
              count: storedCount + remoteCount,
            }),
          ].join("\n")
        : await this.host.tForContext(ctx, "menu:broadcast.completed_linked", {
            count: storedCount + remoteCount,
          }),
      { kind: "menu", ...(pending.sessionId ? { sessionId: pending.sessionId } : {}) },
    );
    return true;
  }

  private async collectCollabBroadcastTargets(
    principal: Principal,
  ): Promise<{
    localTargetSessionIds: string[];
    remoteTargets: PendingProjectBroadcastRemoteTarget[];
  }> {
    const currentClientUuid = await this.host.ensureGatewayClientUuid(principal);
    const projects = await this.host.listGatewayProjects(principal);
    const visibleLocalSessionIds = new Set(
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal),
    );
    const localTargetSessionIds: string[] = [];
    const remoteTargets: PendingProjectBroadcastRemoteTarget[] = [];
    const seenLogicalTargets = new Set<string>();

    for (const project of projects) {
      const projectSessions = await this.host.listGatewayProjectSessions(
        principal,
        project.project_uuid,
      );

      for (const item of projectSessions) {
        const logicalTargetKey = `${item.client_uuid}:${item.local_session_id}`;
        if (seenLogicalTargets.has(logicalTargetKey)) {
          continue;
        }
        seenLogicalTargets.add(logicalTargetKey);

        const isVisibleLocalSession =
          item.client_uuid === currentClientUuid &&
          visibleLocalSessionIds.has(item.local_session_id);
        if (isVisibleLocalSession) {
          localTargetSessionIds.push(item.local_session_id);
          continue;
        }

        remoteTargets.push({
          sessionUuid: item.session_uuid,
          sessionLabel: item.label?.trim() || item.local_session_id,
          clientUuid: item.client_uuid,
          localSessionId: item.local_session_id,
          projectUuid: item.project_uuid,
          ...(project.name ? { projectName: project.name } : {}),
        });
      }
    }

    return {
      localTargetSessionIds: [...new Set(localTargetSessionIds)].sort(),
      remoteTargets,
    };
  }

  public async listCollabBroadcastTargets(
    principal: Principal,
  ): Promise<{
    localTargetSessionIds: string[];
    remoteTargets: PendingProjectBroadcastRemoteTarget[];
  }> {
    return this.collectCollabBroadcastTargets(principal);
  }

  private async deletePendingBroadcastArtifacts(
    ctx: TelegramMenuContext,
    pending: PendingBroadcastRecord,
    deleteMenuMessage: boolean,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    for (const messageId of [
      pending.promptMessageId,
      ...(deleteMenuMessage ? [pending.menuMessageId] : []),
    ]) {
      if (!messageId) {
        continue;
      }
      try {
        await this.host.deleteMessage(chatId, messageId);
      } catch (error) {
        this.host.logger.warn("Failed to delete pending broadcast menu artifact", {
          chatId,
          messageId,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      }
    }
  }
}
