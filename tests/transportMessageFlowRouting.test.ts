import { describe, expect, it, vi } from "vitest";

import { TransportMessageFlow } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMessageFlow";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

describe("TransportMessageFlow relay routing", () => {
  it("sends the principal-and-console delivery route to the gateway", async () => {
    const callGatewayJson = vi.fn(async () => ({
      ok: true as const,
      session_id: "workspace",
      submitted_text: "Continue",
      route: "agent" as const,
    }));
    const getConsoleDeliveryRoute = vi.fn(async () => ({
      mode: "agent" as const,
      agentId: "codex" as const,
    }));
    const logger = { info: vi.fn() };
    const flow = new TransportMessageFlow({
      bindingStore: { getConsoleDeliveryRoute },
      callGatewayJson,
      logger,
    } as unknown as ConstructorParameters<typeof TransportMessageFlow>[0]);
    const principal = { telegramChatId: 42, telegramUserId: 7 };

    await flow.routeTelegramInboxToRelaySession({
      ctx: {
        from: { id: 7, first_name: "Ada" },
      } as unknown as TelegramMenuContext,
      principal,
      relayTarget: { clientUuid: "client-1", localSessionId: "workspace" },
      sourceSessionId: "relay~client-1~workspace",
      messageText: "Continue",
      attachments: [],
    });

    expect(getConsoleDeliveryRoute).toHaveBeenCalledWith(
      principal,
      "relay~client-1~workspace",
    );
    expect(callGatewayJson).toHaveBeenCalledWith("/relay/console-message", {
      source_actor_label: "Ada",
      target_client_uuid: "client-1",
      target_local_session_id: "workspace",
      message: "Continue",
      delivery_mode: "agent",
      agent_id: "codex",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Telegram message routed to gateway relay session",
      expect.objectContaining({ route: "agent" }),
    );
  });
});
