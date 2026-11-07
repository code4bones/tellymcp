import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent, ProxyAgent, Dispatcher } from "undici";

export type TellyProxySettings = {
  httpProxy?: string | undefined;
  noProxy?: string | undefined;
};

let directDispatcher: Agent | undefined;
const proxyDispatchers = new Map<string, ProxyAgent>();
const nodeAgents = new Map<string, HttpAgent>();

export function readTellyProxySettings(): TellyProxySettings {
  return {
    httpProxy: process.env.TELLYMCP_HTTP_PROXY?.trim(),
    noProxy: process.env.TELLYMCP_NO_PROXY?.trim(),
  };
}

export function bypassTellyProxy(url: URL, noProxy?: string): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const port = url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
  return (noProxy ?? "").split(/[\s,]+/u).some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;
    const parts = rule.startsWith("[")
      ? /^\[([^\]]+)\](?::(\d+))?$/u.exec(rule)
      : /^([^:]+)(?::(\d+))?$/u.exec(rule);
    const host = parts?.[1] ?? rule;
    const rulePort = parts?.[2];
    if (rulePort && rulePort !== port) return false;
    if (host.startsWith(".") || host.startsWith("*.")) {
      const domain = host.replace(/^\*?\./u, "");
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }
    return hostname === host;
  });
}

export function resolveTellyProxy(
  url: URL,
  settings: TellyProxySettings = readTellyProxySettings(),
): string | undefined {
  return settings.httpProxy && !bypassTellyProxy(url, settings.noProxy)
    ? settings.httpProxy
    : undefined;
}

function getDispatcher(url: URL, settings: TellyProxySettings): Dispatcher {
  const proxy = resolveTellyProxy(url, settings);
  if (proxy) {
    let agent = proxyDispatchers.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      proxyDispatchers.set(proxy, agent);
    }
    return agent;
  }
  directDispatcher ??= new Agent();
  return directDispatcher;
}

class TellyDispatcher extends Dispatcher {
  public constructor(private readonly settings: TellyProxySettings) { super(); }

  public override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    // Native fetch dispatches each redirect separately. Recheck bypass rules
    // against that origin instead of retaining the first request's proxy.
    return getDispatcher(new URL(String(options.origin)), this.settings).dispatch(options, handler);
  }
}

export function tellyFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
  settings: TellyProxySettings = readTellyProxySettings(),
): ReturnType<typeof globalThis.fetch> {
  const dispatcher = new TellyDispatcher(settings);
  // Set a dispatcher per request, never the global one used by agent SDKs.
  // Node bundles a separate Undici 7 type snapshot with different patch-level
  // methods; the dispatch protocol is compatible (covered by socket tests).
  const options: RequestInit = {
    ...init,
    dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
  };
  return globalThis.fetch(input, options);
}

export function getTellyWebSocketAgent(
  url: string,
  settings?: TellyProxySettings,
): HttpAgent {
  const target = new URL(url);
  const proxy = resolveTellyProxy(target, settings);
  const key = proxy ?? (target.protocol === "wss:" ? "direct:https" : "direct:http");
  let agent = nodeAgents.get(key);
  if (!agent) {
    agent = proxy
      ? new HttpsProxyAgent(proxy)
      : target.protocol === "wss:"
        ? new HttpsAgent()
        : new HttpAgent();
    nodeAgents.set(key, agent);
  }
  return agent;
}

export async function closeTellyProxyAgents(): Promise<void> {
  const dispatchers = [...proxyDispatchers.values(), ...(directDispatcher ? [directDispatcher] : [])];
  proxyDispatchers.clear();
  directDispatcher = undefined;
  for (const agent of nodeAgents.values()) agent.destroy();
  nodeAgents.clear();
  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
}
