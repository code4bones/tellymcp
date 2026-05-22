import { InlineKeyboard, InputFile } from "grammy";
import type { Menu } from "@grammyjs/menu";

import type { AppConfig } from "../../../app/config/env";
import type {
  PendingBroadcastRecord,
  PendingFileHandoffRecord,
  PendingRenameRecord,
  PendingPartnerNoteRecord,
  PendingProjectRecord,
  CurrentAttachmentTargetRecord,
  GatewayActorProfile,
  SendMessageMeta,
  TelegramEditMessageOptions,
  TelegramMenuContext,
  TelegramSendMessageOptions,
  TmuxCaptureScope,
} from "./transportTypes";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../api/storage/contract";
import type { SupportedLocale } from "../../i18n";
import type { Logger } from "../../lib/logger/logger";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import { buildPrincipalKey, formatTmuxBridgeError } from "./transportUtils";
import { isTmuxUnavailableError } from "../tmux/client";
import type { TransportLiveActions } from "./transportLiveActions";
import type { TransportMenuState } from "./transportMenuState";
import type { TransportProjectView } from "./transportProjectView";
import type { TransportTmuxActions } from "./transportTmuxActions";

export interface TransportMenuFlowHost {
  config: AppConfig;
  logger: Logger;
  bindingStore: SessionBindingStore;
  sessionStore: SessionStore;
  menuState: TransportMenuState;
  projectView: TransportProjectView;
  liveActions: TransportLiveActions;
  tmuxActions: TransportTmuxActions;
  pendingRenames: Map<string, PendingRenameRecord>;
  pendingBroadcasts: Map<string, PendingBroadcastRecord>;
  pendingPartnerNotes: Map<string, PendingPartnerNoteRecord>;
  pendingFileHandoffs: Map<string, PendingFileHandoffRecord>;
  pendingProjects: Map<string, PendingProjectRecord>;
  currentAttachmentTargets: Map<string, CurrentAttachmentTargetRecord>;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  ensureGatewayScopeConsolesBound?(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
  }): Promise<{ sessionIds: string[]; activeSessionId: string | null }>;
  getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined;
  t(
    locale: SupportedLocale,
    key: string,
    options?: Record<string, unknown>,
  ): string;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: SendMessageMeta,
    options?: TelegramSendMessageOptions,
  ): Promise<void | { message_id: number }>;
  editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: SendMessageMeta,
    options?: TelegramEditMessageOptions,
  ): Promise<void>;
  replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: {
      caption?: string;
      reply_markup?: InlineKeyboard | Menu<TelegramMenuContext>;
    },
    meta: SendMessageMeta,
  ): Promise<void>;
  captureRelaySessionBuffer(
    sessionId: string,
    scope: TmuxCaptureScope,
  ): Promise<{
    filename: string;
    markdown_content: string;
    capture_mode: TmuxCaptureScope["mode"];
    scope_description: string;
    terminal_target: string;
  }>;
}

export class TransportMenuFlow {
  public constructor(private readonly host: TransportMenuFlowHost) {}

