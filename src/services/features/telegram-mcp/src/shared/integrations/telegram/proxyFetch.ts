import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import type { AppConfig } from "../../../app/config/env";
import type { Logger } from "../../lib/logger/logger";
import { bypassTellyProxy, tellyFetch } from "../../lib/http/tellyProxy";

type FetchAgent = HttpsProxyAgent<string> | SocksProxyAgent;
type TelegramBaseFetchConfig = Omit<
  NonNullable<Parameters<typeof fetch>[1]>,
  "method" | "headers" | "body"
> & {
  agent?: FetchAgent;
};

function maskProxyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) {
      url.username = "[REDACTED]";
    }
    if (url.password) {
      url.password = "[REDACTED]";
    }
    return url.toString();
  } catch {
    return "[INVALID_PROXY_URL]";
  }
}

export function createTelegramBaseFetchConfig(
  config: AppConfig,
  logger: Logger,
): TelegramBaseFetchConfig {
  const bypass = bypassTellyProxy(new URL("https://api.telegram.org"), process.env.TELLYMCP_NO_PROXY);
  const agent: FetchAgent | undefined = config.telegram.proxy && !bypass
    ? config.telegram.proxy.type === "http"
      ? new HttpsProxyAgent(config.telegram.proxy.url)
      : new SocksProxyAgent(config.telegram.proxy.url)
    : undefined;

  if (config.telegram.proxy) {
    logger.info("Telegram proxy configured", {
      proxyType: config.telegram.proxy.type,
      proxyUrl: maskProxyUrl(config.telegram.proxy.url),
    });
  } else {
    logger.debug("Telegram proxy disabled");
  }
  return agent ? { agent } : {};
}

export function createTelegramFetch(
  config: AppConfig,
  logger: Logger,
): typeof globalThis.fetch {
  const baseFetchConfig = createTelegramBaseFetchConfig(config, logger);
  if (config.telegram.proxy?.type === "http") {
    return (input, init) => tellyFetch(input, init, {
      httpProxy: config.telegram.proxy?.url,
      noProxy: process.env.TELLYMCP_NO_PROXY,
    });
  }
  return async (input, init) =>
    globalThis.fetch(input, {
      ...baseFetchConfig,
      ...(init ?? {}),
    });
}
