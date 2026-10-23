import { describe, expect, it, vi } from "vitest";

import { TransportInboxState } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportInboxState";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

function createContext() {
  return {} as TelegramMenuContext;
}

describe("TransportInboxState", () => {
  it("returns nulls when there is no telegram identity", async () => {
    const state = new TransportInboxState({
      getPrincipalFromContext: () => null,
      callGatewayJson: vi.fn(),
      bindingStore: { getActiveSessionIdForPrincipal: vi.fn() },
    });

    await expect(state.loadInboxRoutesContext(createContext())).resolves.toEqual({
      principal: null,
      sessionId: null,
      routes: null,
    });
  });

  it("returns nulls when there is no active session", async () => {
    const state = new TransportInboxState({
      getPrincipalFromContext: () => ({ telegramChatId: 42, telegramUserId: 7 }),
      callGatewayJson: vi.fn(),
      bindingStore: { getActiveSessionIdForPrincipal: vi.fn(async () => null) },
    });

    await expect(state.loadInboxRoutesContext(createContext())).resolves.toEqual({
      principal: { telegramChatId: 42, telegramUserId: 7 },
      sessionId: null,
      routes: null,
    });
  });

  it("loads active routes for the bound session", async () => {
    const callGatewayJson = vi.fn(async () => [
      { namespace: "marrow", routeKey: "P-1", count: 2 },
    ]);
    const state = new TransportInboxState({
      getPrincipalFromContext: () => ({ telegramChatId: 42, telegramUserId: 7 }),
      callGatewayJson,
      bindingStore: {
        getActiveSessionIdForPrincipal: vi.fn(async () => "client-1:workspace"),
      },
    });

    const result = await state.loadInboxRoutesContext(createContext());

    expect(callGatewayJson).toHaveBeenCalledWith("/inbox/routes", {
      telegram_user_id: 7,
    });
    expect(result).toEqual({
      principal: { telegramChatId: 42, telegramUserId: 7 },
      sessionId: "client-1:workspace",
      routes: [{ namespace: "marrow", routeKey: "P-1", count: 2 }],
    });
  });

  it("lists messages for a route", async () => {
    const callGatewayJson = vi.fn(async () => []);
    const state = new TransportInboxState({
      getPrincipalFromContext: vi.fn(),
      callGatewayJson,
      bindingStore: { getActiveSessionIdForPrincipal: vi.fn() },
    });

    await state.listInboxMessages({ telegramChatId: 42, telegramUserId: 7 }, "marrow", "P-1");

    expect(callGatewayJson).toHaveBeenCalledWith("/inbox/messages", {
      telegram_user_id: 7,
      namespace: "marrow",
      route_key: "P-1",
    });
  });

  it("binds the current session to a route via the gateway", async () => {
    const callGatewayJson = vi.fn(async () => ({}));
    const state = new TransportInboxState({
      getPrincipalFromContext: vi.fn(),
      callGatewayJson,
      bindingStore: { getActiveSessionIdForPrincipal: vi.fn() },
    });

    await state.bindCurrentSessionToRoute(
      { telegramChatId: 42, telegramUserId: 7 },
      "client-1:workspace",
      "marrow",
      "P-1",
    );

    expect(callGatewayJson).toHaveBeenCalledWith("/inbox/bind", {
      namespace: "marrow",
      route_key: "P-1",
      telegram_user_id: 7,
      session_id: "client-1:workspace",
    });
  });

  it("resolves an inbox message decision via the gateway", async () => {
    const callGatewayJson = vi.fn(async () => ({}));
    const state = new TransportInboxState({
      getPrincipalFromContext: vi.fn(),
      callGatewayJson,
      bindingStore: { getActiveSessionIdForPrincipal: vi.fn() },
    });

    await state.resolveInboxMessage("msg-1", "approve");

    expect(callGatewayJson).toHaveBeenCalledWith("/inbox/resolve", {
      message_id: "msg-1",
      decision: "approve",
    });
  });
});
