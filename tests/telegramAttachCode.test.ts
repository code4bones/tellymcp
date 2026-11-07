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
    return [...payloads.values()][0]!;
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

it("places Attach beside Open in browser, while launcher data contains no attach code", async () => {
  const ctx = setup();
  const payload = await ctx.launcher();
  const keyboard = ctx.sent[0]!.options.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  };
  const row = keyboard.inline_keyboard.find((items) =>
    items.some((item) => item.text.includes("Open in browser")),
  );
  expect(row?.map((item) => item.text)).toEqual([
    "🌐 Open in browser",
    "🔗 Attach",
  ]);
  expect(row?.[1]!.callback_data).toBe("terminal-attach:" + payload.key);
  expect(payload).toMatchObject({
    telegramUserId: 42,
    sessionId: "client:session",
    kind: "terminal-attach",
  });
  expect(ctx.issue).not.toHaveBeenCalled();
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
