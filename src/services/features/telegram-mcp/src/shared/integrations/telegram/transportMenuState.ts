import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";
import type {
  CurrentAttachmentTargetRecord,
  TelegramMenuContext,
} from "./transportTypes";
import {
  buildBrowserMenuText,
  buildBufferMenuText,
  buildInboxMenuText,
  buildLinkMenuText,
  buildLocalMenuText,
  buildMainMenuText,
  buildPartnerMenuText,
  buildScreenshotsMenuText,
  buildSettingsMenuText,
  buildStorageMenuText,
} from "./transportMenuText";
import { escapeHtml, formatMenuTimestamp } from "./transportUtils";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportMenuStateHost {
  logger: Logger;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  getTmuxStatusLine(locale: SupportedLocale): Promise<string>;
  setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void;
  renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
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
    options?: { reply_markup?: unknown },
  ): Promise<void | { message_id: number }>;
  mainMenu: unknown;
  sessionsMenu: unknown;
  inboxMenu: unknown;
  storageMenu: unknown;
  browserMenu: unknown;
  screenshotsMenu: unknown;
  linkMenu: unknown;
  partnerMenu: unknown;
  localMenu: unknown;
  settingsMenu: unknown;
  bufferMenu: unknown;
  developerMenu: unknown;
  unpairConfirmMenu: unknown;
  pruneConfirmMenu: unknown;
  sessionStore: {
    getSession(sessionId: string): Promise<{
      sessionId: string;
      label?: string | undefined;
      linkedSessionId?: string | undefined;
      activeProjectName?: string | undefined;
      tmuxTarget?: string | undefined;
      updatedAt?: string | undefined;
    } | null>;
  };
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
    listBoundSessionIdsForPrincipal(principal: Principal): Promise<string[]>;
  };
  inboxStore: {
    countInboxMessages(sessionId: string): Promise<number>;
  };
  listActiveSessionScreenshots(sessionId: string): Promise<string[]>;
  listActiveSessionStorageEntries(
    sessionId: string,
  ): Promise<Array<{ filePath: string }>>;
}

export class TransportMenuState {
  public constructor(private readonly host: TransportMenuStateHost) {}

