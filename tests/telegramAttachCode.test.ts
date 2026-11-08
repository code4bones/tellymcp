import { expect, it, vi } from "vitest";
import {
  TransportLiveActions,
  type TransportLiveHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportLiveActions";
import {
  WebAppLaunchRegistry,
  WebAppSessionRegistry,
} from "../src/services/features/telegram-mcp/src/app/webapp/auth";
import type { TelegramMenuPayloadRecord } from "../src/services/features/telegram-mcp/src/entities/inbox/model/types";
import type {
  TelegramMenuContext,
  TelegramSendMessageOptions,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";
import { translate as t } from "../src/services/features/telegram-mcp/src/shared/i18n";
import { TransportMenuShell } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuShell";

function setup() {
  const payloads = new Map<string, TelegramMenuPayloadRecord>();
  const sent: Array<{
    chat: number;
    text: string;
    options: TelegramSendMessageOptions;
  }> = [];
  const issue = vi.fn(async () => ({
    code: "12345678",
    expiresAt: Date.now() + 300000,
  }));
  const host = {
    config: {
      distributed: {
        mode: "gateway",
        gatewayPublicUrl: "https://gateway.example/api/gateway",
        gatewayWsPath: "/api/gateway/ws",
      },
      webapp: {
        enabled: true,
        publicUrl: "https://gateway.example/api/webapp",
        launchMode: "default",
        sessionTtlSeconds: 3600,
        initDataTtlSeconds: 300,
      },
    },
    menuPayloadStore: {
      createMenuPayload: async (payload: TelegramMenuPayloadRecord) => {
        payloads.set(payload.key, payload);
      },
      getMenuPayload: async (key: string) => payloads.get(key) ?? null,
    },
    issueTerminalAttachCode: issue,
    resolveLocaleForContext: async () => "en",
    webAppLaunchRegistry: new WebAppLaunchRegistry(),
    webAppSessions: new WebAppSessionRegistry(),
    ensureGatewayClientUuid: async () => "client",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    t,
    sendChatMessage: async (
      chat: number,
      text: string,
      options: TelegramSendMessageOptions,
    ) => {
      sent.push({ chat, text, options });
      return { message_id: sent.length };
    },
  } as unknown as TransportLiveHost;
  const live = new TransportLiveActions(host);
  const launcher = async () => {
    await live.sendLauncherMessage({
      principal: { telegramChatId: -100, telegramUserId: 42 },
      sessionId: "client:session",
      sessionName: "Test",
      locale: "en",
    });
    return [...payloads.values()].find(
      (payload) => payload.kind === "terminal-attach",
    )!;
  };
  const callback = (key: string, user = 42) =>
    ({
      callbackQuery: { data: "terminal-attach:" + key },
      from: { id: user },
      chat: { id: -100 },
      answerCallbackQuery: vi.fn(async () => {}),
    }) as unknown as TelegramMenuContext;
  return { live, launcher, payloads, sent, issue, callback, host };
}

it("renders three launch modes, Link/Attach and Back without browser tokens or URL buttons", async () => {
  const ctx = setup();
  const payload = await ctx.launcher();
  const keyboard = ctx.sent[0]!.options.reply_markup as {
    inline_keyboard: Array<
      Array<{ text: string; callback_data?: string; url?: string }>
    >;
  };
  const row = keyboard.inline_keyboard.find((items) =>
    items.some((item) => item.text === "Link"),
  );
  expect(row?.map((item) => item.text)).toEqual(["Link", "Attach"]);
  expect(row?.[1]!.callback_data).toBe("terminal-attach:" + payload.key);
  expect(payload).toMatchObject({
    telegramUserId: 42,
    sessionId: "client:session",
    kind: "terminal-attach",
  });
  expect(ctx.issue).not.toHaveBeenCalled();
  expect(
    keyboard.inline_keyboard.map((row) => row.map((button) => button.text)),
  ).toEqual([
    ["Fullscreen", "Expand", "Default"],
    ["Link", "Attach"],
    ["Back"],
  ]);
  expect(keyboard.inline_keyboard.flat().some((button) => button.url)).toBe(
    false,
  );
  expect(row?.[0]!.callback_data).toMatch(/^live-link:/);
  expect(keyboard.inline_keyboard[2]![0]!.callback_data).toBe("live-back");
  expect(JSON.stringify(keyboard)).not.toContain("token=");
});

it("creates a Live browser token only when Link is pressed and sends a copyable URL privately", async () => {
  const ctx = setup();
  const create = vi.spyOn(ctx.host.webAppSessions, "create");
  await ctx.launcher();
  expect(create).not.toHaveBeenCalled();
  const payload = [...ctx.payloads.values()].find(
    (payload) => payload.kind === "live-link",
  )!;
  const callback = ctx.callback(payload.key);
  callback.callbackQuery!.data = "live-link:" + payload.key;
  await ctx.live.handleLinkCallback(callback);
  const sent = ctx.sent.at(-1)!;
  expect(sent.chat).toBe(42);
  expect(sent.options).toMatchObject({
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  const url = new URL(
    sent.text.match(/<code>(.+)<\/code>/)![1]!.replaceAll("&amp;", "&"),
  );
  expect(url.pathname).toBe("/api/webapp/live/client%3Asession");
  expect(
    ctx.host.webAppSessions.get(url.searchParams.get("token")!),
  ).toMatchObject({ sessionId: "client:session", telegramUserId: 42 });
  expect(sent.options.reply_markup).toBeUndefined();
});

it("denies Link to another user, an expired button or an expired launch grant", async () => {
  const ctx = setup();
  const create = vi.spyOn(ctx.host.webAppSessions, "create");
  await ctx.launcher();
  const payload = [...ctx.payloads.values()].find(
    (payload) => payload.kind === "live-link",
  )!;
  const callback = (user = 42) => {
    const c = ctx.callback(payload.key, user);
    c.callbackQuery!.data = "live-link:" + payload.key;
    return c;
  };
  await ctx.live.handleLinkCallback(callback(43));
  payload.expiresAt = new Date(Date.now() - 1000).toISOString();
  await ctx.live.handleLinkCallback(callback());
  payload.expiresAt = new Date(Date.now() + 10000).toISOString();
  ctx.host.webAppLaunchRegistry.deleteByUserId(42);
  await ctx.live.handleLinkCallback(callback());
  expect(create).not.toHaveBeenCalled();
  expect(ctx.sent).toHaveLength(1);
});

it("routes the standalone Live Back button to the selected session menu", async () => {
  const handlers = new Map<
    string,
    (ctx: TelegramMenuContext) => Promise<void>
  >();
  const showMainMenu = vi.fn(async () => {});
  new TransportMenuShell({ showMainMenu } as never).register({
    callbackQuery: (
      pattern: string | RegExp,
      handler: (ctx: TelegramMenuContext) => Promise<void>,
    ) => handlers.set(String(pattern), handler),
    catch: vi.fn(),
    on: vi.fn(),
  } as never);
  const ctx = {
    answerCallbackQuery: vi.fn(async () => {}),
  } as unknown as TelegramMenuContext;
  await handlers.get("live-back")!(ctx);
  expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  expect(showMainMenu).toHaveBeenCalledWith(ctx);
});

it("only the original Telegram user can request a code and it is delivered privately", async () => {
  const ctx = setup();
  const payload = await ctx.launcher();
  const denied = ctx.callback(payload.key, 43);
  await ctx.live.handleAttachCallback(denied);
  expect(ctx.issue).not.toHaveBeenCalled();
  expect(denied.answerCallbackQuery).toHaveBeenCalledWith(
    expect.objectContaining({ show_alert: true }),
  );
  await ctx.live.handleAttachCallback(ctx.callback(payload.key));
  expect(ctx.issue).toHaveBeenCalledWith(42, "client:session");
  expect(ctx.sent.at(-1)!.chat).toBe(42);
  expect(ctx.sent.at(-1)!.text).toContain("tellymcp attach --code 12345678");
  expect(ctx.sent.at(-1)!.text).toContain(
    "--gateway https://gateway.example/api/gateway",
  );
  expect(ctx.sent.at(-1)!.options.parse_mode).toBe("HTML");
});

it("rejects expired callback payloads without issuing codes", async () => {
  const ctx = setup();
  const payload = await ctx.launcher();
  payload.expiresAt = new Date(Date.now() - 1000).toISOString();
  await ctx.live.handleAttachCallback(ctx.callback(payload.key));
  expect(ctx.issue).not.toHaveBeenCalled();
});

it("never copies gateway URL credentials into Telegram attach commands", async () => {
  const ctx = setup();
  const payload = await ctx.launcher();
  ctx.host.config.distributed.gatewayPublicUrl =
    "https://private:password@gateway.example/api/gateway?token=secret";
  await ctx.live.handleAttachCallback(ctx.callback(payload.key));
  expect(ctx.sent.at(-1)!.text).toContain(
    "--gateway https://gateway.example/api/gateway",
  );
  for (const secret of ["private", "password", "secret", "token="])
    expect(ctx.sent.at(-1)!.text).not.toContain(secret);
});
