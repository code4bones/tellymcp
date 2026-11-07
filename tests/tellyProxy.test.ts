import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  bypassTellyProxy,
  closeTellyProxyAgents,
  getTellyWebSocketAgent,
  tellyFetch,
} from "../src/services/features/telegram-mcp/src/shared/lib/http/tellyProxy";

describe("Telly-scoped proxy routing", () => {
  let target: Server;
  let proxy: Server;
  let wsServer: WebSocketServer;
  let targetPort: number;
  let proxyPort: number;
  let proxyRequests: number;
  let proxyTargets: string[];
  let lastProxyAuthorization: string | undefined;
  const sockets = new Set<Socket>();

  async function listen(server: Server): Promise<number> {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    return address.port;
  }

  beforeEach(async () => {
    proxyRequests = 0;
    proxyTargets = [];
    lastProxyAuthorization = undefined;
    target = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname === "/redirect") {
        res.writeHead(302, { location: url.searchParams.get("to")! });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          body,
          authorization: req.headers.authorization ?? null,
          proxyAuthorization: req.headers["proxy-authorization"] ?? null,
        }));
      });
    });
    wsServer = new WebSocketServer({ noServer: true });
    target.on("upgrade", (req, socket, head) => {
      wsServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        ws.send(req.headers.authorization ?? "no authorization");
      });
    });
    targetPort = await listen(target);
    proxy = createServer((req, res) => {
      proxyRequests += 1;
      proxyTargets.push(new URL(req.url!).host);
      lastProxyAuthorization = req.headers["proxy-authorization"];
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      const destination = new URL(req.url!);
      const upstream = request({
        host: "127.0.0.1", port: targetPort,
        path: destination.pathname + destination.search, method: req.method, headers,
      }, (reply) => {
        res.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxy.on("connect", (req, clientSocket, head) => {
      proxyRequests += 1;
      proxyTargets.push(req.url!);
      lastProxyAuthorization = req.headers["proxy-authorization"];
      const upstream = connect(targetPort, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => upstream.destroy());
    });
    proxyPort = await listen(proxy);
    vi.stubEnv("TELLYMCP_HTTP_PROXY", `http://telly:secret@127.0.0.1:${proxyPort}`);
    vi.stubEnv("TELLYMCP_NO_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "http://parent-agent.invalid:1");
    vi.stubEnv("NO_PROXY", "*");
  });

  afterEach(async () => {
    for (const client of wsServer.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await closeTellyProxyAgents();
    await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    wsServer.close();
    vi.unstubAllEnvs();
  });

  it("proxies HTTP with scoped credentials while keeping gateway auth and parent env separate", async () => {
    const result = await tellyFetch(`http://gateway.invalid:${targetPort}/notify`, {
      method: "POST", headers: { authorization: "Bearer gateway-token" }, body: "payload",
    });
    expect(await result.json()).toEqual({
      body: "payload", authorization: "Bearer gateway-token", proxyAuthorization: null,
    });
    expect(proxyRequests).toBe(1);
    expect(lastProxyAuthorization).toBe(`Basic ${Buffer.from("telly:secret").toString("base64")}`);
    expect(process.env.HTTP_PROXY).toBe("http://parent-agent.invalid:1");
    expect(process.env.NO_PROXY).toBe("*");
  });

  it("bypasses the scoped proxy by host/port and ignores standard proxy settings", async () => {
    vi.stubEnv("TELLYMCP_NO_PROXY", `127.0.0.1:${targetPort}`);
    const response = await tellyFetch(`http://127.0.0.1:${targetPort}/direct`);
    expect(response.ok).toBe(true);
    await response.text();
    vi.stubEnv("TELLYMCP_HTTP_PROXY", "");
    const withoutTellyProxy = await tellyFetch(`http://127.0.0.1:${targetPort}/direct`);
    await withoutTellyProxy.text();
    expect(proxyRequests).toBe(0);
  });

  it("rechecks proxy bypass on redirects in either direction", async () => {
    vi.stubEnv("TELLYMCP_NO_PROXY", "127.0.0.1");
    const direct = `http://127.0.0.1:${targetPort}/final`;
    const proxied = `http://gateway.invalid:${targetPort}/final`;
    for (const [from, to] of [[proxied, direct], [direct, proxied]]) {
      const response = await tellyFetch(`${from!.replace("/final", "/redirect")}?to=${encodeURIComponent(to!)}`);
      expect(response.ok).toBe(true);
      await response.text();
    }
    expect(proxyTargets.length).toBeGreaterThan(0);
    expect(proxyTargets.every((host) => host === `gateway.invalid:${targetPort}`)).toBe(true);
  });

  async function websocketReply(host: string): Promise<string> {
    const url = `ws://${host}:${targetPort}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        agent: getTellyWebSocketAgent(url),
        headers: { authorization: "Bearer gateway-token" }, handshakeTimeout: 2000,
      });
      ws.once("message", (data: Buffer) => { ws.close(); resolve(data.toString()); });
      ws.once("error", reject);
    });
  }

  it("uses the same scoped proxy for WebSocket handshakes", async () => {
    expect(await websocketReply("gateway.invalid")).toBe("Bearer gateway-token");
    expect(proxyRequests).toBe(1);
    expect(lastProxyAuthorization).toBe(`Basic ${Buffer.from("telly:secret").toString("base64")}`);
  });

  it("bypasses the WebSocket proxy for configured local hosts", async () => {
    vi.stubEnv("TELLYMCP_NO_PROXY", "localhost,127.0.0.1");
    expect(await websocketReply("127.0.0.1")).toBe("Bearer gateway-token");
    expect(proxyRequests).toBe(0);
  });
});

describe("proxy bypass boundaries", () => {
  it.each([
    ["https://example.net", "example.net", true],
    ["https://api.example.net", "example.net", false],
    ["wss://api.example.net/ws", ".example.net", true],
    ["https://example.net", "*.example.net", true],
    ["https://notexample.net", ".example.net", false],
    ["https://example.net", "example.net:443", true],
    ["https://example.net:8443", "example.net:443", false],
    ["http://[::1]:8787", "[::1]:8787", true],
    ["https://example.net", "*", true],
  ])("%s against %s => %s", (url, rules, expected) => {
    expect(bypassTellyProxy(new URL(url), rules)).toBe(expected);
  });
});
