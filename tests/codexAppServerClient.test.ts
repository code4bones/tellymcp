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
    let approvalResponse: unknown;
    let threadStartParams: unknown;
    let turnStartParams: unknown;
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw)) as {
          id?: string;
          method?: string;
          result?: unknown;
        };
        if (request.method) methods.push(request.method);
        if (request.method === "initialize") {
          socket.send(
            JSON.stringify({ id: request.id, result: { userAgent: "test" } }),
          );
        } else if (request.method === "thread/start") {
          threadStartParams = (request as { params?: unknown }).params;
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { thread: { id: "thread-1" } },
            }),
          );
        } else if (request.method === "thread/list") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                data: [
                  {
                    id: "thread-existing",
                    cwd: "/workspace",
                    preview: "Existing work",
                    cliVersion: "0.147.0",
                    updatedAt: 123,
                    status: { type: "idle" },
                  },
                  {
                    id: "thread-other",
                    cwd: "/other",
                    preview: "Wrong project",
                  },
                ],
                nextCursor: null,
              },
            }),
          );
        } else if (request.method === "thread/resume") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { thread: { id: "thread-existing" } },
            }),
          );
        } else if (request.method === "turn/start") {
          turnStartParams = (request as { params?: unknown }).params;
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { turn: { id: "turn-1" } },
            }),
          );
          setImmediate(() => {
            socket.send(
              JSON.stringify({
                method: "item/started",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    id: "command-1",
                    type: "commandExecution",
                    command: "curl https://secret.example/token",
                    status: "inProgress",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                id: "approval-1",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "command-1",
                  reason: "Needs network access",
                  command: "curl https://example.com",
                  cwd: "/workspace",
                  networkApprovalContext: {
                    host: "example.com",
                    protocol: "https",
                  },
                },
              }),
            );
          });
        } else if (request.id === "approval-1") {
          approvalResponse = request.result;
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  id: "command-1",
                  type: "commandExecution",
                  command: "curl https://secret.example/token",
                  status: "completed",
                },
              },
            }),
          );
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
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                tokenUsage: {
                  total: {
                    totalTokens: 18,
                    inputTokens: 10,
                    cachedInputTokens: 4,
                    cacheWriteInputTokens: 0,
                    outputTokens: 8,
                    reasoningOutputTokens: 2,
                  },
                  last: {
                    totalTokens: 18,
                    inputTokens: 10,
                    cachedInputTokens: 4,
                    cacheWriteInputTokens: 0,
                    outputTokens: 8,
                    reasoningOutputTokens: 2,
                  },
                  modelContextWindow: 200000,
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/plan/updated",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                explanation: "sensitive plan details",
                plan: [{ step: "Finish", status: "completed" }],
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
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const onApprovalRequest = vi.fn(async () => "accept" as const);
    const onProgress = vi.fn();
    const client = await CodexAppServerClient.connect({
      endpoint: `unix://${socketPath}`,
      logger: {
        warn: vi.fn(),
      } as unknown as Logger,
      clientVersion: "test",
      onApprovalRequest,
    });
    await expect(client.listThreads("/workspace")).resolves.toEqual([
      {
        id: "thread-existing",
        cwd: "/workspace",
        preview: "Existing work",
        cliVersion: "0.147.0",
        updatedAt: 123,
        status: "idle",
      },
    ]);
    const remoteTuiThread = client.waitForThreadStarted({
      cwd: "/workspace",
      excludeThreadIds: ["thread-existing"],
    });
    for (const socket of webSocketServer.clients) {
      socket.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: { id: "thread-existing", cwd: "/workspace" },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          method: "thread/started",
          params: { thread: { id: "thread-other", cwd: "/other" } },
        }),
      );
      socket.send(
        JSON.stringify({
          method: "thread/started",
          params: { thread: { id: "thread-from-tui", cwd: "/workspace" } },
        }),
      );
    }
    await expect(remoteTuiThread).resolves.toBe("thread-from-tui");
    await expect(
      client.resumeThread({
        threadId: "thread-existing",
        cwd: "/workspace",
      }),
    ).resolves.toBe("thread-existing");
    const threadId = await client.startThread("/workspace");
    const completed = new Promise<{
      message: string;
      usage?: { last: { totalTokens: number } };
    }>((resolve, reject) => {
      void client.submitTurn({
        threadId,
        cwd: "/workspace",
        text: "Continue",
        onComplete: resolve,
        onError: reject,
        onProgress,
      });
    });

    await expect(completed).resolves.toMatchObject({
      message: "Final answer",
      usage: { last: { totalTokens: 18 } },
    });
    expect(onApprovalRequest).toHaveBeenCalledWith({
      requestId: "approval-1",
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Needs network access",
      command: "curl https://example.com",
      cwd: "/workspace",
      networkHost: "example.com",
      networkProtocol: "https",
    });
    expect(approvalResponse).toEqual({ decision: "accept" });
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      kind: "command",
      phase: "started",
      message: "Codex is running a command.",
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      kind: "command",
      phase: "completed",
      message: "Codex finished a command.",
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "plan-turn-1",
      kind: "plan",
      phase: "completed",
      message: "Codex updated its plan.",
    });
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(
      "secret.example",
    );
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(
      "sensitive plan details",
    );
    expect(threadStartParams).toEqual({
      cwd: "/workspace",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "tellymcp",
    });
    expect(turnStartParams).toMatchObject({
      threadId: "thread-1",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/list",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);

    client.close();
    await new Promise<void>((resolve) =>
      webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("interrupts the exact active turn and reports interrupted completion", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `tellymcp-codex-interrupt-${process.pid}-${Date.now()}.sock`,
    );
    socketPaths.push(socketPath);
    const httpServer = http.createServer();
    const webSocketServer = new WebSocketServer({
      server: httpServer,
      path: "/rpc",
      perMessageDeflate: false,
    });
    let interruptParams: unknown;
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw)) as {
          id?: string;
          method?: string;
          params?: unknown;
        };
        if (request.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                userAgent: "codex-cli/0.147.0",
                codexHome: "/tmp/codex-home",
                platformFamily: "unix",
                platformOs: "linux",
              },
            }),
          );
        } else if (request.method === "turn/start") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { turn: { id: "turn-9" } },
            }),
          );
        } else if (request.method === "turn/interrupt") {
          interruptParams = request.params;
          socket.send(JSON.stringify({ id: request.id, result: {} }));
          setImmediate(() => {
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-7",
                  turn: { id: "turn-9", status: "interrupted" },
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
      logger: { warn: vi.fn() } as unknown as Logger,
    });
    const onComplete = vi.fn();
    const onInterrupted = vi.fn();
    const submission = await client.submitTurn({
      threadId: "thread-7",
      cwd: "/workspace",
      text: "Long task",
      onComplete,
      onInterrupted,
      onError: vi.fn(),
    });

    await client.interruptTurn(submission);
    await vi.waitFor(() => expect(onInterrupted).toHaveBeenCalledOnce());
    expect(interruptParams).toEqual({
      threadId: "thread-7",
      turnId: "turn-9",
    });
    expect(onComplete).not.toHaveBeenCalled();

    client.close();
    await new Promise<void>((resolve) =>
      webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
