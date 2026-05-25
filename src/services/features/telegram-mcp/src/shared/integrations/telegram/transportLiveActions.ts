import { URL } from "node:url";

import { buildLiveRelaySessionId, parseLiveRelaySessionId, resolveGatewayWebAppBaseUrl } from "../../../app/webapp/relay";
import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";
import type { GatewayActorProfile, SendMessageMeta, TelegramSendMessageOptions, WebAppLaunchMode } from "./transportTypes";
import { buildLiveLauncherText, buildLiveViewLaunchKeyboard, buildLiveViewUrlForSessionTarget, canRenderLiveView } from "./transportLive";
import { resolveWebAppPublicBaseUrl } from "./transportUtils";

export interface TransportLiveHost {
  config: AppConfig;
  webAppLaunchRegistry: WebAppLaunchRegistry;
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

    const sent = await this.host.sendChatMessage(
      input.principal.telegramChatId,
      buildLiveLauncherText({
        title: this.host.t(input.locale, "menu:live.screen.launcher_title", {
          sessionName: input.sessionName,
        }),
        chooseMode: this.host.t(input.locale, "menu:live.actions.choose_mode"),
      }),
      {
        reply_markup: this.buildKeyboard((mode) => {
          const modeUrl = new URL(url.toString());
          modeUrl.searchParams.set("launchMode", mode);
          return modeUrl.toString();
        }, input.locale),
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
}