  public async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (principal && this.host.ensureGatewayScopeConsolesBound) {
      await this.host.ensureGatewayScopeConsolesBound({ principal, ctx });
    }
    await this.host.menuState.showSessionsMenu(ctx, introText);
  }

  public async showStorageMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showStorageMenu(ctx, introText);
  }

  public async showBrowserMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showBrowserMenu(ctx, introText);
  }

  public async showScreenshotsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showScreenshotsMenu(ctx, introText);
  }

  public async showProjectsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.projectView.showProjectsMenu(ctx, introText);
  }

  public async showCollabToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.projectView.showCollabToolsMenu(ctx, introText);
  }

  public async handleCollabHistoryExport(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await this.host.projectView.handleCollabHistoryExport(ctx);
  }

  public async showCollabDeleteMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.projectView.showCollabDeleteMenu(ctx, introText);
  }

  public async showSettingsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showSettingsMenu(ctx, introText);
  }

  public async showBufferMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showBufferMenu(ctx, introText);
  }

  public async showDeveloperMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showDeveloperMenu(ctx, introText);
  }

  public async showDeveloperInfo(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showDeveloperInfo(ctx, introText);
  }

  public async showUnpairConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showUnpairConfirmMenu(ctx, introText);
  }

  public async showPruneConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    await this.host.menuState.showPruneConfirmMenu(ctx, introText);
  }

  public async renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, meta, {
        reply_markup: menu,
      });
      return;
    }

    await this.host.replyText(ctx, text, meta, {
      reply_markup: menu,
    });
  }

  public async renderMenuMarkdownScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, meta, {
        parse_mode: "MarkdownV2",
        reply_markup: menu,
      });
      return;
    }

    await this.host.replyText(ctx, text, meta, {
      parse_mode: "MarkdownV2",
      reply_markup: menu,
    });
  }

  public async renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, meta, {
        parse_mode: "HTML",
        reply_markup: menu,
      });
      return;
    }

    await this.host.replyText(ctx, text, meta, {
      parse_mode: "HTML",
      reply_markup: menu,
    });
  }

  public async showHelp(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:help.title"),
        "",
        this.host.t(locale, "menu:help.menu"),
        this.host.t(locale, "menu:help.help"),
        "",
        this.host.t(locale, "menu:help.how_it_works"),
        this.host.t(locale, "menu:help.step_choose"),
        this.host.t(locale, "menu:help.step_nudge"),
        this.host.t(locale, "menu:help.step_tools"),
      ].join("\n"),
      { kind: "menu" },
    );
  }

  public async showLiveViewLauncher(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.identity_unavailable"),
        show_alert: true,
      });
      return;
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    if (!this.host.liveActions.canRender()) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.webapp_disabled"),
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const actor = this.host.getGatewayActorFromContext(ctx);
    const sent = await this.host.liveActions.sendLauncherMessage({
      principal,
      sessionId: activeSessionId,
      sessionName: session?.label ?? activeSessionId,
      locale,
      ...(actor ? { actor } : {}),
    });
    if (!sent) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:live.errors.public_url_missing"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:live.actions.opening"),
    });
  }

  public clearPendingInteractionsForContext(ctx: TelegramMenuContext): void {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return;
    }

    const key = buildPrincipalKey(principal);
    this.host.pendingRenames.delete(key);
    this.host.pendingBroadcasts.delete(key);
    this.host.pendingPartnerNotes.delete(key);
    this.host.pendingFileHandoffs.delete(key);
    this.host.pendingProjects.delete(key);
  }

  public setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return;
    }

    const key = buildPrincipalKey(principal);
    if (target) {
      this.host.currentAttachmentTargets.set(key, target);
      return;
    }

    this.host.currentAttachmentTargets.delete(key);
  }

  public async sendActiveSessionBuffer(
    ctx: TelegramMenuContext,
    scope: TmuxCaptureScope,
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

    const relayTarget = parseLiveRelaySessionId(sessionId);
    const session = await this.host.sessionStore.getSession(sessionId);
    if (!relayTarget && !session?.tmuxTarget) {
      await ctx.answerCallbackQuery({
        text: "terminal target is not configured for this session.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: `Capturing ${this.host.tmuxActions.describeCaptureScope(scope)}...`,
    });

    try {
      const capture = relayTarget
        ? await this.host.captureRelaySessionBuffer(sessionId, scope)
        : await this.host.tmuxActions.captureBuffer(session!, scope);
      const relayMarkdownContent =
        relayTarget && "markdown_content" in capture
          ? capture.markdown_content
          : relayTarget &&
              "markdownContent" in (capture as Record<string, unknown>) &&
              typeof (capture as Record<string, unknown>).markdownContent === "string"
            ? ((capture as Record<string, unknown>).markdownContent as string)
            : null;
      const relayFilename =
        relayTarget && "filename" in capture && typeof capture.filename === "string"
          ? capture.filename
          : relayTarget &&
              "fileName" in (capture as Record<string, unknown>) &&
              typeof (capture as Record<string, unknown>).fileName === "string"
            ? ((capture as Record<string, unknown>).fileName as string)
            : null;

      if (relayTarget && typeof relayMarkdownContent !== "string") {
        throw new Error(
          `Invalid relay terminal buffer response: ${JSON.stringify(capture)}`,
        );
      }
      const finalRelayMarkdownContent = relayMarkdownContent ?? "";
      const finalRelayFilename = relayFilename ?? capture.filename;

      await this.host.replyDocumentWithRetry(
        ctx,
        new InputFile(
          "buffer" in capture
            ? capture.buffer
            : Buffer.from(finalRelayMarkdownContent, "utf8"),
          finalRelayFilename,
        ),
        {
          caption: `📄 Buffer: ${session?.label ?? sessionId}`,
        },
        {
          kind: "menu",
          sessionId,
        },
      );

      this.host.logger.info("Telegram terminal buffer sent", {
        sessionId,
        terminalTarget:
          "terminal_target" in capture ? capture.terminal_target : session?.tmuxTarget,
        filename: capture.filename,
        bytes:
          "buffer" in capture
            ? capture.buffer.length
            : Buffer.byteLength(finalRelayMarkdownContent, "utf8"),
        captureMode:
          "captureMode" in capture ? capture.captureMode : capture.capture_mode,
        captureScope:
          "scopeDescription" in capture
            ? capture.scopeDescription
            : capture.scope_description,
      });
    } catch (error) {
      const payload = {
        sessionId,
        terminalTarget: session?.tmuxTarget,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      };

      if (isTmuxUnavailableError(error)) {
        this.host.logger.warn(
          "terminal buffer capture skipped because terminal is unavailable",
          payload,
        );
        await this.host.replyText(
          ctx,
          formatTmuxBridgeError(
            this.host.config,
            error,
            "Unable to capture the terminal buffer right now.",
          ),
          { kind: "menu", sessionId },
        );
        return;
      }

      this.host.logger.error("terminal buffer capture failed", payload);
      await this.host.replyText(
        ctx,
        formatTmuxBridgeError(
          this.host.config,
          error,
          "Failed to capture the terminal buffer for this session.",
        ),
        { kind: "menu", sessionId },
      );
    }
  }

  public async buildSessionsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildSessionsMenuText(ctx);
  }

  public async buildBufferMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.host.menuState.buildBufferMenuText(ctx);
  }

  public async buildBrowserMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.host.menuState.buildBrowserMenuText(ctx);
  }

  public async buildSettingsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildSettingsMenuText(ctx);
  }

  public async buildScreenshotsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildScreenshotsMenuText(ctx);
  }

  public async buildStorageMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.host.menuState.buildStorageMenuText(ctx);
  }

  public async buildProjectsMenuText(ctx: TelegramMenuContext): Promise<string> {
    return this.host.projectView.buildProjectsMenuText(ctx);
  }

  public async buildCollabToolsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.projectView.buildCollabToolsMenuText(ctx);
  }

  public async buildCollabDeleteMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.projectView.buildCollabDeleteMenuText(ctx);
  }

  public async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildDeveloperMenuText(ctx);
  }

  public async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildUnpairConfirmText(ctx);
  }

  public async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    return this.host.menuState.buildPruneConfirmText(ctx);
  }

  public async showActiveSessionInfo(ctx: TelegramMenuContext): Promise<void> {
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
    const binding = await this.host.bindingStore.getBinding(sessionId);

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:session_info.opened"),
    });
    await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:session_info.title"),
        "",
        this.host.t(locale, "menu:session_info.label", {
          value: session?.label ?? sessionId,
        }),
        this.host.t(locale, "menu:session_info.session_id", {
          value: sessionId,
        }),
        this.host.t(locale, "menu:session_info.route", {
          value: binding
            ? this.host.t(locale, "menu:session_info.yes")
            : this.host.t(locale, "menu:session_info.no"),
        }),
      ].join("\n"),
      { kind: "menu", sessionId },
    );
  }
}
