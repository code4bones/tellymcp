import { URL } from "node:url";

import { buildLiveRelaySessionId, parseLiveRelaySessionId, resolveGatewayWebAppBaseUrl } from "../../../app/webapp/relay";
import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry, WebAppSessionRegistry } from "../../../app/webapp/auth";
import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";
import type { GatewayActorProfile, SendMessageMeta, TelegramSendMessageOptions, WebAppLaunchMode, TelegramMenuContext } from "./transportTypes";
import { buildLiveLauncherText, buildLiveViewLaunchKeyboard, buildLiveViewUrlForSessionTarget, canRenderLiveView } from "./transportLive";
import { resolveWebAppPublicBaseUrl, escapeHtml } from "./transportUtils";
import { createMenuPayloadKey } from "../../lib/ids/ids";
import type { TelegramMenuPayloadStore } from "../../api/storage/contract";

export interface TransportLiveHost {
  menuPayloadStore: TelegramMenuPayloadStore;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  issueTerminalAttachCode?: (telegramUserId: number, sessionId: string) => Promise<{ code: string; expiresAt: number }>;
  config: AppConfig;
  webAppLaunchRegistry: WebAppLaunchRegistry;
  webAppSessions: WebAppSessionRegistry;
  logger: Logger;
  t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string;
  ensureGatewayClientUuid(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<string>;
  sendChatMessage(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions,
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }>;
}

export class TransportLiveActions {
  public constructor(private readonly host: TransportLiveHost) {}

  public canRender(): boolean {
    return canRenderLiveView(this.host.config);
  }

  public buildUrl(input: {
    targetSessionId: string;
    targetClientUuid?: string | undefined;
    targetLocalSessionId?: string | undefined;
    sourceClientUuid?: string | undefined;
    launchMode?: WebAppLaunchMode | undefined;
  }): string | null {
    return buildLiveViewUrlForSessionTarget({
      config: this.host.config,
      ...input,
    });
  }

  public buildKeyboard(
    getUrl: (mode: WebAppLaunchMode) => string | null,
    locale: SupportedLocale = "en",
  ) {
    return buildLiveViewLaunchKeyboard({
      getUrl,
      labels: {
        fullscreen: this.host.t(locale, "menu:live.buttons.fullscreen"),
        expand: this.host.t(locale, "menu:live.buttons.expand"),
        default: this.host.t(locale, "menu:live.buttons.default"),
      },
    });
  }

