import { InlineKeyboard } from "grammy";
import { Menu, MenuRange } from "@grammyjs/menu";

import { escapeHtml, extractCallbackSuffix, readMenuPayloadKey } from "./transportUtils";
import type {
  TelegramMenuContext,
  TelegramRichMessage,
  RichMessageReplyMarkup,
  SendMessageMeta,
} from "./transportTypes";
import type { TelegramMenuPayloadStore } from "../../api/storage/contract";
import type { SupportedLocale } from "../../i18n";
import type { InboxMessageSummary, InboxRouteSummary } from "./transportInboxState";

type Principal = { telegramChatId: number; telegramUserId: number };

type InboxRoutePayload = {
  kind: "inbox-route-entry";
  sessionId: string;
  namespace: string;
  routeKey: string;
};

type InboxMessagePayload = {
  kind: "inbox-message-entry";
  sessionId: string;
  namespace: string;
  routeKey: string;
  messageId: string;
};

export interface TransportInboxMenusHost {
  createMenuOptions(
    onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> };
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, unknown>,
  ): string;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, unknown>,
  ): Promise<string>;
  menuPayloadStore: TelegramMenuPayloadStore;
  createInboxRouteMenuPayload(
    sessionId: string,
    namespace: string,
    routeKey: string,
  ): Promise<string>;
  createInboxMessageMenuPayload(
    sessionId: string,
    namespace: string,
    routeKey: string,
    messageId: string,
  ): Promise<string>;
  buildInboxRoutesFingerprint(ctx: TelegramMenuContext): Promise<string>;
  loadInboxRoutesContext(ctx: TelegramMenuContext): Promise<{
    principal: Principal | null;
    sessionId: string | null;
    routes: InboxRouteSummary[] | null;
  }>;
  listInboxMessages(
    principal: Principal,
    namespace: string,
    routeKey: string,
  ): Promise<InboxMessageSummary[]>;
  bindCurrentSessionToRoute(
    principal: Principal,
    sessionId: string,
    namespace: string,
    routeKey: string,
  ): Promise<void>;
  resolveInboxMessage(
    messageId: string,
    decision: "approve" | "reject" | "defer",
    principal: Principal,
    sessionId: string,
  ): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext): Promise<void>;
  // Backed by a ref object set after createInboxMenu() runs -- mirrors the
  // agentMenuRef pattern wiring uses for the same self-reference problem
  // (this class builds the Menu AND is the one that later renders it).
  getInboxMenu(): unknown;
  renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  editText(
    ctx: TelegramMenuContext,
    text: string | TelegramRichMessage,
    meta: { kind: "menu"; sessionId?: string },
    options?: Record<string, unknown>,
  ): Promise<void>;
  sendRichMessage(
    telegramChatId: number,
    content: TelegramRichMessage,
    replyMarkup: RichMessageReplyMarkup,
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: Record<string, unknown>,
  ): Promise<{ message_id: number } | void>;
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: "menu:externalInbox.status.pending",
  processing: "menu:externalInbox.status.pending",
  offered: "menu:externalInbox.status.offered",
  awaiting_route_binding: "menu:externalInbox.status.offered",
  deferred: "menu:externalInbox.status.deferred",
  no_live_session: "menu:externalInbox.status.no_live_session",
  failed: "menu:externalInbox.status.failed",
  delivering: "menu:externalInbox.status.pending",
};

