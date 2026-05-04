import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import type { AppConfig } from "../../../app/config/env.js";
import type { Logger } from "../../lib/logger/logger.js";

type FetchAgent = HttpsProxyAgent<string> | SocksProxyAgent;

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

export function createTelegramFetch(
  config: AppConfig,
  logger: Logger,
): typeof globalThis.fetch {
  if (!config.telegram.proxy) {
    logger.debug("Telegram proxy disabled");
    return globalThis.fetch.bind(globalThis);
  }

  const agent: FetchAgent =
    config.telegram.proxy.type === "http"
      ? new HttpsProxyAgent(config.telegram.proxy.url)
      : new SocksProxyAgent(config.telegram.proxy.url);

  logger.info("Telegram proxy configured", {
    proxyType: config.telegram.proxy.type,
    proxyUrl: maskProxyUrl(config.telegram.proxy.url),
  });

  const proxiedFetch = async (...args: Parameters<typeof globalThis.fetch>) => {
    const [input, init] = args;
    const requestInit = {
      ...(init ? (init as Record<string, unknown>) : {}),
      agent,
    };

    return fetch(
      input as string | URL,
      requestInit as import("node-fetch").RequestInit,
    ) as unknown as Response;
  };

  return proxiedFetch as typeof globalThis.fetch;
}
