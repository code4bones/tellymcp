import { describe, expect, it, vi } from "vitest";

import {
  TransportInboxMenus,
  type TransportInboxMenusHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportInboxMenus";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

function t(
  _locale: string,
  key: string,
  vars?: Record<string, unknown>,
): string {
  return `${key}${vars ? ` ${JSON.stringify(vars)}` : ""}`;
}

function createHost(
  overrides: Partial<TransportInboxMenusHost> = {},
): TransportInboxMenusHost {
  return {
    createMenuOptions: vi.fn(() => ({
      onMenuOutdated: vi.fn(async () => undefined),
    })),
    getPrincipalFromContext: vi.fn(() => ({
      telegramChatId: 42,
      telegramUserId: 7,
    })),
    resolveLocaleForContext: vi.fn(async () => "en"),
    t: vi.fn(t),
    tForContext: vi.fn(async (_ctx, key, vars) => t("en", key, vars)),
    menuPayloadStore: {
      createMenuPayload: vi.fn(async () => undefined),
      getMenuPayload: vi.fn(async () => null),
    },
    createInboxRouteMenuPayload: vi.fn(async () => "route-payload-key"),
    createInboxMessageMenuPayload: vi.fn(async () => "message-payload-key"),
    buildInboxRoutesFingerprint: vi.fn(async () => "fp"),
    loadInboxRoutesContext: vi.fn(async () => ({
      principal: { telegramChatId: 42, telegramUserId: 7 },
      sessionId: "client-1:workspace",
      routes: [],
    })),
    listInboxMessages: vi.fn(async () => [
      {
        id: "msg-1",
        resourceKind: "task",
        resourceId: "T-1",
        status: "pending",
        title: "Fix the thing",
        summary: "Details",
        createdAt: new Date().toISOString(),
      },
    ]),
    bindCurrentSessionToRoute: vi.fn(async () => undefined),
    resolveInboxMessage: vi.fn(async () => undefined),
    showMainMenu: vi.fn(async () => undefined),
    getInboxMenu: vi.fn(() => ({})),
    renderMenuHtmlScreen: vi.fn(async () => undefined),
    editText: vi.fn(async () => undefined),
    replyText: vi.fn(async () => ({ message_id: 1 })),
    ...overrides,
  };
}

function createContext(callbackData: string): TelegramMenuContext {
  return {
    callbackQuery: { data: callbackData, message: undefined },
    answerCallbackQuery: vi.fn(async () => undefined),
  } as unknown as TelegramMenuContext;
}

describe("TransportInboxMenus.handleInboxMessageOpenCallback", () => {
  it("shows a stale-data alert when the payload key is unknown", async () => {
    const host = createHost();
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-message-open:missing");

    await menus.handleInboxMessageOpenCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
    expect(host.replyText).not.toHaveBeenCalled();
  });

  it("renders the message detail screen with Approve/Reject/Postpone", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(async () => undefined),
        getMenuPayload: vi.fn(async () => ({
          kind: "inbox-message-entry",
          sessionId: "client-1:workspace",
          namespace: "marrow",
          routeKey: "P-1",
          messageId: "msg-1",
        })),
      },
    });
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-message-open:message-payload-key");

    await menus.handleInboxMessageOpenCallback(ctx);

    expect(host.replyText).toHaveBeenCalledOnce();
    const [, text, , options] = (host.replyText as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [
      unknown,
      string,
      unknown,
      { reply_markup: { inline_keyboard: unknown[] } },
    ];
    expect(text).toContain("Fix the thing");
    expect(options.reply_markup.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callback_data: "inbox-decision:approve:message-payload-key",
        }),
        expect.objectContaining({
          callback_data: "inbox-decision:reject:message-payload-key",
        }),
        expect.objectContaining({
          callback_data: "inbox-decision:defer:message-payload-key",
        }),
      ]),
    );
  });
});

describe("TransportInboxMenus.handleInboxDecisionCallback", () => {
  const payload = {
    kind: "inbox-message-entry",
    sessionId: "client-1:workspace",
    namespace: "marrow",
    routeKey: "P-1",
    messageId: "msg-1",
  };

  it("applies the decision and refreshes the route's message list", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(async () => undefined),
        getMenuPayload: vi.fn(async () => payload),
      },
    });
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-decision:approve:message-payload-key");

    await menus.handleInboxDecisionCallback(ctx);

    expect(host.resolveInboxMessage).toHaveBeenCalledWith(
      "msg-1",
      "approve",
      { telegramChatId: 42, telegramUserId: 7 },
      "client-1:workspace",
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("approved") }),
    );
    expect(host.listInboxMessages).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "marrow",
      "P-1",
    );
  });

  it("surfaces an error from resolveInboxMessage as an alert instead of refreshing", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(async () => undefined),
        getMenuPayload: vi.fn(async () => payload),
      },
      resolveInboxMessage: vi.fn(async () => {
        throw new Error("Route is no longer bound to a console.");
      }),
    });
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-decision:approve:message-payload-key");

    await menus.handleInboxDecisionCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Route is no longer bound to a console.",
      show_alert: true,
    });
    expect(host.replyText).not.toHaveBeenCalled();
    expect(host.editText).not.toHaveBeenCalled();
  });

  it("rejects a callback that doesn't match the expected shape", async () => {
    const host = createHost();
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-decision:nonsense");

    await menus.handleInboxDecisionCallback(ctx);

    expect(host.resolveInboxMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });
});