  public async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.mainMenu,
    );
  }

  public async buildMainMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const inboxCount = await this.host.inboxStore.countInboxMessages(activeSessionId);
    const sessionName = escapeHtml(session?.label ?? activeSessionId);
    const projectName = session?.activeProjectName
      ? escapeHtml(session.activeProjectName)
      : null;
    const linkedSession = session?.linkedSessionId
      ? await this.host.sessionStore.getSession(session.linkedSessionId)
      : null;
    return buildMainMenuText({
      title: this.host.t(locale, "menu:main.screen.title", { sessionName }),
      inboxMessagesLine: this.host.t(locale, "menu:main.screen.inbox_messages", {
        count: inboxCount,
      }),
      projectLine: projectName
        ? this.host.t(locale, "menu:main.screen.project", { projectName })
        : null,
      partnerLine: session?.linkedSessionId
        ? this.host.t(locale, "menu:main.screen.partner", {
            partnerName: escapeHtml(
              linkedSession?.label ?? session.linkedSessionId,
            ),
          })
        : null,
      partnerHintLine: session?.linkedSessionId
        ? this.host.t(locale, "menu:main.screen.partner_hint")
        : null,
      linkHintLine: session?.linkedSessionId
        ? null
        : this.host.t(locale, "menu:main.screen.link_hint"),
    });
  }

  public async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    try {
      const text = await this.buildSessionsMenuText(ctx);
      const intro = introText ? escapeHtml(introText) : null;
      await this.host.renderMenuHtmlScreen(
        ctx,
        intro ? `${intro}\n\n${text}` : text,
        { kind: "menu" },
        this.host.sessionsMenu,
      );
    } catch (error) {
      this.host.logger.error("Failed to render Telegram sessions menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      await this.host.replyText(
        ctx,
        this.host.t(
          await this.host.resolveLocaleForContext(ctx),
          "menu:system.sessions_menu_unavailable",
        ),
        { kind: "menu" },
      );
    }
  }

  public async buildSessionsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    const sessionIds = (
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
    ).sort();

    if (sessionIds.length === 0) {
      return this.host.t(locale, "menu:sessions.screen.no_linked_sessions");
    }

    let lastWorkedSession:
      | {
          sessionId: string;
          label?: string | undefined;
          updatedAt?: string | undefined;
        }
      | undefined;

    for (const sessionId of sessionIds) {
      const session = await this.host.sessionStore.getSession(sessionId);
      const sessionUpdatedAtMs = session?.updatedAt
        ? Date.parse(session.updatedAt)
        : Number.NEGATIVE_INFINITY;
      const lastWorkedUpdatedAtMs = lastWorkedSession?.updatedAt
        ? Date.parse(lastWorkedSession.updatedAt)
        : Number.NEGATIVE_INFINITY;

      if (sessionUpdatedAtMs >= lastWorkedUpdatedAtMs) {
        lastWorkedSession = {
          sessionId,
          label: session?.label,
          updatedAt: session?.updatedAt,
        };
      }
    }

    const lines = [this.host.t(locale, "menu:sessions.screen.title"), ""];
    if (lastWorkedSession) {
      lines.push(
        this.host.t(locale, "menu:sessions.screen.last_worked", {
          sessionName: escapeHtml(
            lastWorkedSession.label ?? lastWorkedSession.sessionId,
          ),
        }),
      );
      const formattedUpdatedAt = formatMenuTimestamp(lastWorkedSession.updatedAt);
      if (formattedUpdatedAt) {
        lines.push(
          this.host.t(locale, "menu:sessions.screen.updated", {
            timestamp: escapeHtml(formattedUpdatedAt),
          }),
        );
      }
      lines.push("");
    }

    if (activeSessionId) {
      const activeSession = await this.host.sessionStore.getSession(activeSessionId);
      lines.push(
        this.host.t(locale, "menu:sessions.screen.current_active", {
          sessionName: escapeHtml(activeSession?.label ?? activeSessionId),
        }),
      );
      lines.push("");
    }

    lines.push(`<i>${escapeHtml(await this.host.getTmuxStatusLine(locale))}</i>`);
    lines.push("");
    return lines.join("\n");
  }

  public async showInboxMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildInboxMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.inboxMenu,
    );
  }

  public async buildInboxMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const total = await this.host.inboxStore.countInboxMessages(activeSessionId);

    return buildInboxMenuText({
      title: this.host.t(locale, "menu:inbox.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:inbox.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedMessagesLine: this.host.t(locale, "menu:inbox.screen.stored_messages", {
        count: total,
      }),
      chooseMessageLine: this.host.t(locale, "menu:inbox.screen.choose_message"),
      emptyLine: this.host.t(locale, "menu:inbox.screen.empty"),
      total,
    });
  }

  public async showStorageMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildStorageMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.storageMenu,
    );
  }

  public async buildStorageMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const entries = await this.host.listActiveSessionStorageEntries(activeSessionId);

    return buildStorageMenuText({
      title: this.host.t(locale, "menu:storage.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:storage.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedFilesLine: this.host.t(locale, "menu:storage.screen.stored_files", {
        count: entries.length,
      }),
      chooseFileLine: this.host.t(locale, "menu:storage.screen.choose_file"),
      emptyLine: this.host.t(locale, "menu:storage.screen.empty"),
      total: entries.length,
    });
  }

  public async showBrowserMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBrowserMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.browserMenu,
    );
  }

  public async buildBrowserMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const screenshots = await this.host.listActiveSessionScreenshots(activeSessionId);

    return buildBrowserMenuText({
      title: this.host.t(locale, "menu:browser.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:browser.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedScreenshotsLine: this.host.t(
        locale,
        "menu:browser.screen.stored_screenshots",
        { count: screenshots.length },
      ),
      chooseActionLine: this.host.t(locale, "menu:browser.screen.choose_action"),
    });
  }

  public async showScreenshotsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildScreenshotsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.screenshotsMenu,
    );
  }

  public async buildScreenshotsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const files = await this.host.listActiveSessionScreenshots(activeSessionId);

    return buildScreenshotsMenuText({
      title: this.host.t(locale, "menu:screenshots.screen.title"),
      activeSessionLine: this.host.t(
        locale,
        "menu:screenshots.screen.active_session",
        {
          sessionName: session?.label ?? activeSessionId,
        },
      ),
      storedScreenshotsLine: this.host.t(
        locale,
        "menu:screenshots.screen.stored_screenshots",
        { count: files.length },
      ),
      chooseScreenshotLine: this.host.t(
        locale,
        "menu:screenshots.screen.choose_screenshot",
      ),
      emptyLine: this.host.t(locale, "menu:screenshots.screen.empty"),
      total: files.length,
    });
  }

  public async showLinkMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildLinkMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.linkMenu,
    );
  }

  public async buildLinkMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    return buildLinkMenuText({
      title: this.host.t(locale, "menu:link.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:link.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      choosePartnerLine: this.host.t(locale, "menu:link.screen.choose_partner"),
      hintLine: this.host.t(locale, "menu:link.screen.hint"),
    });
  }

  public async showPartnerMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (principal) {
      const sessionId =
        await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
      const session = sessionId
        ? await this.host.sessionStore.getSession(sessionId)
        : null;
      if (sessionId && session?.linkedSessionId) {
        const linkedSession = await this.host.sessionStore.getSession(
          session.linkedSessionId,
        );
        this.host.setCurrentAttachmentTargetForContext(ctx, {
          sessionId,
          targetSessionId: session.linkedSessionId,
          targetSessionLabel: linkedSession?.label ?? session.linkedSessionId,
        });
      } else {
        this.host.setCurrentAttachmentTargetForContext(ctx, null);
      }
    }
    const text = await this.buildPartnerMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.partnerMenu,
    );
  }

  public async buildPartnerMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    if (!session?.linkedSessionId) {
      return buildPartnerMenuText({
        title: this.host.t(locale, "menu:partner.screen.title"),
        activeSessionLine: this.host.t(locale, "menu:partner.screen.active_session", {
          sessionName: session?.label ?? activeSessionId,
        }),
        noPartnerLine: this.host.t(locale, "menu:partner.screen.no_partner"),
        useLinkFirstLine: this.host.t(locale, "menu:partner.screen.use_link_first"),
      });
    }

    const linkedSession = await this.host.sessionStore.getSession(
      session.linkedSessionId,
    );

    return buildPartnerMenuText({
      title: this.host.t(locale, "menu:partner.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:partner.screen.active_session", {
        sessionName: session.label ?? activeSessionId,
      }),
      linkedPartnerLine: this.host.t(locale, "menu:partner.screen.linked_partner", {
        partnerName: linkedSession?.label ?? session.linkedSessionId,
      }),
      promptHintLine: this.host.t(locale, "menu:partner.screen.prompt_hint"),
      promptFormatLine: this.host.t(locale, "menu:partner.screen.prompt_format"),
    });
  }

  public async showLocalMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildLocalMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.localMenu,
    );
  }

  public async buildLocalMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "menu:local.screen.unavailable");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "menu:local.screen.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const linkedSession = session?.linkedSessionId
      ? await this.host.sessionStore.getSession(session.linkedSessionId)
      : null;

    return buildLocalMenuText({
      title: this.host.t(locale, "menu:main.buttons.local"),
      activeSessionLine: this.host.t(locale, "menu:local.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      linkStatusLine: linkedSession?.label
        ? this.host.t(locale, "menu:local.screen.link_status", {
            linkedSessionName: linkedSession.label,
          })
        : this.host.t(locale, "menu:local.screen.link_status_none"),
      hintTitleLine: this.host.t(locale, "menu:local.screen.hint_title"),
      hintBodyLine: this.host.t(locale, "menu:local.screen.hint_body"),
    });
  }

  public async showSettingsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildSettingsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.settingsMenu,
    );
  }

  public async buildSettingsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return buildSettingsMenuText({
      title: this.host.t(locale, "menu:settings.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:settings.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      hintLine: this.host.t(locale, "menu:settings.screen.hint"),
    });
  }

  public async showBufferMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBufferMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.bufferMenu,
    );
  }

  public async buildBufferMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return buildBufferMenuText({
      title: this.host.t(locale, "menu:buffer.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:buffer.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      tmuxTargetLine: this.host.t(locale, "menu:buffer.screen.tmux_target", {
        tmuxTarget: session?.tmuxTarget ?? "not set",
      }),
      exportHintLine: this.host.t(locale, "menu:buffer.screen.export_hint"),
      exportModesLine: this.host.t(locale, "menu:buffer.screen.export_modes"),
    });
  }

  public async showDeveloperMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildDeveloperMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.developerMenu,
    );
  }

  public async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.host.t(locale, "menu:developer.screen.title"),
      "",
      this.host.t(locale, "menu:developer.screen.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.host.t(locale, "menu:developer.screen.broadcast_help"),
      this.host.t(locale, "menu:developer.screen.prune_help"),
    ].join("\n");
  }

  public async showUnpairConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildUnpairConfirmText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.unpairConfirmMenu,
    );
  }

  public async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return [
      this.host.t(locale, "menu:unpair.title"),
      "",
      this.host.t(locale, "menu:unpair.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      "",
      this.host.t(locale, "menu:unpair.body_1"),
      this.host.t(locale, "menu:unpair.body_2"),
    ].join("\n");
  }

  public async showPruneConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildPruneConfirmText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.pruneConfirmMenu,
    );
  }

  public async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.host.t(locale, "menu:prune.title"),
      "",
      this.host.t(locale, "menu:prune.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.host.t(locale, "menu:prune.body_1"),
      this.host.t(locale, "menu:prune.body_2"),
    ].join("\n");
  }
}
