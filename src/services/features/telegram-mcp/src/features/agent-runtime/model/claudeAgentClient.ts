import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  NonNullableUsage,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";

import type { Logger } from "../../../shared/lib/logger/logger";

type ClaudeAgentSdk = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  "listSessions" | "query"
>;

type ActiveClaudeTurn = {
  turnId: string;
  abortController: AbortController;
  query: Query;
};

export type ClaudeTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
};

export type ClaudeTurnResult = {
  message: string;
  usage: ClaudeTokenUsage;
};

export type ClaudeTurnSubmission = {
  sessionId: string;
  turnId: string;
};

type ClaudeTurnCallbacks = {
  onComplete: (result: ClaudeTurnResult) => void | Promise<void>;
  onError: (error: Error) => void | Promise<void>;
  onInterrupted?: (() => void | Promise<void>) | undefined;
};

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  return import("@anthropic-ai/claude-agent-sdk");
}

function normalizeUsage(
  usage: NonNullableUsage,
  totalCostUsd: number,
): ClaudeTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    totalCostUsd,
  };
}

function resultError(result: SDKResultMessage): Error {
  if (result.subtype === "success") {
    return new Error(result.result || "Claude turn failed.");
  }
  const details = result.errors.map((value) => value.trim()).filter(Boolean);
  return new Error(
    details.join("\n") ||
      `Claude turn failed with result subtype '${result.subtype}'.`,
  );
}

export class ClaudeAgentClient {
  private sessionId?: string | undefined;
  private activeTurn?: ActiveClaudeTurn | undefined;
  private closed = false;

  private constructor(
    private readonly cwd: string,
    private readonly executablePath: string,
    private readonly initialSessionIds: ReadonlySet<string>,
    private readonly sdk: ClaudeAgentSdk,
    private readonly logger: Logger,
  ) {}

  public static async prepare(input: {
    cwd: string;
    executablePath: string;
    logger: Logger;
    sdk?: ClaudeAgentSdk | undefined;
  }): Promise<ClaudeAgentClient> {
    const sdk = input.sdk ?? (await loadClaudeAgentSdk());
    const cwd = path.resolve(input.cwd);
    const sessions = await sdk.listSessions({
      dir: cwd,
      includeWorktrees: false,
      includeProgrammatic: false,
    });
    return new ClaudeAgentClient(
      cwd,
      input.executablePath,
      new Set(sessions.map((session) => session.sessionId)),
      sdk,
      input.logger,
    );
  }

  public getCwd(): string {
    return this.cwd;
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  public async attach(): Promise<string> {
    if (this.closed) {
      throw new Error("Claude Agent SDK client is stopped.");
    }
    if (this.sessionId) return this.sessionId;

    const sessions = await this.sdk.listSessions({
      dir: this.cwd,
      includeWorktrees: false,
      includeProgrammatic: false,
    });
    const candidates = sessions.filter(
      (session) =>
        !this.initialSessionIds.has(session.sessionId) &&
        this.matchesCwd(session),
    );
    if (candidates.length === 0) {
      throw new Error(
        "Claude has not created a conversation for this console yet. Send the first prompt in the local Claude console, then attach again.",
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `Cannot identify the Telly-managed Claude conversation: ${candidates.length} new sessions appeared in '${this.cwd}'. Close the extra Claude sessions and restart this console.`,
      );
    }
    this.sessionId = candidates[0]!.sessionId;
    this.logger.info("Claude Agent SDK attached to local CLI session", {
      sessionId: this.sessionId,
      cwd: this.cwd,
    });
    return this.sessionId;
  }

  public submitTurn(input: {
    text: string;
    onComplete: ClaudeTurnCallbacks["onComplete"];
    onError: ClaudeTurnCallbacks["onError"];
    onInterrupted?: ClaudeTurnCallbacks["onInterrupted"];
  }): ClaudeTurnSubmission {
    if (this.closed) {
      throw new Error("Claude Agent SDK client is stopped.");
    }
    if (!this.sessionId) {
      throw new Error("Claude session is not attached.");
    }
    if (this.activeTurn) {
      throw new Error(
        `A Claude turn is already running (${this.activeTurn.turnId}).`,
      );
    }

    const turnId = randomUUID();
    const abortController = new AbortController();
    const query = this.sdk.query({
      prompt: input.text,
      options: {
        resume: this.sessionId,
        forkSession: false,
        cwd: this.cwd,
        pathToClaudeCodeExecutable: this.executablePath,
        abortController,
        permissionMode: "dontAsk",
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });
    this.activeTurn = { turnId, abortController, query };
    void this.consumeTurn(turnId, query, abortController, input);
    return { sessionId: this.sessionId, turnId };
  }

  public interruptTurn(turnId: string): void {
    const active = this.activeTurn;
    if (!active || active.turnId !== turnId) {
      throw new Error(`Claude turn '${turnId}' is not active.`);
    }
    active.abortController.abort();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    const active = this.activeTurn;
    this.activeTurn = undefined;
    if (active) {
      active.abortController.abort();
      active.query.close();
    }
  }

  private matchesCwd(session: SDKSessionInfo): boolean {
    return !session.cwd || path.resolve(session.cwd) === this.cwd;
  }

  private async consumeTurn(
    turnId: string,
    query: Query,
    abortController: AbortController,
    callbacks: ClaudeTurnCallbacks,
  ): Promise<void> {
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of query as AsyncIterable<SDKMessage>) {
        if (message.type === "result") result = message;
      }
      if (!this.takeActiveTurn(turnId)) return;
      if (abortController.signal.aborted) {
        await callbacks.onInterrupted?.();
        return;
      }
      if (!result) {
        await callbacks.onError(
          new Error("Claude Agent SDK completed without a result message."),
        );
        return;
      }
      if (result.session_id !== this.sessionId) {
        await callbacks.onError(
          new Error(
            `Claude resumed unexpected session '${result.session_id}' instead of '${this.sessionId}'.`,
          ),
        );
        return;
      }
      if (result.subtype !== "success" || result.is_error) {
        await callbacks.onError(resultError(result));
        return;
      }
      await callbacks.onComplete({
        message:
          result.result.trim() ||
          "Claude completed the turn without a text response.",
        usage: normalizeUsage(result.usage, result.total_cost_usd),
      });
    } catch (error) {
      if (!this.takeActiveTurn(turnId)) return;
      if (abortController.signal.aborted) {
        await callbacks.onInterrupted?.();
        return;
      }
      await callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      query.close();
    }
  }

  private takeActiveTurn(turnId: string): boolean {
    if (this.activeTurn?.turnId !== turnId) return false;
    this.activeTurn = undefined;
    return true;
  }
}