// Labels and errors are literal text; the description itself remains Markdown.
function escapeRichMarkdownText(text: string): string {
  return escapeHtml(text).replace(/[\\`*_{}[\]()#+.!|~=$-]/gu, "\\$&");
}

// Generic by design -- this is a view over whatever (namespace, route_key)
// pairs have messages addressed to the viewer, not a Marrow-specific
// screen. See TELLYMCP_INBOX_INTEGRATION.md for why that boundary matters.
export class TransportInboxMenus {
  public constructor(private readonly host: TransportInboxMenusHost) {}

  private async isSelectedSession(
    ctx: TelegramMenuContext,
    sessionId: string,
  ): Promise<boolean> {
    const current = await this.host.loadInboxRoutesContext(ctx);
    if (current.principal && current.sessionId === sessionId) {
      return true;
    }
    await ctx.answerCallbackQuery({
      text: await this.host.tForContext(ctx, "menu:externalInbox.data_stale"),
      show_alert: true,
    });
    return false;
  }

  public createInboxMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-menu", {
      fingerprint: async (ctx) => this.host.buildInboxRoutesFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.showInboxMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const { principal, sessionId, routes } =
          await this.host.loadInboxRoutesContext(ctx);

        if (!principal) {
          range
            .text(await this.host.tForContext(ctx, "common:errors.no_telegram_identity"))
            .row();
          return range;
        }
        if (!sessionId) {
          range
            .text(await this.host.tForContext(ctx, "common:errors.no_active_session"))
            .row();
          return range;
        }
        if (!routes || routes.length === 0) {
          range.text(await this.host.tForContext(ctx, "menu:externalInbox.labels.empty")).row();
          return range;
        }

        for (const route of routes) {
          range
            .text(
              {
                text: `📥 ${route.namespace}:${route.routeKey} (${route.count})`,
                payload: async () =>
                  this.host.createInboxRouteMenuPayload(
                    sessionId,
                    route.namespace,
                    route.routeKey,
                  ),
              },
              async (innerCtx) => {
                await this.handleInboxRouteSelect(innerCtx);
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
            text: await this.host.tForContext(ctx, "menu:externalInbox.actions.back_to_session_menu"),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public async showInboxMenu(ctx: TelegramMenuContext, introText?: string): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const text = this.host.t(locale, "menu:externalInbox.screen.title");
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getInboxMenu(),
    );
  }

  private async handleInboxRouteSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    const payload = payloadKey
      ? await this.host.menuPayloadStore.getMenuPayload(payloadKey)
      : null;
    if (!payload || payload.kind !== "inbox-route-entry" || !payload.sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:externalInbox.data_stale"),
        show_alert: true,
      });
      return;
    }
    const route = payload as unknown as InboxRoutePayload;

    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    if (!(await this.isSelectedSession(ctx, route.sessionId))) {
      return;
    }
    try {
      await this.showInboxRouteMessages(ctx, route);
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: String(error instanceof Error ? error.message : error),
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:externalInbox.actions.bound", {
        route: `${route.namespace}:${route.routeKey}`,
      }),
    });
  }

  private async showInboxRouteMessages(
    ctx: TelegramMenuContext,
    route: InboxRoutePayload,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      throw new Error("Telegram identity is unavailable.");
    }

    await this.host.bindCurrentSessionToRoute(
      principal,
      route.sessionId,
      route.namespace,
      route.routeKey,
    );

    const messages = await this.host.listInboxMessages(
      principal,
      route.namespace,
      route.routeKey,
    );

    const lines = [
      this.host.t(locale, "menu:externalInbox.route_screen.title", {
        route: `${route.namespace}:${route.routeKey}`,
      }),
      "",
      messages.length > 0
        ? this.host.t(locale, "menu:externalInbox.route_screen.pick_one")
        : this.host.t(locale, "menu:externalInbox.route_screen.empty"),
    ];

    const keyboard = new InlineKeyboard();
    for (const message of messages) {
      const statusLabel = this.host.t(
        locale,
        STATUS_LABEL_KEYS[message.status] ?? "menu:externalInbox.status.pending",
      );
      const buttonLabel = `${statusLabel} ${message.title}`.slice(0, 60);
      const payloadKey = await this.host.createInboxMessageMenuPayload(
        route.sessionId,
        route.namespace,
        route.routeKey,
        message.id,
      );
      keyboard.text(buttonLabel, `inbox-message-open:${payloadKey}`).row();
    }
    keyboard
      .text(
        await this.host.tForContext(ctx, "common:menu.back"),
        "inbox-route-back:routes",
      )
      .row();

    await this.renderScreen(ctx, lines.join("\n"), route.sessionId, keyboard);
  }

  public async handleInboxMessageOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const payloadKey = extractCallbackSuffix(ctx, "inbox-message-open:");
    const payload = payloadKey
      ? await this.host.menuPayloadStore.getMenuPayload(payloadKey)
      : null;
    if (!payload || payload.kind !== "inbox-message-entry" || !payload.messageId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:externalInbox.data_stale"),
        show_alert: true,
      });
      return;
    }
    const message = payload as unknown as InboxMessagePayload;
    if (!(await this.isSelectedSession(ctx, message.sessionId))) {
      return;
    }
    try {
      await this.showInboxMessageDetail(ctx, message);
      await ctx.answerCallbackQuery();
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: String(error instanceof Error ? error.message : error),
        show_alert: true,
      });
    }
  }

  private async showInboxMessageDetail(
    ctx: TelegramMenuContext,
    message: InboxMessagePayload,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      throw new Error("Telegram identity is unavailable.");
    }

    const messages = await this.host.listInboxMessages(
      principal,
      message.namespace,
      message.routeKey,
    );
    const current = messages.find((item) => item.id === message.messageId);
    if (!current) {
      throw new Error(this.host.t(locale, "menu:externalInbox.data_stale"));
    }

    await this.host.bindCurrentSessionToRoute(
      principal,
      message.sessionId,
      message.namespace,
      message.routeKey,
    );

    const richMessage: TelegramRichMessage = {
      markdown: [
        `### ${escapeRichMarkdownText(current.title.replace(/\r?\n/gu, " "))}`,
        ...(current.summary ? [current.summary] : []),
        ...(current.statusReason
          ? [`> ${escapeRichMarkdownText(current.statusReason).replace(/\n/gu, "\n> ")}`]
          : []),
        "---",
        escapeRichMarkdownText(
          this.host.t(locale, "menu:externalInbox.message_screen.resource", {
            kind: current.resourceKind,
            id: current.resourceId,
          }),
        ),
      ].join("\n\n"),
    };

    const payloadKey = await this.host.createInboxMessageMenuPayload(
      message.sessionId,
      message.namespace,
      message.routeKey,
      message.messageId,
    );
    const routePayloadKey = await this.host.createInboxRouteMenuPayload(
      message.sessionId,
      message.namespace,
      message.routeKey,
    );
    const keyboard = new InlineKeyboard()
      .text(
        await this.host.tForContext(ctx, "menu:externalInbox.buttons.approve"),
        `inbox-decision:approve:${payloadKey}`,
      )
      .text(
        await this.host.tForContext(ctx, "menu:externalInbox.buttons.reject"),
        `inbox-decision:reject:${payloadKey}`,
      )
      .row()
      .text(
        await this.host.tForContext(ctx, "menu:externalInbox.buttons.postpone"),
        `inbox-decision:defer:${payloadKey}`,
      )
      .row()
      .text(
        await this.host.tForContext(ctx, "common:menu.back"),
        `inbox-route-back:${routePayloadKey}`,
      );

    const meta = { kind: "menu" as const, sessionId: message.sessionId };
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, richMessage, meta, { reply_markup: keyboard });
    } else {
      await this.host.sendRichMessage(
        principal.telegramChatId, richMessage, keyboard, meta,
      );
    }
  }

  public async handleInboxDecisionCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^inbox-decision:(approve|reject|defer):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:externalInbox.data_stale"),
        show_alert: true,
      });
      return;
    }
    const decision = match[1] as "approve" | "reject" | "defer";
    const payloadKey = match[2]!;
    const payload = await this.host.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "inbox-message-entry" || !payload.messageId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:externalInbox.data_stale"),
        show_alert: true,
      });
      return;
    }
    const message = payload as unknown as InboxMessagePayload;
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal || !(await this.isSelectedSession(ctx, message.sessionId))) {
      return;
    }

    try {
      await this.host.resolveInboxMessage(
        message.messageId,
        decision,
        principal,
        message.sessionId,
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message : String(error),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.host.t(
        locale,
        `menu:externalInbox.actions.${decision === "defer" ? "deferred" : `${decision}d`}`,
      ),
    });
    await this.showInboxRouteMessages(ctx, {
      kind: "inbox-route-entry",
      sessionId: message.sessionId,
      namespace: message.namespace,
      routeKey: message.routeKey,
    });
  }

  public async handleInboxRouteBackCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const suffix = extractCallbackSuffix(ctx, "inbox-route-back:");
    const locale = await this.host.resolveLocaleForContext(ctx);
    if (suffix === "routes") {
      await this.showInboxMenu(ctx);
      await ctx.answerCallbackQuery();
      return;
    }
    const payload = suffix
      ? await this.host.menuPayloadStore.getMenuPayload(suffix)
      : null;
    const route =
      payload?.kind === "inbox-route-entry"
        ? (payload as unknown as InboxRoutePayload)
        : null;
    const [legacyNamespace, legacyRouteKey] = suffix?.split("\u0000") ?? [];
    const namespace = route?.namespace ?? legacyNamespace;
    const routeKey = route?.routeKey ?? legacyRouteKey;
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!suffix || !namespace || !routeKey || !principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:externalInbox.data_stale"),
        show_alert: true,
      });
      return;
    }

    if (route && !(await this.isSelectedSession(ctx, route.sessionId))) {
      return;
    }
    const sessionId =
      route?.sessionId ??
      (await this.host.loadInboxRoutesContext(ctx)).sessionId ?? undefined;
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    try {
      await this.showInboxRouteMessages(ctx, {
        kind: "inbox-route-entry",
        sessionId,
        namespace,
        routeKey,
      });
      await ctx.answerCallbackQuery();
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: String(error instanceof Error ? error.message : error),
        show_alert: true,
      });
    }
  }

  private async renderScreen(
    ctx: TelegramMenuContext,
    text: string,
    sessionId: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.host.editText(ctx, text, { kind: "menu", sessionId }, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    }
    await this.host.replyText(ctx, text, { kind: "menu", sessionId }, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}
