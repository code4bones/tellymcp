import { Menu, MenuRange } from "@grammyjs/menu";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

import type {
  SessionBindingStore,
  SessionStore,
  TelegramInboxStore,
} from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import { readMenuPayloadKey } from "./transportUtils";
import type {
  TelegramInboxMessage,
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type {
  TelegramMenuContext,
  TmuxCaptureScope,
} from "./transportTypes";

function splitSessionDisplayLabel(input: {
  sessionId: string;
  sessionLabel?: string;
}): {
  shortLabel: string;
  ownerLabel: string | null;
} {
  const label = (input.sessionLabel?.trim() || input.sessionId.trim() || "session").trim();
  const separator = " · ";
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex <= 0) {
    return {
      shortLabel: label,
      ownerLabel: null,
    };
  }

  return {
    shortLabel: label.slice(0, separatorIndex).trim() || label,
    ownerLabel: label.slice(separatorIndex + separator.length).trim() || null,
  };
}

export interface TransportMenuFactoriesHost {
  logger: Logger;
  bindingStore: SessionBindingStore;
  inboxStore: TelegramInboxStore;
  sessionStore: SessionStore;
  createMenuOptions(
    onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> };
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null;
  buildMainMenuFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildInboxFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildStorageFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildScreenshotsFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildSessionsFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildLinkFingerprint(ctx: TelegramMenuContext): Promise<string>;
  buildInboxButtonLabel(ctx: TelegramMenuContext): Promise<string>;
  buildScreenshotsButtonLabel(ctx: TelegramMenuContext): Promise<string>;
  buildLinkButtonLabel(ctx: TelegramMenuContext): Promise<string>;
  showLiveViewLauncher(ctx: TelegramMenuContext): Promise<void>;
  showBufferMenu(ctx: TelegramMenuContext): Promise<void>;
  showBrowserMenu(ctx: TelegramMenuContext): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext): Promise<void>;
  showLocalEntryPoint(ctx: TelegramMenuContext): Promise<void>;
  showProjectsEntryPoint(ctx: TelegramMenuContext): Promise<void>;
  showInboxMenu(ctx: TelegramMenuContext): Promise<void>;
  showStorageMenu(ctx: TelegramMenuContext): Promise<void>;
  showSettingsMenu(ctx: TelegramMenuContext): Promise<void>;
  showSessionsMenu(ctx: TelegramMenuContext): Promise<void>;
  showScreenshotsMenu(ctx: TelegramMenuContext): Promise<void>;
  showLocalMenu(ctx: TelegramMenuContext): Promise<void>;
  showLinkMenu(ctx: TelegramMenuContext): Promise<void>;
  showPartnerMenu(ctx: TelegramMenuContext): Promise<void>;
  showPartnerEntryPoint(ctx: TelegramMenuContext): Promise<void>;
  handleLinkButton(ctx: TelegramMenuContext): Promise<void>;
  handleLinkTargetSelect(ctx: TelegramMenuContext): Promise<void>;
  beginPartnerNoteMode(
    ctx: TelegramMenuContext,
    kind: "question" | "share",
  ): Promise<void>;
  sendActiveSessionBuffer(
    ctx: TelegramMenuContext,
    input: TmuxCaptureScope,
  ): Promise<void>;
  showUnpairConfirmMenu(ctx: TelegramMenuContext): Promise<void>;
  showDeveloperMenu(ctx: TelegramMenuContext): Promise<void>;
  showPruneConfirmMenu(ctx: TelegramMenuContext): Promise<void>;
  showActiveSessionInfo(ctx: TelegramMenuContext): Promise<void>;
  beginRenameActiveSession(ctx: TelegramMenuContext): Promise<void>;
  beginBroadcast(ctx: TelegramMenuContext): Promise<void>;
  pruneAllSessions(ctx: TelegramMenuContext): Promise<void>;
  unpairActiveSession(ctx: TelegramMenuContext): Promise<void>;
  handleInboxMessageOpen(ctx: TelegramMenuContext): Promise<void>;
  handleInboxMessageDelete(ctx: TelegramMenuContext): Promise<void>;
  handleStorageOpen(ctx: TelegramMenuContext): Promise<void>;
  handleStorageGet(ctx: TelegramMenuContext): Promise<void>;
  handleStorageDelete(ctx: TelegramMenuContext): Promise<void>;
  handleScreenshotOpen(ctx: TelegramMenuContext): Promise<void>;
  handleScreenshotGet(ctx: TelegramMenuContext): Promise<void>;
  handleScreenshotDelete(ctx: TelegramMenuContext): Promise<void>;
  handleSessionSelection(ctx: TelegramMenuContext): Promise<void>;
  handleSessionGroupSelection(ctx: TelegramMenuContext): Promise<void>;
  getMenuPayloadByKey(key: string): Promise<Record<string, unknown> | null>;
  createInboxMenuPayload(sessionId: string, messageId: string): Promise<string>;
  createFileMenuPayload(sessionId: string, filePath: string): Promise<string>;
  createSessionMenuPayload(
    sessionId: string,
    ownerLabel?: string,
    ownerKey?: string,
  ): Promise<string>;
  createSessionGroupMenuPayload(ownerLabel: string, ownerKey?: string): Promise<string>;
  createLinkMenuPayload(
    sessionId: string,
    targetSessionId: string,
  ): Promise<string>;
  formatInboxPreviewLabel(message: TelegramInboxMessage): string;
  formatStoragePreviewLabel(
    filePath: string,
    meta?: TelegramXchangeFileMeta | null,
  ): string;
  formatFilePreviewLabel(filePath: string): string;
  formatSessionMenuLabel(input: {
    sessionId: string;
    sessionLabel?: string;
    active: boolean;
    inboxCount: number;
  }): string;
  listActiveSessionStorageEntries(sessionId: string): Promise<
    Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  >;
  listActiveSessionScreenshots(sessionId: string): Promise<string[]>;
}

