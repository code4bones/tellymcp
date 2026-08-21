import { existsSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import {
  CodexAppServerClient,
  codexUnixEndpointToWebSocketUrl,
} from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/codexAppServerClient";

const socketPaths: string[] = [];

afterEach(() => {
  for (const socketPath of socketPaths.splice(0)) {
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  }
});

describe("Codex app-server client", () => {
  it("maps a private Unix endpoint to the app-server RPC path", () => {
    expect(
      codexUnixEndpointToWebSocketUrl("unix:///tmp/tellymcp-codex.sock"),
    ).toBe("ws+unix:///tmp/tellymcp-codex.sock:/rpc");
    expect(() =>
      codexUnixEndpointToWebSocketUrl("ws://127.0.0.1:4500"),
    ).toThrow("Unsupported");
  });

  it("initializes, starts a thread, submits a turn, and returns its final message", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `tellymcp-codex-client-${process.pid}-${Date.now()}.sock`,
    );
    socketPaths.push(socketPath);
    const httpServer = http.createServer();
    const webSocketServer = new WebSocketServer({
      server: httpServer,
      path: "/rpc",
      perMessageDeflate: false,
    });
    const methods: string[] = [];
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw)) as {
          id?: string;
          method: string;
        };
        methods.push(request.method);
        if (request.method === "initialize") {
          socket.send(
            JSON.stringify({ id: request.id, result: { userAgent: "test" } }),
          );
        } else if (request.method === "thread/start") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { thread: { id: "thread-1" } },
            }),
          );
        } else if (request.method === "turn/start") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { turn: { id: "turn-1" } },
            }),
          );
          setImmediate(() => {
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "agentMessage",
                    text: "Final answer",
                    phase: "final_answer",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: { id: "turn-1", status: "completed" },
                },
              }),
            );
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const client = await CodexAppServerClient.connect({
      endpoint: `unix://${socketPath}`,
      logger: {
        warn: vi.fn(),
      } as unknown as Logger,
      clientVersion: "test",
    });
    const threadId = await client.startThread("/workspace");
    const completed = new Promise<string>((resolve, reject) => {
      void client.submitTurn({
        threadId,
        text: "Continue",
        onComplete: resolve,
        onError: reject,
      });
    });

    await expect(completed).resolves.toBe("Final answer");
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);

    client.close();
    await new Promise<void>((resolve) =>
      webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
