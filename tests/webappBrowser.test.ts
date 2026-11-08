import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { renderWebAppHtml } from "../src/services/features/telegram-mcp/src/app/webapp/assets";

describe.skipIf(!existsSync(chromium.executablePath()))(
  "Live startup in a browser",
  () => {
    it.each(["?token=browser-token", "#token=browser-token"])(
      "starts Live while telegram.org is unreachable (%s)",
      async (suffix) => {
        const browser = await chromium.launch({ headless: true });
        let releaseSdk!: () => void;
        const sdkBlocked = new Promise<void>((resolve) => {
          releaseSdk = resolve;
        });
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(3000);
          const requests: string[] = [];
          const bootstraps: unknown[] = [];
          page.on("request", (request) => requests.push(request.url()));
          await page.route("https://telegram.org/**", async (route) => {
            await sdkBlocked;
            await route.abort();
          });
          await page.route("https://live.test/**", async (route) => {
            if (
              new URL(route.request().url()).pathname.endsWith("/api/bootstrap")
            ) {
              bootstraps.push(route.request().postDataJSON());
              await route.fulfill({
                json: {
                  token: "live-token",
                  session_id: "fixture",
                  terminal_target: "fixture",
                },
              });
            } else {
              await route.fulfill({
                contentType: "text/html",
                body: renderWebAppHtml({
                  basePath: "/api/webapp",
                  launchMode: "default",
                }),
              });
            }
          });
          const sockets: string[] = [];
          await page.routeWebSocket("wss://live.test/**", (socket) => {
            sockets.push(socket.url());
            socket.send(
              JSON.stringify({
                type: "snapshot",
                ansi: "BROWSER_LIVE_READY",
                captured_at: new Date().toISOString(),
              }),
            );
          });
          await page.goto(
            "https://live.test/api/webapp/live/fixture" + suffix,
            { waitUntil: "domcontentloaded", timeout: 5000 },
          );
          await expect
            .poll(() => bootstraps, { timeout: 3000 })
            .toEqual([{ directToken: "browser-token" }]);
          await expect.poll(() => sockets.length, { timeout: 3000 }).toBe(1);
          await expect
            .poll(() => page.locator("[data-role=status]").textContent())
            .toBe("Live (stream)");
          expect(new URL(sockets[0]).searchParams.get("token")).toBe(
            "live-token",
          );
          expect(
            requests.every((url) => new URL(url).hostname === "live.test"),
          ).toBe(true);
        } finally {
          releaseSdk();
          await browser.close();
        }
      },
    );

    it.each(["default", "expand", "fullscreen"] as const)(
      "keeps Telegram SDK authentication and %s launch mode",
      async (launchMode) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const bootstraps: unknown[] = [];
          let sdkRequests = 0;
          await page.route("https://telegram.org/**", async (route) => {
            sdkRequests++;
            await route.fulfill({
              contentType: "application/javascript",
              body: `window.fixtureCalls=[];window.Telegram={WebApp:{initData:'auth_date=123&hash=fixture',initDataUnsafe:{user:{id:42}},ready(){fixtureCalls.push('ready')},expand(){fixtureCalls.push('expand')},requestFullscreen(){fixtureCalls.push('fullscreen')}}};`,
            });
          });
          await page.route("https://live.test/**", async (route) => {
            if (
              new URL(route.request().url()).pathname.endsWith("/api/bootstrap")
            ) {
              bootstraps.push(route.request().postDataJSON());
              await route.fulfill({
                json: { token: "live-token", session_id: "fixture" },
              });
            } else {
              await route.fulfill({
                contentType: "text/html",
                body: renderWebAppHtml({ basePath: "/api/webapp", launchMode }),
              });
            }
          });
          await page.routeWebSocket("wss://live.test/**", () => {});
          await page.goto("https://live.test/api/webapp/live/fixture", {
            waitUntil: "domcontentloaded",
          });
          await expect
            .poll(() => bootstraps, { timeout: 3000 })
            .toEqual([
              {
                initDataRaw: "auth_date=123&hash=fixture",
                initDataUnsafe: { user: { id: 42 } },
                sessionId: "fixture",
              },
            ]);
          expect(sdkRequests).toBe(1);
          expect(await page.evaluate("window.fixtureCalls")).toEqual(
            launchMode === "default" ? ["ready"] : ["ready", launchMode],
          );
        } finally {
          await browser.close();
        }
      },
    );
  },
);
