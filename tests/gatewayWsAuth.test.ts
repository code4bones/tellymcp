import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";

const startGatewayWsServer = (
  GatewaySocketService.methods as unknown as {
    startGatewayWsServer: (this: Record<string, unknown>) => Promise<void>;
  }
).startGatewayWsServer;

async function expectUpgradeRejected(
  url: string,
  authorization?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(url, {
      ...(authorization ? { headers: { authorization } } : {}),
    });
    let responseReceived = false;

    client.once("unexpected-response", (_request, response) => {
      responseReceived = true;
      try {
        expect(response.statusCode).toBe(401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    client.once("open", () => {
      client.close();
      reject(new Error("Unauthorized WebSocket connection was accepted"));
    });
    client.once("error", (error) => {
      if (!responseReceived) {
        reject(error);
      }
    });
  });
}

describe("gateway WebSocket transport authentication", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of cleanup.splice(0)) {
      await close();
    }
  });

  it("rejects missing and wrong tokens before accepting an upgrade", async () => {
    const httpServer = createServer();
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const carrier = {
      wsServer: null,
      wsUpgradeHandler: null,
      waitForHttpServer: async () => httpServer,
      getRuntimeOrThrow: () => ({
        config: {
          distributed: {
            gatewayWsPath: "/api/gateway/ws",
            gatewayAuthToken: "transport-secret",
          },
        },
        logger,
        telegramTransport: {
          pausePromptScan: vi.fn(),
        },
      }),
      connectedClients: new Map(),
      connectedClientsByUuid: new Map(),
      connectedClientToolsAlerts: new Map(),
      liveStreamHandlers: new Map(),
      broker: {
        call: vi.fn(async () => undefined),
      },
      handleGatewayWsServerMessage: vi.fn(async () => undefined),
    } as Record<string, unknown> & { wsServer: WebSocketServer | null };

    await startGatewayWsServer.call(carrier);
    const wsServer = carrier.wsServer;
    if (!wsServer) {
      throw new Error("Gateway WebSocket server was not created");
    }
    cleanup.unshift(
      () =>
        new Promise<void>((resolve, reject) => {
          wsServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const address = httpServer.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}/api/gateway/ws`;

    await expectUpgradeRejected(url);
    await expectUpgradeRejected(url, "Bearer wrong-secret");
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Gateway WS client connected",
      expect.anything(),
    );
  });

  it("accepts the configured bearer token", async () => {
    const httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const carrier = {
      wsServer: null,
      wsUpgradeHandler: null,
      waitForHttpServer: async () => httpServer,
      getRuntimeOrThrow: () => ({
        config: {
          distributed: {
            gatewayWsPath: "/api/gateway/ws",
            gatewayAuthToken: "transport-secret",
          },
        },
        logger,
        telegramTransport: {
          pausePromptScan: vi.fn(),
        },
      }),
      connectedClients: new Map(),
      connectedClientsByUuid: new Map(),
      connectedClientToolsAlerts: new Map(),
      liveStreamHandlers: new Map(),
      broker: {
        call: vi.fn(async () => undefined),
      },
      handleGatewayWsServerMessage: vi.fn(async () => undefined),
    } as Record<string, unknown> & { wsServer: WebSocketServer | null };

    await startGatewayWsServer.call(carrier);
    const wsServer = carrier.wsServer;
    if (!wsServer) {
      throw new Error("Gateway WebSocket server was not created");
    }
    cleanup.unshift(
      () =>
        new Promise<void>((resolve, reject) => {
          wsServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const address = httpServer.address() as AddressInfo;
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/gateway/ws`,
      { headers: { authorization: "Bearer transport-secret" } },
    );
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.close();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));

    expect(logger.warn).toHaveBeenCalledWith(
      "Gateway WS client connected",
      expect.objectContaining({ path: "/api/gateway/ws" }),
    );
  });
});