describe("TransportInboxMenus.handleInboxRouteBackCallback", () => {
  it("re-renders the route's message list from the back button", async () => {
    const host = createHost();
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-route-back:marrow\u0000P-1");

    await menus.handleInboxRouteBackCallback(ctx);

    expect(host.listInboxMessages).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "marrow",
      "P-1",
    );
    expect(host.replyText).toHaveBeenCalledOnce();
  });

  it("alerts when there is no active session to render into", async () => {
    const host = createHost({
      loadInboxRoutesContext: vi.fn(async () => ({
        principal: { telegramChatId: 42, telegramUserId: 7 },
        sessionId: null,
        routes: null,
      })),
    });
    const menus = new TransportInboxMenus(host);
    const ctx = createContext("inbox-route-back:marrow\u0000P-1");

    await menus.handleInboxRouteBackCallback(ctx);

    expect(host.replyText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });
});

describe("inbox session/project mapping", () => {
  it("binds the selected session when entering a project, before listing its messages", async () => {
    const sessionId = "relay~vita-client~Vita";
    const host = createHost({
      loadInboxRoutesContext: vi.fn(async () => ({
        principal: { telegramChatId: 42, telegramUserId: 7 },
        sessionId,
        routes: [],
      })),
      menuPayloadStore: {
        createMenuPayload: vi.fn(),
        getMenuPayload: vi.fn(async () => ({
          kind: "inbox-route-entry",
          sessionId,
          namespace: "marrow",
          routeKey: "P-SLIFE",
        })),
      },
    });
    const ctx = createContext("project-select");
    Object.assign(ctx, { match: "project-payload" });
    const menus = new TransportInboxMenus(host) as unknown as {
      handleInboxRouteSelect(ctx: TelegramMenuContext): Promise<void>;
    };
    await menus.handleInboxRouteSelect(ctx);
    expect(host.bindCurrentSessionToRoute).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      sessionId,
      "marrow",
      "P-SLIFE",
    );
    expect(
      vi.mocked(host.bindCurrentSessionToRoute).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(host.listInboxMessages).mock.invocationCallOrder[0]!,
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("bound") }),
    );
  });

  it("refuses an old Accept button after the viewer selects another session", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(),
        getMenuPayload: vi.fn(async () => ({
          kind: "inbox-message-entry",
          sessionId: "old-client:WebTerm",
          namespace: "marrow",
          routeKey: "P-1",
          messageId: "msg-1",
        })),
      },
    });
    const ctx = createContext("inbox-decision:approve:old");
    await new TransportInboxMenus(host).handleInboxDecisionCallback(ctx);
    expect(host.resolveInboxMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it("refreshes the binding to the current session on route-back navigation", async () => {
    const host = createHost();
    await new TransportInboxMenus(host).handleInboxRouteBackCallback(
      createContext("inbox-route-back:marrow\u0000P-1"),
    );
    expect(host.bindCurrentSessionToRoute).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "client-1:workspace",
      "marrow",
      "P-1",
    );
  });
});

describe("inbox Back button destinations", () => {
  const message = {
    kind: "inbox-message-entry",
    sessionId: "client-1:workspace",
    namespace: "marrow",
    routeKey: "P-1",
    messageId: "msg-1",
  };
  const route = {
    kind: "inbox-route-entry",
    sessionId: "client-1:workspace",
    namespace: "marrow",
    routeKey: "P-1",
  };

  function lastBackCallback(host: TransportInboxMenusHost): string {
    const call = vi.mocked(host.replyText).mock.calls.at(-1)!;
    const keyboard = call[3]!.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    return keyboard.inline_keyboard.flat().at(-1)!.callback_data;
  }

  it("returns from the message list to the project list without reopening the same messages", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(),
        getMenuPayload: vi.fn(async () => message),
      },
    });
    const menus = new TransportInboxMenus(host);
    await menus.handleInboxDecisionCallback(
      createContext("inbox-decision:defer:message-payload-key"),
    );
    const back = lastBackCallback(host);
    expect(back).toBe("inbox-route-back:routes");
    vi.mocked(host.listInboxMessages).mockClear();
    vi.mocked(host.bindCurrentSessionToRoute).mockClear();

    const ctx = createContext(back);
    await menus.handleInboxRouteBackCallback(ctx);
    expect(host.renderMenuHtmlScreen).toHaveBeenCalledWith(
      ctx,
      "menu:externalInbox.screen.title",
      { kind: "menu" },
      expect.anything(),
    );
    expect(host.listInboxMessages).not.toHaveBeenCalled();
    expect(host.bindCurrentSessionToRoute).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it("returns from a message card to its messages, then back to projects", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(),
        getMenuPayload: vi.fn(async (key) =>
          key === "route-payload-key" ? route : message,
        ),
      },
    });
    const menus = new TransportInboxMenus(host);
    await menus.handleInboxMessageOpenCallback(
      createContext("inbox-message-open:message-payload-key"),
    );
    const back = lastBackCallback(host);
    expect(back).toBe("inbox-route-back:route-payload-key");
    expect(Buffer.byteLength(back, "utf8")).toBeLessThanOrEqual(64);
    vi.mocked(host.listInboxMessages).mockClear();

    await menus.handleInboxRouteBackCallback(createContext(back));
    expect(host.listInboxMessages).toHaveBeenCalledWith(
      { telegramChatId: 42, telegramUserId: 7 },
      "marrow",
      "P-1",
    );
    expect(lastBackCallback(host)).toBe("inbox-route-back:routes");
  });

  it("rejects a message-card Back button after switching the selected session", async () => {
    const host = createHost({
      menuPayloadStore: {
        createMenuPayload: vi.fn(),
        getMenuPayload: vi.fn(async () => ({
          ...route,
          sessionId: "old-client:WebTerm",
        })),
      },
    });
    const ctx = createContext("inbox-route-back:route-payload-key");
    await new TransportInboxMenus(host).handleInboxRouteBackCallback(ctx);
    expect(host.bindCurrentSessionToRoute).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });
});