export class TransportMenuFactories {
  public constructor(private readonly host: TransportMenuFactoriesHost) {}

  public createMainMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-main-menu", {
      fingerprint: async (ctx) => this.host.buildMainMenuFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showMainMenu(ctx)),
    })
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.live"),
        async (ctx) => {
          await this.host.showLiveViewLauncher(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.content"),
        async (ctx) => {
          await this.host.sendActiveSessionBuffer(ctx, { mode: "visible" });
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.browser"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:main.actions.open_browser"),
          });
          await this.host.showBrowserMenu(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.collab"),
        async (ctx) => {
          await this.host.showProjectsEntryPoint(ctx);
        },
      )
      .row()
      .text(async (ctx) => this.host.buildInboxButtonLabel(ctx), async (ctx) => {
        this.host.logger.debug("Telegram main menu inbox navigation requested", {
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
        });
        await ctx.answerCallbackQuery({
          text: await this.host.tForContext(ctx, "menu:main.actions.open_inbox"),
        });
        await this.host.showInboxMenu(ctx);
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.storage"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:main.actions.open_storage"),
          });
          await this.host.showStorageMenu(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.settings"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:main.actions.open_settings"),
          });
          await this.host.showSettingsMenu(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:main.buttons.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:main.actions.back_to_sessions",
            ),
          });
          await this.host.showSessionsMenu(ctx);
        },
      );
  }

  public createBrowserMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-browser-menu",
      this.host.createMenuOptions((ctx) => this.host.showBrowserMenu(ctx)),
    )
      .text(async (ctx) => this.host.buildScreenshotsButtonLabel(ctx), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.host.tForContext(
            ctx,
            "menu:browser.actions.open_screenshots",
          ),
        });
        await this.host.showScreenshotsMenu(ctx);
      })
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:browser.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createLocalMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-local-menu",
      this.host.createMenuOptions((ctx) => this.host.showLocalMenu(ctx)),
    )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:local.buttons.partner"),
        async (ctx) => {
          await this.host.showPartnerEntryPoint(ctx);
        },
      )
      .text(async (ctx) => this.host.buildLinkButtonLabel(ctx), async (ctx) => {
        await this.host.handleLinkButton(ctx);
      })
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:local.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createLinkMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-link-menu", {
      fingerprint: async (ctx) => this.host.buildLinkFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showLinkMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.host.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const activeSessionId =
          await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!activeSessionId) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.no_active_session",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const sessionIds = (
          await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
        )
          .filter((sessionId) => sessionId !== activeSessionId)
          .sort();

        if (sessionIds.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:link.labels.no_partner_sessions"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:link.actions.no_partner_sessions",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        for (const sessionId of sessionIds) {
          const session = await this.host.sessionStore.getSession(sessionId);
          range
            .text(
              {
                text: `🔗 ${session?.label ?? sessionId}`,
                payload: async () =>
                  this.host.createLinkMenuPayload(activeSessionId, sessionId),
              },
              async (innerCtx) => {
                await this.host.handleLinkTargetSelect(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:link.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createPartnerMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-partner-menu",
      this.host.createMenuOptions((ctx) => this.host.showPartnerMenu(ctx)),
    )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:partner.buttons.ask"),
        async (ctx) => {
          await this.host.beginPartnerNoteMode(ctx, "question");
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:partner.buttons.share"),
        async (ctx) => {
          await this.host.beginPartnerNoteMode(ctx, "share");
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:partner.buttons.unlink"),
        async (ctx) => {
          await this.host.handleLinkButton(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:partner.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createBufferMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-buffer-menu",
      this.host.createMenuOptions((ctx) => this.host.showBufferMenu(ctx)),
    )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:buffer.buttons.visible"),
        async (ctx) => {
          await this.host.sendActiveSessionBuffer(ctx, { mode: "visible" });
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:buffer.buttons.full"),
        async (ctx) => {
          await this.host.sendActiveSessionBuffer(ctx, { mode: "full" });
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:buffer.buttons.last_300"),
        async (ctx) => {
          await this.host.sendActiveSessionBuffer(ctx, {
            mode: "lines",
            lines: 300,
          });
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:buffer.buttons.last_1000"),
        async (ctx) => {
          await this.host.sendActiveSessionBuffer(ctx, {
            mode: "lines",
            lines: 1000,
          });
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:local.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createSettingsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-settings-menu",
      this.host.createMenuOptions((ctx) => this.host.showSettingsMenu(ctx)),
    )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:settings.buttons.info"),
        async (ctx) => {
          await this.host.showActiveSessionInfo(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:settings.buttons.rename"),
        async (ctx) => {
          await this.host.beginRenameActiveSession(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:settings.buttons.unpair"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:settings.actions.confirm_unpair",
            ),
          });
          await this.host.showUnpairConfirmMenu(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:local.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createDeveloperMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-developer-menu",
      this.host.createMenuOptions((ctx) => this.host.showDeveloperMenu(ctx)),
    )
      .text("📣 Broadcast", async (ctx) => {
        await this.host.beginBroadcast(ctx);
      })
      .row()
      .text("🧹 Prune all", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Confirm prune." });
        await this.host.showPruneConfirmMenu(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to sessions." });
        await this.host.showSessionsMenu(ctx);
      });
  }

  public createUnpairConfirmMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-unpair-confirm-menu",
      this.host.createMenuOptions((ctx) => this.host.showUnpairConfirmMenu(ctx)),
    )
      .text(
        async (ctx) =>
          this.host.tForContext(ctx, "menu:settings.buttons.confirm_unpair"),
        async (ctx) => {
          await this.host.unpairActiveSession(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:settings.actions.back_to_settings",
            ),
          });
          await this.host.showSettingsMenu(ctx);
        },
      );
  }

  public createPruneConfirmMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-prune-confirm-menu",
      this.host.createMenuOptions((ctx) => this.host.showPruneConfirmMenu(ctx)),
    )
      .text("⚠ Confirm prune", async (ctx) => {
        await this.host.pruneAllSessions(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to tools." });
        await this.host.showDeveloperMenu(ctx);
      });
  }

  public createInboxMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-menu", {
      fingerprint: async (ctx) => this.host.buildInboxFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showInboxMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.host.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const sessionId =
          await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.no_active_session",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const inboxMessages = await this.host.inboxStore.listInboxMessages(
          sessionId,
          10,
        );

        if (inboxMessages.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:inbox.labels.empty"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(innerCtx, "menu:inbox.actions.empty"),
                show_alert: false,
              });
            },
          );
          return range;
        }

        for (const message of inboxMessages) {
          range
            .text(
              {
                text: this.host.formatInboxPreviewLabel(message),
                payload: async () =>
                  this.host.createInboxMenuPayload(message.sessionId, message.id),
              },
              async (innerCtx) => {
                await this.host.handleInboxMessageOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.refresh"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:inbox.actions.refreshed"),
          });
          await this.host.showInboxMenu(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:local.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createStorageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-storage-menu", {
      fingerprint: async (ctx) => this.host.buildStorageFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showStorageMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.host.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const sessionId =
          await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.no_active_session",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const entries = await this.host.listActiveSessionStorageEntries(sessionId);
        if (entries.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:storage.labels.empty"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(innerCtx, "menu:storage.actions.empty"),
              });
            },
          );
          return range;
        }

        for (const entry of entries) {
          range
            .text(
              {
                text: this.host.formatStoragePreviewLabel(entry.filePath, entry.meta),
                payload: async () =>
                  this.host.createFileMenuPayload(sessionId, entry.filePath),
              },
              async (innerCtx) => {
                await this.host.handleStorageOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.refresh"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:storage.actions.refreshed"),
          });
          await this.host.showStorageMenu(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:local.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createScreenshotsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-screenshots-menu", {
      fingerprint: async (ctx) => this.host.buildScreenshotsFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showScreenshotsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.host.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const sessionId =
          await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "common:errors.no_active_session",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const filePaths = await this.host.listActiveSessionScreenshots(sessionId);
        if (filePaths.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:screenshots.labels.empty"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:screenshots.actions.empty",
                ),
              });
            },
          );
          return range;
        }

        for (const filePath of filePaths) {
          range
            .text(
              {
                text: this.host.formatFilePreviewLabel(filePath),
                payload: async () =>
                  this.host.createFileMenuPayload(sessionId, filePath),
              },
              async (innerCtx) => {
                await this.host.handleScreenshotOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.refresh"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:screenshots.actions.refreshed",
            ),
          });
          await this.host.showScreenshotsMenu(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:browser.actions.back_to_browser_menu",
            ),
          });
          await this.host.showBrowserMenu(ctx);
        },
      );
  }

  public createSessionsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-sessions-menu", {
      fingerprint: async (ctx) => this.host.buildSessionsFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showSessionsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        try {
          const principal = this.host.getPrincipalFromContext(ctx);
          if (!principal) {
            range.text(
              await this.host.tForContext(ctx, "common:menu.no_telegram_identity_label"),
              async (innerCtx) => {
                await innerCtx.answerCallbackQuery({
                  text: await this.host.tForContext(
                    innerCtx,
                    "common:errors.missing_telegram_context",
                  ),
                  show_alert: true,
                });
              },
            );
            return range;
          }

          const activeSessionId =
            await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
          const sessionIds = (
            await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
          ).sort();

          if (sessionIds.length === 0) {
            range.text(
              await this.host.tForContext(
                ctx,
                "menu:sessions.labels.no_linked_sessions",
              ),
              async (innerCtx) => {
                await innerCtx.answerCallbackQuery({
                  text: await this.host.tForContext(
                    innerCtx,
                    "menu:sessions.actions.no_linked_sessions",
                  ),
                  show_alert: true,
                });
              },
            );
            return range;
          }

          const groupedSessions = new Map<
            string,
            Array<{
              sessionId: string;
              sessionLabel?: string;
              ownerLabel?: string;
              active: boolean;
              inboxCount: number;
              sortKey: string;
            }>
          >();

          for (const sessionId of sessionIds) {
            const session = await this.host.sessionStore.getSession(sessionId);
            const inboxCount =
              await this.host.inboxStore.countInboxMessages(sessionId);
            const display = splitSessionDisplayLabel({
              sessionId,
              ...(session?.label ? { sessionLabel: session.label } : {}),
            });
            const groupKey =
              parseLiveRelaySessionId(sessionId)?.clientUuid ??
              display.ownerLabel ??
              sessionId;
            const items = groupedSessions.get(groupKey) ?? [];
            items.push({
              sessionId,
              ...(display.shortLabel ? { sessionLabel: display.shortLabel } : {}),
              ...(display.ownerLabel ? { ownerLabel: display.ownerLabel } : {}),
              active: sessionId === activeSessionId,
              inboxCount,
              sortKey: `${display.shortLabel}\u0000${sessionId}`,
            });
            groupedSessions.set(groupKey, items);
          }

          const currentPayloadKey = readMenuPayloadKey(ctx);
          let selectedOwnerLabel: string | null = null;
          if (currentPayloadKey) {
            const payload = await this.host.getMenuPayloadByKey(currentPayloadKey);
            if (
              payload &&
              (payload.kind === "session-group" ||
                payload.kind === "active-session") &&
              typeof payload.ownerKey === "string"
            ) {
              selectedOwnerLabel = payload.ownerKey;
            }
          }

          const sortedGroups = [...groupedSessions.entries()].sort((left, right) => {
            const leftKey = left[0] || "\uffff";
            const rightKey = right[0] || "\uffff";
            return leftKey.localeCompare(rightKey);
          });

          if (!selectedOwnerLabel) {
            for (const [groupKey, items] of sortedGroups) {
              const title =
                items[0]?.ownerLabel ||
                (items.length === 1 ? items[0]?.sessionLabel : null) ||
                "Sessions";
              range.text(
                {
                  text: `👤 ${title}`.slice(0, 56),
                  payload: async () =>
                    this.host.createSessionGroupMenuPayload(title, groupKey),
                },
                async (innerCtx) => {
                  await this.host.handleSessionGroupSelection(innerCtx);
                },
              );
              range.row();
            }
            return range;
          }

          for (const [groupKey, items] of sortedGroups) {
            if (groupKey !== selectedOwnerLabel) {
              continue;
            }
            items.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
            for (const item of items) {
              range.text(
                {
                  text: this.host.formatSessionMenuLabel({
                    sessionId: item.sessionId,
                    active: item.active,
                    inboxCount: item.inboxCount,
                    ...(item.sessionLabel ? { sessionLabel: item.sessionLabel } : {}),
                  }),
                  payload: async () =>
                    this.host.createSessionMenuPayload(
                      item.sessionId,
                      item.ownerLabel ?? items[0]?.ownerLabel ?? undefined,
                      selectedOwnerLabel ?? groupKey,
                    ),
                },
                async (innerCtx) => {
                  await this.host.handleSessionSelection(innerCtx);
                },
              );
              range.row();
            }
            break;
          }

          return range;
        } catch (error) {
          this.host.logger.error("Failed to build Telegram sessions menu", {
            chatId: ctx.chat?.id,
            userId: ctx.from?.id,
            error:
              error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
          range.text(
            await this.host.tForContext(ctx, "menu:sessions.labels.unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:sessions.actions.unavailable",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }
      })
      .text(
        {
          text: async (ctx) => this.host.tForContext(ctx, "common:menu.refresh"),
          payload: async (ctx) => {
            const currentPayloadKey = readMenuPayloadKey(ctx);
            if (!currentPayloadKey) {
              return "refresh";
            }
            const payload = await this.host.getMenuPayloadByKey(currentPayloadKey);
            if (
              payload &&
              payload.kind === "session-group" &&
              typeof payload.ownerKey === "string"
            ) {
              return currentPayloadKey;
            }
            return "refresh";
          },
        },
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:sessions.actions.refreshed"),
          });
          await this.host.showSessionsMenu(ctx);
        },
      )
      .text(
        {
          text: async (ctx) => this.host.tForContext(ctx, "menu:sessions.labels.tools"),
          payload: async (ctx) => {
            const currentPayloadKey = readMenuPayloadKey(ctx);
            if (!currentPayloadKey) {
              return "tools";
            }
            const payload = await this.host.getMenuPayloadByKey(currentPayloadKey);
            if (
              payload &&
              payload.kind === "session-group" &&
              typeof payload.ownerKey === "string"
            ) {
              return currentPayloadKey;
            }
            return "tools";
          },
        },
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:sessions.actions.open_tools",
            ),
          });
          await this.host.showDeveloperMenu(ctx);
        },
      );
  }

  public createInboxMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.host.createMenuOptions((ctx) => this.host.showInboxMenu(ctx)),
    })
      .text(
        {
          text: async (ctx) => this.host.tForContext(ctx, "common:menu.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.host.handleInboxMessageDelete(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.close"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "common:menu.close"),
          });
          await ctx.deleteMessage();
        },
      );
  }

  public createStorageMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-storage-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.host.createMenuOptions((ctx) => this.host.showStorageMenu(ctx)),
    })
      .text(
        {
          text: async (ctx) => this.host.tForContext(ctx, "common:menu.get"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.host.handleStorageGet(ctx);
        },
      )
      .text(
        {
          text: async (ctx) =>
            this.host.tForContext(ctx, "menu:storage.buttons.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.host.handleStorageDelete(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:storage.actions.back_to_storage",
            ),
          });
          await this.host.showStorageMenu(ctx);
        },
      );
  }

  public createScreenshotMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-screenshot-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.host.createMenuOptions((ctx) => this.host.showScreenshotsMenu(ctx)),
    })
      .text(
        {
          text: async (ctx) => this.host.tForContext(ctx, "menu:storage.buttons.get"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.host.handleScreenshotGet(ctx);
        },
      )
      .text(
        {
          text: async (ctx) =>
            this.host.tForContext(ctx, "menu:storage.buttons.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.host.handleScreenshotDelete(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:screenshots.actions.back_to_screenshots",
            ),
          });
          await this.host.showScreenshotsMenu(ctx);
        },
      );
  }
}
