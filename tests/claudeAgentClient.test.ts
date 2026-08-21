import { describe, expect, it, vi } from "vitest";

import type {
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import { ClaudeAgentClient } from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/claudeAgentClient";

function createQuery(messages: () => AsyncGenerator<SDKMessage, void>): Query {
  const query = messages();
  return Object.assign(query, {
    close: vi.fn(),
  }) as unknown as Query;
}

function successResult(sessionId: string): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Claude SDK answer",
    session_id: sessionId,
    total_cost_usd: 0.012,
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    },
  } as unknown as SDKResultMessage;
}

describe("Claude Agent SDK client", () => {
  it("attaches only to the new local CLI session and resumes it exactly", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([
        {
          sessionId: "00000000-0000-4000-8000-000000000000",
          summary: "Old session",
          lastModified: 1,
          cwd: "/workspace",
        },
      ])
      .mockResolvedValueOnce([
        {
          sessionId: "00000000-0000-4000-8000-000000000000",
          summary: "Old session",
          lastModified: 1,
          cwd: "/workspace",
        },
        {
          sessionId,
          summary: "Telly session",
          lastModified: 2,
          cwd: "/workspace",
        },
      ]);
    const query = vi.fn(() =>
      createQuery(async function* () {
        yield successResult(sessionId);
      }),
    );
    const client = await ClaudeAgentClient.prepare({
      cwd: "/workspace",
      executablePath: "/bin/claude",
      logger: { info: vi.fn() } as unknown as Logger,
      sdk: { listSessions, query } as never,
    });

    await expect(client.attach()).resolves.toBe(sessionId);
    const completed = new Promise((resolve, reject) => {
      client.submitTurn({
        text: "Continue from Telegram",
        onComplete: resolve,
        onError: reject,
      });
    });

    await expect(completed).resolves.toEqual({
      message: "Claude SDK answer",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        totalCostUsd: 0.012,
      },
    });
    expect(listSessions).toHaveBeenNthCalledWith(1, {
      dir: "/workspace",
      includeWorktrees: false,
      includeProgrammatic: false,
    });
    expect(query).toHaveBeenCalledWith({
      prompt: "Continue from Telegram",
      options: expect.objectContaining({
        resume: sessionId,
        forkSession: false,
        cwd: "/workspace",
        pathToClaudeCodeExecutable: "/bin/claude",
        permissionMode: "dontAsk",
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      }),
    });
  });

  it("refuses to guess when multiple new CLI sessions appear", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          summary: "One",
          lastModified: 2,
          cwd: "/workspace",
        },
        {
          sessionId: "22222222-2222-4222-8222-222222222222",
          summary: "Two",
          lastModified: 3,
          cwd: "/workspace",
        },
      ]);
    const client = await ClaudeAgentClient.prepare({
      cwd: "/workspace",
      executablePath: "/bin/claude",
      logger: {} as Logger,
      sdk: { listSessions, query: vi.fn() } as never,
    });

    await expect(client.attach()).rejects.toThrow("2 new sessions");
  });

  it("aborts the exact active SDK turn", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          sessionId,
          summary: "Telly session",
          lastModified: 2,
          cwd: "/workspace",
        },
      ]);
    const query = vi.fn(
      (input: { options?: { abortController?: AbortController } }) =>
        createQuery(async function* () {
          await new Promise<void>((_resolve, reject) => {
            input.options!.abortController!.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
          yield successResult(sessionId);
        }),
    );
    const client = await ClaudeAgentClient.prepare({
      cwd: "/workspace",
      executablePath: "/bin/claude",
      logger: { info: vi.fn() } as unknown as Logger,
      sdk: { listSessions, query } as never,
    });
    await client.attach();
    const onInterrupted = vi.fn();
    const submission = client.submitTurn({
      text: "Long task",
      onComplete: vi.fn(),
      onError: vi.fn(),
      onInterrupted,
    });

    client.interruptTurn(submission.turnId);
    await vi.waitFor(() => expect(onInterrupted).toHaveBeenCalledOnce());
  });
});
