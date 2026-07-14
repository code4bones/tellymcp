import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveEnvironmentFromPublicBase,
  renderConfiguredEnvironment,
  runConfigureConnectionCheck,
  startConfigureServer,
  validateConfiguredEnvironment,
} from "../src/configureServer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configure server", () => {
  it("validates role-specific requirements", () => {
    const gateway = validateConfiguredEnvironment({
      role: "gateway",
      values: {
        PUBLIC_BASE_URL: "https://example.com/api",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        REDIS_DB: "1",
      },
    });
    expect(gateway.valid).toBe(false);
    expect(gateway.errors).toMatchObject({
      TELEGRAM_BOT_TOKEN: expect.any(String),
      GATEWAY_AUTH_TOKEN: expect.any(String),
    });

    const localClient = validateConfiguredEnvironment({
      role: "client",
      values: {
        PUBLIC_BASE_URL: "https://example.com/api",
        GATEWAY_AUTH_TOKEN: "shared",
      },
    });
    expect(localClient).toEqual({ valid: true, errors: {} });
  });

  it("validates protocols and dependent OAuth settings", () => {
    const result = validateConfiguredEnvironment({
      role: "client",
      values: {
        PUBLIC_BASE_URL: "https://example.com/api",
        GATEWAY_WS_URL: "https://gateway.example/api/gateway/ws",
        GATEWAY_AUTH_TOKEN: "shared",
        TELLYMCP_OAUTH_CLIENT_ID: "connector",
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toMatchObject({
      GATEWAY_WS_URL: expect.any(String),
      TELLYMCP_PUBLIC_URL: expect.any(String),
      TELLYMCP_MAGIC_TOKEN: expect.any(String),
    });
  });

  it("derives gateway, WebSocket, WebApp, webhook and OAuth URLs from one base", () => {
    const output = deriveEnvironmentFromPublicBase({
      role: "gateway",
      values: {
        PUBLIC_BASE_URL: "https://example.com/api/gateway",
        ROOT_PREFIX: "/api",
        OAUTH_ENABLED: "true",
      },
    });

    expect(output).toMatchObject({
      PUBLIC_BASE_URL: "https://example.com/api",
      ROOT_PREFIX: "/api",
      GATEWAY_PUBLIC_URL: "https://example.com/api/gateway",
      GATEWAY_WS_URL: "wss://example.com/api/gateway/ws",
      GATEWAY_WS_PATH: "/api/gateway/ws",
      WEBAPP_PUBLIC_URL: "https://example.com/api/webapp",
      TELEGRAM_WEBHOOK_PUBLIC_URL: "https://example.com/api/telegram/webhook",
      TELLYMCP_PUBLIC_URL: "https://example.com/api",
      TELLYMCP_OAUTH_ISSUER: "https://example.com/api",
      TELLYMCP_OAUTH_AUDIENCE: "https://example.com/api",
    });
  });

  it("renders only template-owned normalized keys", () => {
    const content = renderConfiguredEnvironment({
      role: "gateway",
      template: [
        "REDIS_HOST=127.0.0.1",
        "REDIS_PORT=6379",
        "# REDIS_PASSWORD=",
        "DISTRIBUTED_MODE=client",
      ].join("\n"),
      values: {
        REDIS_HOST: "redis.internal",
        REDIS_PORT: "6379",
        REDIS_PASSWORD: "space secret",
        TMUX_SESSION: "legacy",
        UNRELATED_SECRET: "drop-me",
      },
    });

    expect(content).toContain("DISTRIBUTED_MODE=gateway");
    expect(content).toContain("REDIS_HOST=redis.internal");
    expect(content).toContain('REDIS_PASSWORD="space secret"');
    expect(content).not.toContain("TMUX_");
    expect(content).not.toContain("UNRELATED_SECRET");
  });

  it("returns safe hints when a live-check dependency is not configured", async () => {
    await expect(
      runConfigureConnectionCheck({
        kind: "telegram",
        role: "gateway",
        values: {},
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Сначала укажите токен Telegram-бота.",
    });
    await expect(
      runConfigureConnectionCheck({
        kind: "postgres",
        role: "gateway",
        values: {},
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Сначала укажите хост PostgreSQL.",
    });
  });

  it("checks Telegram getMe and never exposes the bot token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { username: "configured_bot" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      runConfigureConnectionCheck({
        kind: "telegram",
        role: "gateway",
        values: { TELEGRAM_BOT_TOKEN: "secret-token" },
      }),
    ).resolves.toEqual({
      ok: true,
      message: "Соединение установлено. Найден бот @configured_bot.",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("secret-token/getMe");
    fetchMock.mockRestore();
  });

  it("serves the role wizard and downloads the selected dotenv", async () => {
    const clientTemplate = [
      "# client",
      "DISTRIBUTED_MODE=client",
      "GATEWAY_PUBLIC_URL=",
      "GATEWAY_WS_URL=",
      "GATEWAY_AUTH_TOKEN=",
    ].join("\n");
    const gatewayTemplate = [
      "# gateway",
      "TELEGRAM_BOT_TOKEN=",
      "REDIS_HOST=127.0.0.1",
      "REDIS_PORT=6379",
      "REDIS_DB=1",
      "DISTRIBUTED_MODE=gateway",
      "GATEWAY_AUTH_TOKEN=",
    ].join("\n");

    let resolveUrl: (url: string) => void = () => undefined;
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const running = startConfigureServer({
      templates: {
        client: clientTemplate,
        gateway: gatewayTemplate,
      },
      open: false,
      onListening: resolveUrl,
    });
    const url = await urlPromise;

    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Мастер конфигурации");
    expect(html).toContain("Публичный базовый URL");
    expect(html).toContain("Проверить соединение");
    expect(html).toContain("Пример:");

    const token = new URL(url).searchParams.get("token");
    expect(token).toBeTruthy();
    const check = await fetch(
      `http://${new URL(url).host}/api/check?token=${encodeURIComponent(token ?? "")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "gateway",
          check: "telegram",
          values: {},
        }),
      },
    );
    expect(await check.json()).toEqual({
      ok: false,
      message: "Сначала укажите токен Telegram-бота.",
    });
    const download = await fetch(
      `http://${new URL(url).host}/api/download?token=${encodeURIComponent(token ?? "")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "client",
          values: {
            PUBLIC_BASE_URL: "https://example.com",
            GATEWAY_AUTH_TOKEN: "shared",
          },
        }),
      },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      'filename=".env-client"',
    );
    const downloadedEnv = await download.text();
    expect(downloadedEnv).toContain("DISTRIBUTED_MODE=client");
    expect(downloadedEnv).toContain(
      "GATEWAY_PUBLIC_URL=https://example.com/api/gateway",
    );
    expect(downloadedEnv).toContain(
      "GATEWAY_WS_URL=wss://example.com/api/gateway/ws",
    );
    await running;
  });
});
