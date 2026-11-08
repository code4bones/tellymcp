import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import { createMcpHttpHandler } from "../src/services/features/telegram-mcp/src/app/http";
import {
  TELEGRAM_SDK_FILENAME,
  TELEGRAM_SDK_JS,
  TELEGRAM_SDK_SHA256,
} from "../src/services/features/telegram-mcp/src/app/webapp/telegramSdk";

afterEach(() => vi.unstubAllEnvs());

// The handler consumes the CommonJS ws default export; Vite exposes ws as ESM.
vi.mock("ws", async (importOriginal) => {
  const original = await importOriginal<typeof import("ws")>();
  return {
    ...original,
    default: { ...original.default, WebSocketServer: original.WebSocketServer },
  };
});

it.each(["/webapp", "/custom/live"])(
  "serves the bundled SDK through the gateway under %s",
  async (basePath) => {
    vi.stubEnv("ROOT_PREFIX", "/api");
    const handler = createMcpHttpHandler(
      {
        config: {
          webapp: { enabled: true, basePath },
          telegram: { webhook: { enabled: false, path: "/telegram/webhook" } },
          mcp: { httpPath: "/mcp" },
        },
        gatewayHttpService: { handleRequest: async () => false },
        logger: { info() {}, error() {} },
      } as unknown as Parameters<typeof createMcpHttpHandler>[0],
      {
        createMcpServer: () => {
          throw new Error("Static SDK requests must not initialize MCP");
        },
      },
    );
    const server = createServer((req, res) => {
      void handler.handleRequest(
        req,
        res,
        new URL(req.url || "/", "http://fixture").pathname,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api${basePath}/vendor/${TELEGRAM_SDK_FILENAME}`;
      const home = await fetch(new URL("/", endpoint));
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(
        (await fetch(new URL("/", endpoint), { method: "HEAD" })).status,
      ).toBe(200);
      const response = await fetch(endpoint);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      const source = await response.text();
      expect(source).toBe(TELEGRAM_SDK_JS);
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        TELEGRAM_SDK_SHA256,
      );
      expect((await fetch(endpoint, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await handler.close();
    }
  },
);
