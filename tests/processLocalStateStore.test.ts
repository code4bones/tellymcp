import { describe, expect, it, vi } from "vitest";

import { ProcessLocalStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalStateStore";

describe("process-local client state store", () => {
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
