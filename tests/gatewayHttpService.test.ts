import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { GatewayHttpService } from "../src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService";

function makeService(
  callBroker: <T>(actionName: string, params?: unknown) => Promise<T>,
  gatewayAuthToken?: string,
): GatewayHttpService {
  return new GatewayHttpService(
    {
      distributed: {
        mode: "gateway",
        ...(gatewayAuthToken ? { gatewayAuthToken } : {}),
      },
    } as never,
    callBroker as never,
  );
}

function makeRequest(authorization?: string): IncomingMessage {
  return {
    method: "POST",
    headers: authorization ? { authorization } : {},
  } as IncomingMessage;
}

function makeResponse(): ServerResponse & { body: string } {
  return {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end(this: { body: string }, body?: string) {
      this.body = body ?? "";
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}

describe("GatewayHttpService transport authentication", () => {
  it("keeps health public when gateway auth is not configured", async () => {
    const service = makeService(async () => ({}));
    const response = makeResponse();

    await expect(
      service.handleRequest(makeRequest(), response, "/gateway/healthz"),
    ).resolves.toBe(true);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      service: "tellymcp-gateway",
    });
  });

  it("fails closed when gateway auth is not configured", async () => {
    const service = makeService(async () => ({}));
    const response = makeResponse();

    await service.handleRequest(
      makeRequest(),
      response,
      "/gateway/client/register",
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("Unauthorized");
  });

  it("rejects a wrong bearer token", async () => {
    const service = makeService(async () => ({}), "transport-secret");
    const response = makeResponse();

    await service.handleRequest(
      makeRequest("Bearer wrong-secret"),
      response,
      "/gateway/client/register",
    );

    expect(response.statusCode).toBe(401);
  });

  it("accepts the configured bearer token", async () => {
    const service = makeService(async () => ({}), "transport-secret");
    const response = makeResponse();

    await service.handleRequest(
      makeRequest("Bearer transport-secret"),
      response,
      "/gateway/tools-md",
    );

    expect(response.statusCode).toBe(405);
    expect(response.body).toBe("Method not allowed");
  });
});

describe("GatewayHttpService live relay bootstrap", () => {
  it("normalizes wrapped bootstrap responses", async () => {
    const callBroker = vi.fn(async () => ({
      result: {
        session_id: "telegram-mcp-708ad3c5",
        session_label: "backend",
        terminal_target: true,
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
      terminal_target: true,
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
