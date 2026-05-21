import { InlineKeyboard } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import {
  buildLiveRelaySessionId,
  resolveGatewayWebAppBaseUrl,
} from "../../../app/webapp/relay";
import { resolveWebAppPublicBaseUrl } from "./transportUtils";
import type { WebAppLaunchMode } from "./transportTypes";

export function canRenderLiveView(config: AppConfig): boolean {
  return Boolean(
    config.webapp.enabled &&
      (config.webapp.publicUrl || config.distributed.gatewayPublicUrl),
  );
}

export function buildLiveViewUrlForSessionTarget(input: {
  config: AppConfig;
  targetSessionId: string;
  targetClientUuid?: string | undefined;
  targetLocalSessionId?: string | undefined;
  sourceClientUuid?: string | undefined;
  launchMode?: WebAppLaunchMode | undefined;
}): string | null {
  const { config } = input;
  if (!canRenderLiveView(config)) {
    return null;
  }

  const canUseRelay =
    Boolean(input.targetClientUuid) &&
    Boolean(input.targetLocalSessionId) &&
    Boolean(config.distributed.gatewayPublicUrl);
  const baseUrl = canUseRelay
    ? resolveGatewayWebAppBaseUrl(
        config.distributed.gatewayPublicUrl!,
        config.webapp.basePath,
      )
    : resolveWebAppPublicBaseUrl(config);
  if (!baseUrl) {
    return null;
  }

  const liveSessionId = canUseRelay
    ? buildLiveRelaySessionId(
        input.targetClientUuid!,
        input.targetLocalSessionId!,
        input.sourceClientUuid,
      )
    : (input.targetLocalSessionId ?? input.targetSessionId);
  const url = new URL(`${baseUrl}/live/${encodeURIComponent(liveSessionId)}`);
  url.searchParams.set("launchMode", input.launchMode ?? config.webapp.launchMode);
  return url.toString();
}

export function buildLiveViewLaunchKeyboard(input: {
  getUrl: (mode: WebAppLaunchMode) => string | null;
  labels: Record<WebAppLaunchMode, string>;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const modes: Array<{ mode: WebAppLaunchMode; label: string }> = [
    { mode: "fullscreen", label: input.labels.fullscreen },
    { mode: "expand", label: input.labels.expand },
    { mode: "default", label: input.labels.default },
  ];

  for (const [index, { mode, label }] of modes.entries()) {
    const url = input.getUrl(mode);
    if (!url) {
      continue;
    }
    keyboard.webApp(label, url);
    if (index === 1) {
      keyboard.row();
    }
  }

  return keyboard;
}

export function buildLiveLauncherText(input: {
  title: string;
  chooseMode: string;
}): string {
  return [input.title, "", input.chooseMode].join("\n");
}
