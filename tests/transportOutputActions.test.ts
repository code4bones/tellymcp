import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import { TransportOutputActions } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportOutputActions";
import type {
  TelegramEditMessageOptions,
  TelegramMenuContext,
  TelegramRichMessage,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

function createHarness() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const bot = new Bot<TelegramMenuContext>("123:test-token");
  // Intercept the actual SDK request before it can reach Telegram.
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 17 } } as never;
  });
  const actions = new TransportOutputActions({
    bot,
    config: {} as AppConfig,
    logger: { warn: vi.fn() } as unknown as Logger,
  });
  const ctx = {
    editMessageText: (
      content: string | TelegramRichMessage,
      options: TelegramEditMessageOptions,
    ) => bot.api.editMessageText(42, 17, content, options),
  } as unknown as TelegramMenuContext;
  return { actions, calls, ctx };
}

const keyboard = {
  inline_keyboard: [
    [{ text: "Back", callback_data: "inbox-route-back:routes" }],
  ],
};
const meta = { kind: "menu" as const, sessionId: "client-1:Vita" };

describe("native Telegram Rich Message output", () => {
  it("sends Rich Markdown through rich_message without a text parse mode", async () => {
    const { actions, calls } = createHarness();
    await actions.sendRichMessage(
      42,
      { markdown: "## Details\n- **Fix** `app.ts`" },
      keyboard,
      meta,
    );
    expect(calls).toEqual([
      {
        method: "sendRichMessage",
        payload: {
          chat_id: 42,
          rich_message: { markdown: "## Details\n- **Fix** `app.ts`" },
          reply_markup: keyboard,
        },
      },
    ]);
  });

  it("keeps existing block-based approval cards compatible", async () => {
    const { actions, calls } = createHarness();
    const blocks = [
      { type: "heading" as const, size: 3 as const, text: "Approve task" },
    ];
    await actions.sendRichMessage(42, blocks, keyboard, meta);
    expect(calls[0]!.payload.rich_message).toEqual({ blocks });
  });

  it("switches the same message from rich detail back to the plain menu", async () => {
    const { actions, calls, ctx } = createHarness();
    await actions.editText(ctx, { markdown: "### Task\n\nDescription" }, meta, {
      reply_markup: keyboard,
    });
    await actions.editText(ctx, "<b>Project messages</b>", meta, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    expect(calls).toEqual([
      {
        method: "editMessageText",
        payload: {
          chat_id: 42,
          message_id: 17,
          rich_message: { markdown: "### Task\n\nDescription" },
          reply_markup: keyboard,
        },
      },
      {
        method: "editMessageText",
        payload: {
          chat_id: 42,
          message_id: 17,
          text: "<b>Project messages</b>",
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
      },
    ]);
  });
});
