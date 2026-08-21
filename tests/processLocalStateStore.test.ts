import { describe, expect, it, vi } from "vitest";

import { ProcessLocalStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalStateStore";

describe("process-local client state store", () => {
  it("stores delivery mode independently for each principal and console", async () => {
    const store = new ProcessLocalStateStore();
    const principal = { telegramChatId: 42, telegramUserId: 7 };

    await expect(
      store.getConsoleDeliveryRoute(principal, "left"),
    ).resolves.toEqual({ mode: "pty" });
    await store.setConsoleDeliveryRoute(principal, "left", {
      mode: "agent",
      agentId: "codex",
    });

    await expect(
      store.getConsoleDeliveryRoute(principal, "left"),
    ).resolves.toEqual({ mode: "agent", agentId: "codex" });
    await expect(
      store.getConsoleDeliveryRoute(principal, "right"),
    ).resolves.toEqual({ mode: "pty" });
    await expect(
      store.getConsoleDeliveryRoute(
        { telegramChatId: 42, telegramUserId: 8 },
        "left",
      ),
    ).resolves.toEqual({ mode: "pty" });
  });

  it("keeps and persists the gateway client UUID through its callback", async () => {
    const onChange = vi.fn();
    const store = new ProcessLocalStateStore({
      gatewayClientUuid: "restored-client",
      onGatewayClientUuidChange: onChange,
    });

    await expect(store.getGatewayClientUuid()).resolves.toBe("restored-client");
    await store.setGatewayClientUuid("registered-client");
    expect(onChange).toHaveBeenCalledWith("registered-client");
    await expect(store.getGatewayClientUuid()).resolves.toBe("registered-client");
  });

  it("supports client bindings without an external state service", async () => {
    const store = new ProcessLocalStateStore();
    const principal = { telegramChatId: 100, telegramUserId: 200 };
    await store.setBinding({
      sessionId: "session-1",
      ...principal,
      linkedAt: new Date().toISOString(),
    });

    await expect(store.getActiveSessionIdForPrincipal(principal)).resolves.toBe(
      "session-1",
    );
    await expect(store.listBoundSessionIdsForPrincipal(principal)).resolves.toEqual([
      "session-1",
    ]);
  });
});
