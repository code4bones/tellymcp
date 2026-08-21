import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { TransportRequestFlow } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportRequestFlow";
import type {
  TelegramMenuContext,
  WaiterRecord,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

describe("Telegram request option callbacks", () => {
  it("renders option buttons and resolves the matching waiter", async () => {
    const waiters = new Map<string, WaiterRecord>();
    const sendTextChunks = vi.fn(async () => [
      { messageId: 101, textLength: 32 },
    ]);
    const flow = new TransportRequestFlow({
      logger: {
        error: vi.fn(),
      } as never,
      config: {
        distributed: {},
        telegram: {},
      } as AppConfig,
      adminAuthStore: {} as never,
      maintenanceStore: {} as never,
      waiters,
      isTelegramEnabled: () => true,
      isAdminAuthEnabled: () => false,
      resolveLocaleForTelegramUserId: async () => "en",
      t: (_locale, key) => key,
      tForContext: async (_ctx, key) => key,
      sendTextChunks,
      callGatewayJson: vi.fn(),
    });

    await flow.sendRequest({
      requestId: "approval-1",
      sessionId: "workspace",
      recipient: { telegramChatId: 10, telegramUserId: 20 },
      question: "Approve command?",
      options: ["Approve", "Deny"],
    });
    const finalOptions = sendTextChunks.mock.calls[0]?.[3] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(finalOptions.reply_markup?.inline_keyboard).toEqual([
      [{ text: "Approve", callback_data: "request-option:0:approval-1" }],
      [{ text: "Deny", callback_data: "request-option:1:approval-1" }],
    ]);

    const replyPromise = flow.waitForReply("approval-1", 30);
    const ctx = {
      callbackQuery: { data: "request-option:0:approval-1" },
      chat: { id: 10 },
      from: { id: 20 },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    } as unknown as TelegramMenuContext;
    await flow.handleRequestOptionCallback(ctx);

    await expect(replyPromise).resolves.toMatchObject({
      requestId: "approval-1",
      answer: "Approve",
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "common:request.answer_recorded",
    });
    expect(waiters.has("approval-1")).toBe(false);
  });

  it("forwards a proxied option only for the bound Telegram principal", async () => {
    const waiters = new Map<string, WaiterRecord>();
    const callGatewayJson = vi.fn(async () => ({}));
    const flow = new TransportRequestFlow({
      logger: { error: vi.fn() } as never,
      config: {
        distributed: { gatewayPublicUrl: "https://gateway.example" },
        telegram: {},
      } as AppConfig,
      adminAuthStore: {} as never,
      maintenanceStore: {} as never,
      waiters,
      isTelegramEnabled: () => true,
      isAdminAuthEnabled: () => false,
      resolveLocaleForTelegramUserId: async () => "en",
      t: (_locale, key) => key,
      tForContext: async (_ctx, key) => key,
      sendTextChunks: vi.fn(async () => [
        { messageId: 102, textLength: 32 },
      ]),
      callGatewayJson,
    });

    await flow.sendRequestForGatewayBoundSession({
      requestId: "approval-2",
      sourceClientUuid: "client-1",
      sessionId: "client-1:workspace",
      recipient: { telegramChatId: 10, telegramUserId: 20 },
      question: "Approve file changes?",
      options: ["Approve", "Deny"],
    });

    const unauthorized = {
      callbackQuery: { data: "request-option:1:approval-2" },
      chat: { id: 10 },
      from: { id: 99 },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    } as unknown as TelegramMenuContext;
    await flow.handleRequestOptionCallback(unauthorized);
    expect(callGatewayJson).not.toHaveBeenCalled();
    expect(waiters.has("approval-2")).toBe(true);

    const authorized = {
      callbackQuery: { data: "request-option:1:approval-2" },
      chat: { id: 10 },
      from: { id: 20 },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    } as unknown as TelegramMenuContext;
    await flow.handleRequestOptionCallback(authorized);

    expect(callGatewayJson).toHaveBeenCalledWith(
      "/transport/reply",
      expect.objectContaining({
        client_uuid: "client-1",
        request_id: "approval-2",
        answer: "Deny",
      }),
    );
    expect(waiters.has("approval-2")).toBe(false);
  });
});
