import { beforeEach, describe, expect, it, vi } from "vitest";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";
import { ProcessLocalSessionStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalSessionStore";
import { ProcessLocalStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalStateStore";
import {
  TransportEventActions,
  type TransportEventActionsHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportEventActions";
import { writeLocalTaskXchangeRecord } from "../src/services/features/telegram-mcp/src/shared/lib/telegramXchangeRecords";

vi.mock(
  "../src/services/features/telegram-mcp/src/shared/lib/telegramXchangeRecords",
  () => ({
    writeLocalTaskXchangeRecord: vi.fn(async () => "version-record"),
  }),
);

const socketMethods = GatewaySocketService.methods as unknown as {
  handleGatewayWsClientMessage(this: object, raw: string): Promise<void>;
};

async function createHarness() {
  const sessionStore = new ProcessLocalSessionStore({
    initialSessions: ["Vita", "GitLabPlugins"].map((sessionId) => ({
      sessionId,
      label: sessionId,
      terminalTarget: `pty:${sessionId}`,
      updatedAt: "2026-10-25",
    })),
  });
  const bindingStore = new ProcessLocalStateStore();
  for (const sessionId of ["Vita", "GitLabPlugins"]) {
    await bindingStore.setBinding({
      sessionId,
      telegramUserId: 7,
      telegramChatId: 42,
      linkedAt: "2026-10-25",
    });
  }
  const logger = { info: vi.fn(), warn: vi.fn() };
  const nudgeSessionInbox = vi.fn(async () => undefined);
  const sendNotification = vi.fn(async () => ({}));
  const actions = new TransportEventActions({
    sessionStore,
    bindingStore,
    logger,
    nudgeSessionInbox,
    sendNotification,
    config: {},
    tForTelegramUserId: async (_userId: number, key: string) => key,
  } as unknown as TransportEventActionsHost);
  const carrier = {
    getRuntimeOrThrow: () => ({
      logger,
      telegramTransport: {
        handleGatewayVersionCompatibilityEvent:
          actions.handleGatewayVersionCompatibilityEvent.bind(actions),
      },
    }),
    getLocalVersionInfo: () => ({
      packageVersion: "0.0.35",
      protocolVersion: "1.0",
      capabilities: [],
    }),
    wsHelloSessionTools: ["Vita", "GitLabPlugins"].map((local_session_id) => ({
      local_session_id,
    })),
    wsClient: { close: vi.fn() },
    syncLocalToolsAgainstGateway: vi.fn(async () => undefined),
  };
  return { carrier, nudgeSessionInbox, sendNotification };
}

describe("gateway reconnect diagnostics", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["warn", "reject"] as const)(
    "does not inject console instructions on %s, including a repeated handshake",
    async (compatibility) => {
      const h = await createHarness();
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        await socketMethods.handleGatewayWsClientMessage.call(
          h.carrier,
          JSON.stringify({
            type: "hello_ack",
            compatibility,
            package_version: "0.0.38",
            protocol_version: "1.0",
            instruction: "Upgrade the older side.",
            reasons: ["Package version mismatch"],
          }),
        );
      }

      expect(h.nudgeSessionInbox).not.toHaveBeenCalled();
      expect(writeLocalTaskXchangeRecord).toHaveBeenCalledTimes(4);
      expect(writeLocalTaskXchangeRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: compatibility,
          tags: ["system", "version", compatibility],
        }),
      );
      expect(h.sendNotification).toHaveBeenCalledTimes(4);
      if (compatibility === "reject") {
        expect(h.carrier.wsClient.close).toHaveBeenCalledWith(
          4002,
          "version_incompatible",
        );
      } else {
        expect(h.carrier.wsClient.close).not.toHaveBeenCalled();
      }
    },
  );

  it("does not create diagnostics or inject instructions on a compatible handshake", async () => {
    const h = await createHarness();
    await socketMethods.handleGatewayWsClientMessage.call(
      h.carrier,
      JSON.stringify({ type: "hello_ack", compatibility: "ok" }),
    );
    expect(h.nudgeSessionInbox).not.toHaveBeenCalled();
    expect(writeLocalTaskXchangeRecord).not.toHaveBeenCalled();
    expect(h.sendNotification).not.toHaveBeenCalled();
    expect(h.carrier.syncLocalToolsAgainstGateway).toHaveBeenCalledOnce();
  });
});
