import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { GatewayHttpService } from "../src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService";
import { buildLiveRelaySessionId } from "../src/services/features/telegram-mcp/src/app/webapp/relay";
import { MAX_BODY_SIZE_BYTES } from "../src/services/features/telegram-mcp/src/shared/lib/bodyLimits";

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

  it("returns 413 for an oversized authenticated request body", async () => {
    const service = makeService(async () => ({}), "transport-secret");
    const response = makeResponse();
    const request = {
      method: "POST",
      headers: {
        authorization: "Bearer transport-secret",
        "content-length": String(MAX_BODY_SIZE_BYTES + 1),
      },
    } as IncomingMessage;

    await service.handleRequest(request, response, "/gateway/client/register");

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: "Request body exceeds the 16 MiB limit",
    });
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

describe("GatewayHttpService agent runtime relay", () => {
  it("does not expose a Telegram-facing route that launches agents", async () => {
    const callBroker = vi.fn(async () => ({}));
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & { body: unknown };
    request.body = {};

    await expect(
      service.handleRequest(
        request,
        response,
        "/gateway/agent/start",
      ),
    ).resolves.toBe(true);

    expect(response.statusCode).toBe(410);
    expect(JSON.parse(response.body)).toMatchObject({
      error: expect.stringContaining("Remote agent launch is disabled"),
    });
    expect(callBroker).not.toHaveBeenCalled();
  });

  it("requests provider status from the selected client console", async () => {
    const callBroker = vi.fn(async () => ({
      session_id: "workspace",
      agents: [{ agentId: "codex", state: "idle", available: true }],
    }));
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & {
      body: unknown;
    };
    request.body = {
      session_id: buildLiveRelaySessionId("client-1", "workspace"),
    };

    await service.handleRequest(request, response, "/gateway/agent/status");

    expect(response.statusCode).toBe(200);
    expect(callBroker).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.requestClientAction",
      {
        clientUuid: "client-1",
        actionName: "telegramMcp.agentRuntime.listRemote",
        params: { session_id: "workspace" },
      },
      { meta: { internal_call: true } },
    );
  });

  it("resolves a canonical session before attaching its managed agent", async () => {
    const callBroker = vi.fn(async (actionName: string) => {
      if (
        actionName === "telegramMcp.gatewaySocket.resolveConnectedSessionTarget"
      ) {
        return {
          client_uuid: "client-2",
          local_session_id: "workspace-2",
        };
      }
      return { ok: true, agent_id: "claude", provider_id: "anthropic" };
    });
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & {
      body: unknown;
    };
    request.body = {
      session_id: "client-2:workspace-2",
      agent_id: "claude",
    };

    await service.handleRequest(request, response, "/gateway/agent/attach");

    expect(response.statusCode).toBe(200);
    expect(callBroker).toHaveBeenLastCalledWith(
      "telegramMcp.gatewaySocket.requestClientAction",
      {
        clientUuid: "client-2",
        actionName: "telegramMcp.agentRuntime.attachRemote",
        params: {
          agent_id: "claude",
          session_id: "workspace-2",
        },
      },
      { meta: { internal_call: true } },
    );
  });

  it("requests interruption of the active turn on the selected console", async () => {
    const callBroker = vi.fn(async (actionName: string) => {
      if (
        actionName === "telegramMcp.gatewaySocket.resolveConnectedSessionTarget"
      ) {
        return {
          client_uuid: "client-2",
          local_session_id: "workspace-2",
        };
      }
      return {
        ok: true,
        status: "interrupt_requested",
        thread_id: "thread-1",
        turn_id: "turn-1",
      };
    });
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & { body: unknown };
    request.body = { session_id: "client-2:workspace-2" };

    await service.handleRequest(request, response, "/gateway/agent/stop");

    expect(response.statusCode).toBe(200);
    expect(callBroker).toHaveBeenLastCalledWith(
      "telegramMcp.gatewaySocket.requestClientAction",
      {
        clientUuid: "client-2",
        actionName: "telegramMcp.agentRuntime.stopRemote",
        params: { session_id: "workspace-2" },
      },
      { meta: { internal_call: true } },
    );
  });

  it("submits Telegram text through the active structured agent", async () => {
    const callBroker = vi.fn(async () => ({
      handled: true,
      thread_id: "thread-1",
      turn_id: "turn-1",
    }));
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & {
      body: unknown;
    };
    request.body = {
      target_client_uuid: "client-1",
      target_local_session_id: "workspace",
      message: "Continue from Telegram",
      delivery_mode: "agent",
      agent_id: "codex",
    };

    await service.handleRequest(
      request,
      response,
      "/gateway/relay/console-message",
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      route: "agent",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    expect(callBroker).toHaveBeenCalledOnce();
    expect(callBroker).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.requestClientAction",
      {
        clientUuid: "client-1",
        actionName: "telegramMcp.agentRuntime.submitRemote",
        params: {
          session_id: "workspace",
          message: "Continue from Telegram",
          agent_id: "codex",
        },
      },
      { meta: { internal_call: true } },
    );
  });

  it("routes directly to PTY when terminal delivery mode is selected", async () => {
    const callBroker = vi.fn(async () => ({ ok: true }));
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & {
      body: unknown;
    };
    request.body = {
      target_client_uuid: "client-1",
      target_local_session_id: "workspace",
      message: "Continue in PTY",
      delivery_mode: "pty",
    };

    await service.handleRequest(
      request,
      response,
      "/gateway/relay/console-message",
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ route: "pty" });
    expect(callBroker).toHaveBeenCalledTimes(2);
    expect(callBroker).toHaveBeenNthCalledWith(
      1,
      "telegramMcp.gatewaySocket.requestLiveRelay",
      expect.objectContaining({
        requestType: "action",
        payload: { action: "text", text: "Continue in PTY" },
      }),
      { meta: { internal_call: true } },
    );
  });

  it("does not fall back to PTY when the selected agent is unavailable", async () => {
    const callBroker = vi.fn(async () => ({ handled: false }));
    const service = makeService(callBroker, "transport-secret");
    const response = makeResponse();
    const request = makeRequest(
      "Bearer transport-secret",
    ) as IncomingMessage & { body: unknown };
    request.body = {
      target_client_uuid: "client-1",
      target_local_session_id: "workspace",
      message: "Do not type this into the shell",
      delivery_mode: "agent",
      agent_id: "codex",
    };

    await service.handleRequest(
      request,
      response,
      "/gateway/relay/console-message",
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("no longer available");
    expect(callBroker).toHaveBeenCalledOnce();
    expect(callBroker).not.toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.requestLiveRelay",
      expect.anything(),
      expect.anything(),
    );
  });
});
