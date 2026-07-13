import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { FirefoxAttachServer } from "../src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer";
import { firefoxAttachInboundMessageSchema } from "../src/services/features/telegram-mcp/src/features/browser-attach/model/types";
import type {
  MaintenanceStore,
  SessionStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";

const EXTENSION_ORIGIN = "moz-extension://test-extension";

const getAvailablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
};

const waitForServer = async (url: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url, { origin: EXTENSION_ORIGIN });
      socket.once("open", () => {
        socket.close();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Browser attach test server did not start");
};

const waitForOpen = async (socket: WebSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
};

const waitForClose = async (
  socket: WebSocket,
): Promise<{ code: number; reason: string }> =>
  await new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });

const waitForMessageType = async (
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> =>
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 2_000);
    const onMessage = (payload: WebSocket.RawData): void => {
      const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
      if (message.type !== type) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });

const hello = (instanceId = "firefox-test"): Record<string, unknown> => ({
  type: "hello",
  extension_version: "0.0.1",
  browser: "firefox",
  instance_id: instanceId,
  profile_name: "test",
});

describe("browser attach WebSocket security", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of cleanup.splice(0)) {
      await close();
    }
  });

  const startServer = async (overrides?: {
    setBrowserAttachment?: MaintenanceStore["setBrowserAttachment"];
  }): Promise<{ server: FirefoxAttachServer; url: string; logger: Logger }> => {
    const port = await getAvailablePort();
    const config = {
      browser: {
        timeoutMs: 500,
        attach: {
          enabled: true,
          host: "127.0.0.1",
          port,
          path: "/browser-attach/ws",
        },
      },
      exchange: { dir: ".mcp-xchange" },
      project: { sessionId: "test-session" },
    } as AppConfig;
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } satisfies Logger;
    const maintenanceStore = {
      getBrowserRecording: vi.fn(async () => null),
      setBrowserAttachment:
        overrides?.setBrowserAttachment ?? vi.fn(async () => undefined),
    } as unknown as MaintenanceStore;
    const server = new FirefoxAttachServer(
      config,
      logger,
      {} as SessionStore,
      maintenanceStore,
    );
    await server.start();
    cleanup.unshift(() => server.stop());
    const url = `ws://127.0.0.1:${port}/browser-attach/ws`;
    await waitForServer(url);
    return { server, url, logger };
  };

  it("rejects webpage origins and requires hello before peer messages", async () => {
    const { url, logger } = await startServer();

    await new Promise<void>((resolve, reject) => {
      const webpage = new WebSocket(url, { origin: "https://example.com" });
      webpage.once("unexpected-response", (_request, response) => {
        try {
          expect(response.statusCode).toBe(403);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      webpage.once("open", () => reject(new Error("Webpage origin was accepted")));
      webpage.once("error", () => undefined);
    });

    const withoutHello = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(withoutHello);
    const withoutHelloClosed = waitForClose(withoutHello);
    withoutHello.send(JSON.stringify({ type: "heartbeat", sent_at: "now" }));
    await expect(withoutHelloClosed).resolves.toEqual({
      code: 1008,
      reason: "hello_required",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Firefox attach protocol error",
      expect.objectContaining({ reason: "hello_required" }),
    );
  });

  it("accepts a valid extension, rejects invalid schemas, and replaces duplicates", async () => {
    const { server, url } = await startServer();
    const first = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(first);
    const firstAck = waitForMessageType(first, "hello_ack");
    first.send(JSON.stringify(hello()));
    await expect(firstAck).resolves.toMatchObject({
      ok: true,
      instance_id: "firefox-test",
    });
    expect(server.listInstances()).toHaveLength(1);

    const replacement = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(replacement);
    const firstClosed = waitForClose(first);
    const replacementAck = waitForMessageType(replacement, "hello_ack");
    replacement.send(JSON.stringify(hello()));
    await expect(replacementAck).resolves.toMatchObject({ ok: true });
    await expect(firstClosed).resolves.toEqual({
      code: 4001,
      reason: "replaced by newer connection",
    });

    const replacementClosed = waitForClose(replacement);
    replacement.send(
      JSON.stringify({
        type: "tab_updated",
        tab: { tab_id: -1, active: true, title: "bad", url: "about:blank" },
      }),
    );
    await expect(replacementClosed).resolves.toEqual({
      code: 1008,
      reason: "invalid_message",
    });
  });

  it("contains asynchronous message-handler failures to the offending socket", async () => {
    const { url, logger } = await startServer({
      setBrowserAttachment: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });
    const client = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(client);
    const ack = waitForMessageType(client, "hello_ack");
    client.send(JSON.stringify(hello("firefox-failing-store")));
    await ack;

    const closed = waitForClose(client);
    client.send(
      JSON.stringify({
        type: "attach_tab_selected",
        tab: {
          tab_id: 1,
          active: true,
          title: "Example",
          url: "https://example.com",
        },
      }),
    );
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "message_handler_failed",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Firefox attach protocol error",
      expect.objectContaining({ reason: "message_handler_failed" }),
    );
  });

  it("reaps a connected extension after its heartbeat expires", async () => {
    const { server, url } = await startServer();
    const client = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(client);
    const ack = waitForMessageType(client, "hello_ack");
    client.send(JSON.stringify(hello("firefox-stale")));
    await ack;

    const internals = server as unknown as {
      sockets: Set<{ lastSeenAt: number }>;
      reapStaleSockets: () => void;
    };
    for (const state of internals.sockets) {
      state.lastSeenAt = Date.now() - 46_000;
    }
    const closed = waitForClose(client);
    internals.reapStaleSockets();

    await expect(closed).resolves.toEqual({
      code: 4002,
      reason: "heartbeat timeout",
    });
  });

  it("closes a peer that exceeds its per-second message budget", async () => {
    const { server, url } = await startServer();
    const client = new WebSocket(url, { origin: EXTENSION_ORIGIN });
    await waitForOpen(client);
    const ack = waitForMessageType(client, "hello_ack");
    client.send(JSON.stringify(hello("firefox-rate-limited")));
    await ack;

    const internals = server as unknown as {
      sockets: Set<{
        rateWindowStartedAt: number;
        rateWindowMessageCount: number;
      }>;
    };
    for (const state of internals.sockets) {
      state.rateWindowStartedAt = Date.now();
      state.rateWindowMessageCount = 1_000;
    }
    const closed = waitForClose(client);
    client.send(JSON.stringify({ type: "heartbeat", sent_at: "now" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "rate_limit_exceeded",
    });
  });

  it("bounds nested recording data and tab arrays", () => {
    const oversizedTabs = Array.from({ length: 4097 }, (_, tab_id) => ({
      tab_id,
      active: false,
      title: "tab",
      url: "about:blank",
    }));
    expect(
      firefoxAttachInboundMessageSchema.safeParse({
        type: "list_tabs_result",
        request_id: "tabs",
        tabs: oversizedTabs,
      }).success,
    ).toBe(false);

    let nested: Record<string, unknown> = { value: true };
    for (let index = 0; index < 25; index += 1) {
      nested = { nested };
    }
    expect(
      firefoxAttachInboundMessageSchema.safeParse({
        type: "recording_event",
        recording_id: "recording",
        tab_id: 1,
        event: nested,
      }).success,
    ).toBe(false);
  });
});