  public async sendLauncherMessage(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sessionName: string;
    locale: SupportedLocale;
    actor?: GatewayActorProfile;
    allowForeignBinding?: boolean;
  }): Promise<{ message_id: number } | null> {
    if (!canRenderLiveView(this.host.config)) {
      return null;
    }

    const useGatewayRelay =
      this.host.config.distributed.mode === "client" &&
      Boolean(this.host.config.distributed.gatewayPublicUrl);
    const clientUuid = useGatewayRelay
      ? await this.host.ensureGatewayClientUuid(input.principal, input.actor)
      : null;
    const baseUrl = useGatewayRelay
      ? resolveGatewayWebAppBaseUrl(
          this.host.config.distributed.gatewayPublicUrl!,
          this.host.config.webapp.basePath,
        )
      : resolveWebAppPublicBaseUrl(this.host.config);
    if (!baseUrl) {
      return null;
    }

    const relayTarget = parseLiveRelaySessionId(input.sessionId);
    const allowForeignBinding =
      input.allowForeignBinding === true || Boolean(relayTarget);

    const resolvedLiveSessionId =
      useGatewayRelay && clientUuid && !input.sessionId.startsWith("relay~")
        ? buildLiveRelaySessionId(clientUuid, input.sessionId)
        : input.sessionId;
    const url = new URL(`${baseUrl}/live/${encodeURIComponent(resolvedLiveSessionId)}`);
    url.searchParams.set("launchMode", this.host.config.webapp.launchMode);

    const directBrowserToken = this.host.webAppSessions.create(
      resolvedLiveSessionId,
      input.principal.telegramUserId,
      this.host.config.webapp.sessionTtlSeconds,
    ).token;
    const directBrowserUrl = new URL(
      `${baseUrl}/live/${encodeURIComponent(resolvedLiveSessionId)}`,
    );
    directBrowserUrl.searchParams.set("token", directBrowserToken);

    const keyboard = this.buildKeyboard((mode) => {
      const modeUrl = new URL(url.toString());
      modeUrl.searchParams.set("launchMode", mode);
      return modeUrl.toString();
    }, input.locale);
    keyboard
      .row()
      .url(
        this.host.t(input.locale, "menu:live.buttons.open_in_browser"),
        directBrowserUrl.toString(),
      );
    if (this.host.config.distributed.mode !== "client" && this.host.issueTerminalAttachCode) {
      const key = createMenuPayloadKey();
      const now = Date.now();
      await this.host.menuPayloadStore.createMenuPayload({
        key, kind: "terminal-attach", sessionId: input.sessionId,
        telegramUserId: input.principal.telegramUserId,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
      }, 86400);
      keyboard.text(this.host.t(input.locale, "menu:live.buttons.attach"), "terminal-attach:" + key);
    }

    const sent = await this.host.sendChatMessage(
      input.principal.telegramChatId,
      buildLiveLauncherText({
        title: this.host.t(input.locale, "menu:live.screen.launcher_title", {
          sessionName: input.sessionName,
        }),
        chooseMode: this.host.t(input.locale, "menu:live.actions.choose_mode"),
      }),
      {
        reply_markup: keyboard,
      },
      {
        kind: "notification",
        sessionId: input.sessionId,
      },
    );

    this.host.webAppLaunchRegistry.set(
      input.principal.telegramUserId,
      input.sessionId,
      this.host.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: input.principal.telegramChatId,
        ...(allowForeignBinding ? { allowForeignBinding: true } : {}),
        telegramMessageId: sent.message_id,
      },
    );

    return sent;
  }

  public async handleAttachCallback(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const key = ctx.callbackQuery?.data?.slice("terminal-attach:".length);
    const payload = key ? await this.host.menuPayloadStore.getMenuPayload(key) : null;
    if (!payload || payload.kind !== "terminal-attach" || !payload.sessionId ||
      payload.telegramUserId !== ctx.from?.id || Date.parse(payload.expiresAt) <= Date.now() ||
      !this.host.issueTerminalAttachCode) {
      await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:live.attach.denied"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: this.host.t(locale, "menu:live.attach.creating") });
    try {
      const result = await this.host.issueTerminalAttachCode(ctx.from!.id, payload.sessionId);
      const command = "tellymcp attach --code " + result.code;
      const gatewayUrl = this.host.config.distributed.gatewayPublicUrl;
      const publicUrl = gatewayUrl ? new URL(gatewayUrl) : null;
      if (publicUrl) { publicUrl.username = ""; publicUrl.password = ""; publicUrl.search = ""; publicUrl.hash = ""; }
      const withGateway = publicUrl ? command + " --gateway " + publicUrl.toString().replace(/\/$/u, "") : command;
      // Always private, even if the Live launcher was posted in a group.
      await this.host.sendChatMessage(ctx.from!.id,
        escapeHtml(this.host.t(locale, "menu:live.attach.instructions")) +
          "\n\n<code>" + escapeHtml(command) + "</code>" +
          (withGateway !== command ? "\n\n<code>" + escapeHtml(withGateway) + "</code>" : ""),
        { parse_mode: "HTML" }, { kind: "notification", sessionId: payload.sessionId });
    } catch {
      await this.host.sendChatMessage(ctx.from!.id, this.host.t(locale, "menu:live.attach.failed"),
        {}, { kind: "notification", sessionId: payload.sessionId });
    }
  }
}
