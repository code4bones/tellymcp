import { describe, expect, it, vi } from "vitest";

import { GatewayHttpService } from "../src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService";

function makeService(
  callBroker: <T>(actionName: string, params?: unknown) => Promise<T>,
): GatewayHttpService {
  return new GatewayHttpService(
    {
      distributed: {
        mode: "gateway",
      },
    } as never,
    callBroker as never,
  );
}

describe("GatewayHttpService live relay bootstrap", () => {
  it("normalizes wrapped bootstrap responses", async () => {
    const callBroker = vi.fn(async () => ({
      result: {
        session_id: "telegram-mcp-708ad3c5",
        session_label: "backend",
        tmux_target: true,
        poll_interval_ms: 1500,
        telegram_user_id: "1711337558",
      },
    }));
    const service = makeService(callBroker);

    await expect(
      service.requestLiveRelayBootstrap({
        clientUuid: "target-client-uuid",
        localSessionId: "telegram-mcp-708ad3c5",
        telegramUserId: 1711337558,
        allowForeignBinding: true,
        initDataRaw: "unused",
        initDataUnsafe: {},
      }),
    ).resolves.toEqual({
      session_id: "telegram-mcp-708ad3c5",
      session_label: "backend",
      tmux_target: true,
      poll_interval_ms: 1500,
      telegram_user_id: 1711337558,
    });
  });

  it("throws on invalid bootstrap responses instead of silently accepting them", async () => {
    const service = makeService(async () => ({
      result: {
        message: "bad payload",
      },
    }));

    await expect(
      service.requestLiveRelayBootstrap({
        clientUuid: "target-client-uuid",
        localSessionId: "telegram-mcp-708ad3c5",
        initDataRaw: "raw",
        initDataUnsafe: {},
      }),
    ).rejects.toThrow("Invalid live relay bootstrap response");
  });

  it("requests source-side validation through bootstrap_validate", async () => {
    const callBroker = vi.fn(async () => ({
      result: {
        telegram_user_id: 1711337558,
      },
    }));
    const service = makeService(callBroker);

    await expect(
      service.requestLiveRelayBootstrapValidation({
        clientUuid: "source-client-uuid",
        initDataRaw: "raw",
        initDataUnsafe: {},
      }),
    ).resolves.toEqual({
      telegram_user_id: 1711337558,
    });

    expect(callBroker).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      expect.objectContaining({
        clientUuid: "source-client-uuid",
        requestType: "bootstrap_validate",
      }),
      { meta: { internal_call: true } },
    );
  });
});
