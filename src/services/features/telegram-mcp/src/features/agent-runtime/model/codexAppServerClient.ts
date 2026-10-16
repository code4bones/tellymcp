import { randomUUID } from "node:crypto";
import path from "node:path";

import WebSocket from "ws";

import type { Logger } from "../../../shared/lib/logger/logger";

type JsonRpcId = string | number;

type JsonRpcMessage = {
  id?: JsonRpcId | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?:
    | { code?: number | undefined; message?: string | undefined }
    | undefined;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  beforeResolve?: ((value: unknown) => void) | undefined;
};

type PendingTurn = {
  threadId: string;
  onComplete: (result: CodexTurnResult) => void | Promise<void>;
  onError: (error: Error) => void | Promise<void>;
  onInterrupted?: (() => void | Promise<void>) | undefined;
  onProgress?: ((event: CodexProgressEvent) => void | Promise<void>) | undefined;
  finalMessage: string;
  fallbackMessage: string;
  usage?: CodexTokenUsage | undefined;
  pollTimer?: NodeJS.Timeout | undefined;
  pollFailures: number;
  pollInFlight: boolean;
  emptyCompletedPolls: number;
  terminalRecord?: Record<string, unknown> | undefined;
};

type PendingThreadStart = {
  cwd: string;
  excludedThreadIds: ReadonlySet<string>;
  resolve: (threadId: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type CodexTurnSubmission = {
  threadId: string;
  turnId: string;
};

export type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type CodexTurnResult = {
  message: string;
  usage?: CodexTokenUsage | undefined;
};

export type CodexServerInfo = {
  userAgent: string;
  codexHome?: string | undefined;
  platformFamily?: string | undefined;
  platformOs?: string | undefined;
};

export type CodexThreadSummary = {
  id: string;
  cwd: string;
  preview: string;
  name?: string | undefined;
  cliVersion?: string | undefined;
  updatedAt?: number | undefined;
  status?: string | undefined;
};

export const TELLYMCP_CODEX_POLICY = {
  approvalPolicy: "on-request" as const,
  sandbox: "workspace-write" as const,
  networkAccess: false,
};

export type CodexProgressEvent = {
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "command" | "file-change" | "plan" | "mcp-tool" | "web-search";
  phase: "started" | "completed";
  message: string;
};

export type CodexApprovalDecision = "accept" | "decline";

export type CodexApprovalRequest = {
  requestId: JsonRpcId;
  kind: "command" | "file-change";
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  grantRoot?: string | undefined;
  networkHost?: string | undefined;
  networkProtocol?: string | undefined;
};

export type CodexApprovalHandler = (
  request: CodexApprovalRequest,
) => CodexApprovalDecision | Promise<CodexApprovalDecision>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function requireNestedString(
  value: unknown,
  parentKey: string,
  childKey: string,
): string {
  const parent = asRecord(value)?.[parentKey];
  const child = asRecord(parent)?.[childKey];
  if (typeof child !== "string" || !child.trim()) {
    throw new Error(
      `Codex app-server response is missing ${parentKey}.${childKey}.`,
    );
  }
  return child;
}

function parseServerInfo(value: unknown): CodexServerInfo {
  const record = asRecord(value);
  if (typeof record?.userAgent !== "string" || !record.userAgent.trim()) {
    throw new Error("Codex app-server initialize response is missing userAgent.");
  }
  return {
    userAgent: record.userAgent,
    ...(typeof record.codexHome === "string"
      ? { codexHome: record.codexHome }
      : {}),
    ...(typeof record.platformFamily === "string"
      ? { platformFamily: record.platformFamily }
      : {}),
    ...(typeof record.platformOs === "string"
      ? { platformOs: record.platformOs }
      : {}),
  };
}

function parseUsageBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const record = asRecord(value);
  const keys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  if (!record || keys.some((key) => typeof record[key] !== "number")) {
    return null;
  }
  return {
    totalTokens: record.totalTokens as number,
    inputTokens: record.inputTokens as number,
    cachedInputTokens: record.cachedInputTokens as number,
    cacheWriteInputTokens: record.cacheWriteInputTokens as number,
    outputTokens: record.outputTokens as number,
    reasoningOutputTokens: record.reasoningOutputTokens as number,
  };
}

function parseTokenUsage(value: unknown): CodexTokenUsage | null {
  const record = asRecord(value);
  const total = parseUsageBreakdown(record?.total);
  const last = parseUsageBreakdown(record?.last);
  if (!total || !last) return null;
  return {
    total,
    last,
    modelContextWindow:
      typeof record?.modelContextWindow === "number"
        ? record.modelContextWindow
        : null,
  };
}

export function codexUnixEndpointToWebSocketUrl(endpoint: string): string {
  const prefix = "unix://";
  if (!endpoint.startsWith(prefix)) {
    throw new Error(`Unsupported Codex app-server endpoint: ${endpoint}`);
  }
  const socketPath = endpoint.slice(prefix.length);
  if (!socketPath.startsWith("/")) {
    throw new Error("Codex app-server Unix socket path must be absolute.");
  }
  return `ws+unix://${socketPath}:/rpc`;
}

async function openSocket(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(codexUnixEndpointToWebSocketUrl(endpoint), {
    handshakeTimeout: 5_000,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(
        new Error(
          `Codex app-server rejected the WebSocket upgrade (${response.statusCode ?? "unknown"}).`,
        ),
      );
    });
  });
  return socket;
}

export class CodexAppServerClient {
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly pendingThreadStarts = new Set<PendingThreadStart>();
  private requestSequence = 0;
  private closed = false;
  private serverInfo?: CodexServerInfo | undefined;

  private constructor(
    private readonly socket: WebSocket,
    private readonly logger: Logger,
    private readonly onApprovalRequest?: CodexApprovalHandler,
    private readonly turnPollIntervalMs = 1_000,
  ) {
    socket.on("message", (data) => this.handleMessage(String(data)));
    socket.on("error", (error) => this.handleDisconnect(error));
    socket.on("close", (code, reason) =>
      this.handleDisconnect(
        new Error(
          `Codex app-server connection closed (${code}${String(reason) ? `: ${String(reason)}` : ""}).`,
        ),
      ),
    );
  }

  public static async connect(input: {
    endpoint: string;
    logger: Logger;
    clientVersion?: string | undefined;
    onApprovalRequest?: CodexApprovalHandler | undefined;
    turnPollIntervalMs?: number | undefined;
  }): Promise<CodexAppServerClient> {
    const socket = await openSocket(input.endpoint);
    const client = new CodexAppServerClient(
      socket,
      input.logger,
      input.onApprovalRequest,
      input.turnPollIntervalMs,
    );
    try {
      const initializeResult = await client.request("initialize", {
        clientInfo: {
          name: "tellymcp",
          title: "TellyMCP",
          version: input.clientVersion ?? "0.0.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      });
      client.serverInfo = parseServerInfo(initializeResult);
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  public getServerInfo(): CodexServerInfo {
    if (!this.serverInfo) {
      throw new Error("Codex app-server client is not initialized.");
    }
    return { ...this.serverInfo };
  }

  public async listThreads(cwd: string): Promise<CodexThreadSummary[]> {
    const normalizedCwd = path.resolve(cwd);
    const result = asRecord(
      await this.request("thread/list", {
        cwd: normalizedCwd,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    );
    if (!Array.isArray(result?.data)) {
      throw new Error("Codex app-server thread/list response is invalid.");
    }
    return result.data.flatMap((value) => {
      const thread = asRecord(value);
      if (
        typeof thread?.id !== "string" ||
        typeof thread.cwd !== "string" ||
        path.resolve(thread.cwd) !== normalizedCwd
      ) {
        return [];
      }
      const status = asRecord(thread.status);
      return [
        {
          id: thread.id,
          cwd: thread.cwd,
          preview: typeof thread.preview === "string" ? thread.preview : "",
          ...(typeof thread.name === "string" ? { name: thread.name } : {}),
          ...(typeof thread.cliVersion === "string"
            ? { cliVersion: thread.cliVersion }
            : {}),
          ...(typeof thread.updatedAt === "number"
            ? { updatedAt: thread.updatedAt }
            : {}),
          ...(typeof status?.type === "string"
            ? { status: status.type }
            : {}),
        },
      ];
    });
  }

  public async startThread(
    cwd: string,
    options: { ephemeral?: boolean | undefined } = {},
  ): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: path.resolve(cwd),
      approvalPolicy: TELLYMCP_CODEX_POLICY.approvalPolicy,
      sandbox: TELLYMCP_CODEX_POLICY.sandbox,
      serviceName: "tellymcp",
      ...(options.ephemeral ? { ephemeral: true } : {}),
    });
    return requireNestedString(result, "thread", "id");
  }

  public async resumeThread(input: {
    threadId: string;
    cwd: string;
  }): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId: input.threadId,
      cwd: path.resolve(input.cwd),
      approvalPolicy: TELLYMCP_CODEX_POLICY.approvalPolicy,
      sandbox: TELLYMCP_CODEX_POLICY.sandbox,
    });
    const resumedThreadId = requireNestedString(result, "thread", "id");
    if (resumedThreadId !== input.threadId) {
      throw new Error(
        `Codex resumed unexpected thread '${resumedThreadId}' instead of '${input.threadId}'.`,
      );
    }
    return resumedThreadId;
  }

  public waitForThreadStarted(input: {
    cwd: string;
    excludeThreadIds?: Iterable<string> | undefined;
    timeoutMs?: number | undefined;
  }): Promise<string> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Codex app-server connection is not available."),
      );
    }
    const timeoutMs = input.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const pending: PendingThreadStart = {
        cwd: path.resolve(input.cwd),
        excludedThreadIds: new Set(input.excludeThreadIds ?? []),
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pendingThreadStarts.delete(pending);
          reject(
            new Error(
              "Timed out waiting for the remote Codex TUI to start its thread.",
            ),
          );
        }, timeoutMs),
      };
      this.pendingThreadStarts.add(pending);
    });
  }

  public async submitTurn(input: {
    threadId: string;
    cwd: string;
    text: string;
    onComplete: (result: CodexTurnResult) => void | Promise<void>;
    onError: (error: Error) => void | Promise<void>;
    onInterrupted?: (() => void | Promise<void>) | undefined;
    onProgress?: ((event: CodexProgressEvent) => void | Promise<void>) | undefined;
  }): Promise<CodexTurnSubmission> {
    let turnId = "";
    await this.request(
      "turn/start",
      {
        threadId: input.threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: "text", text: input.text, text_elements: [] }],
        cwd: path.resolve(input.cwd),
        approvalPolicy: TELLYMCP_CODEX_POLICY.approvalPolicy,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [path.resolve(input.cwd)],
          networkAccess: TELLYMCP_CODEX_POLICY.networkAccess,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
      (result) => {
        turnId = requireNestedString(result, "turn", "id");
        this.pendingTurns.set(turnId, {
          threadId: input.threadId,
          onComplete: input.onComplete,
          onError: input.onError,
          ...(input.onInterrupted
            ? { onInterrupted: input.onInterrupted }
            : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          finalMessage: "",
          fallbackMessage: "",
          pollFailures: 0,
          pollInFlight: false,
          emptyCompletedPolls: 0,
        });
        this.scheduleTurnPoll(turnId);
      },
    );
    return { threadId: input.threadId, turnId };
  }

  public async interruptTurn(input: {
    threadId: string;
    turnId: string;
  }): Promise<void> {
    await this.request("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.rejectAll(new Error("Codex app-server client stopped."));
  }

  private request(
    method: string,
    params: unknown,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Codex app-server connection is not available."),
      );
    }
    const id = `tellymcp-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request '${method}' timed out.`));
      }, 10_000);
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout,
        ...(beforeResolve ? { beforeResolve } : {}),
      });
      this.socket.send(JSON.stringify({ method, id, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ method, params }));
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn("Ignoring invalid Codex app-server JSON", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ||
              `Codex app-server error ${message.error.code ?? "unknown"}.`,
          ),
        );
      } else {
        try {
          pending.beforeResolve?.(message.result);
          pending.resolve(message.result);
        } catch (error) {
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message).catch((error) => {
        this.logger.warn("Codex server request handling failed", {
          method: message.method,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    if (!message.method) return;
    const params = asRecord(message.params);
    const turnId = typeof params?.turnId === "string" ? params.turnId : null;

    if (message.method === "thread/started") {
      const thread = asRecord(params?.thread);
      const threadId =
        typeof thread?.id === "string" ? thread.id.trim() : "";
      const cwd = typeof thread?.cwd === "string" ? path.resolve(thread.cwd) : "";
      if (threadId && cwd) {
        for (const pending of [...this.pendingThreadStarts]) {
          if (
            pending.cwd !== cwd ||
            pending.excludedThreadIds.has(threadId)
          ) {
            continue;
          }
          this.pendingThreadStarts.delete(pending);
          clearTimeout(pending.timeout);
          pending.resolve(threadId);
        }
      }
      return;
    }

    if (message.method === "thread/tokenUsage/updated" && turnId) {
      const turn = this.pendingTurns.get(turnId);
      const usage = parseTokenUsage(params?.tokenUsage);
      if (turn && usage) turn.usage = usage;
      return;
    }

    if (message.method === "turn/plan/updated" && turnId) {
      const turn = this.pendingTurns.get(turnId);
      const plan = Array.isArray(params?.plan) ? params.plan : [];
      const completed =
        plan.length > 0 &&
        plan.every((entry) => asRecord(entry)?.status === "completed");
      if (turn?.onProgress) {
        void Promise.resolve(
          turn.onProgress({
            threadId:
              typeof params?.threadId === "string" ? params.threadId : "",
            turnId,
            itemId: `plan-${turnId}`,
            kind: "plan",
            phase: completed ? "completed" : "started",
            message: "Codex updated its plan.",
          }),
        ).catch((error) => {
          this.logger.warn("Codex plan-progress callback failed", {
            turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return;
    }

    if (
      (message.method === "item/started" ||
        message.method === "item/completed") &&
      turnId
    ) {
      const turn = this.pendingTurns.get(turnId);
      const item = asRecord(params?.item);
      const itemId = typeof item?.id === "string" ? item.id : "";
      const itemType = typeof item?.type === "string" ? item.type : "";
      const phase =
        message.method === "item/started" ? "started" : "completed";
      const progress = this.normalizeProgressEvent({
        threadId:
          typeof params?.threadId === "string" ? params.threadId : "",
        turnId,
        itemId,
        itemType,
        phase,
      });
      if (turn?.onProgress && progress) {
        void Promise.resolve(turn.onProgress(progress)).catch((error) => {
          this.logger.warn("Codex progress callback failed", {
            threadId: progress.threadId,
            turnId: progress.turnId,
            itemId: progress.itemId,
            kind: progress.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    if (message.method === "item/agentMessage/delta" && turnId) {
      const turn = this.pendingTurns.get(turnId);
      if (turn && typeof params?.delta === "string") {
        turn.fallbackMessage += params.delta;
      }
      return;
    }

    if (message.method === "item/completed" && turnId) {
      const turn = this.pendingTurns.get(turnId);
      const item = asRecord(params?.item);
      if (
        turn &&
        item?.type === "agentMessage" &&
        typeof item.text === "string"
      ) {
        if (item.phase === "final_answer") {
          turn.finalMessage = item.text;
        } else if (!turn.finalMessage) {
          turn.fallbackMessage = item.text;
        }
      }
      return;
    }

    if (message.method === "turn/completed") {
      const turnRecord = asRecord(params?.turn);
      const completedTurnId =
        typeof turnRecord?.id === "string" ? turnRecord.id : turnId;
      if (!completedTurnId) return;
      const turn = this.pendingTurns.get(completedTurnId);
      if (!turn) return;
      this.captureTurnMessages(turn, turnRecord);
      if (
        turnRecord?.status === "completed" &&
        !turn.finalMessage.trim() &&
        !turn.fallbackMessage.trim()
      ) {
        turn.terminalRecord = turnRecord;
        this.scheduleTurnPoll(completedTurnId, 0);
        return;
      }
      this.settleTurn(completedTurnId, turnRecord);
    }
  }

  private scheduleTurnPoll(
    turnId: string,
    delayMs = this.turnPollIntervalMs,
  ): void {
    const turn = this.pendingTurns.get(turnId);
    if (!turn || this.closed) return;
    clearTimeout(turn.pollTimer);
    turn.pollTimer = setTimeout(() => {
      void this.pollTurn(turnId);
    }, delayMs);
  }

  private async pollTurn(turnId: string): Promise<void> {
    const turn = this.pendingTurns.get(turnId);
    if (!turn || turn.pollInFlight || this.closed) return;
    turn.pollInFlight = true;
    try {
      const result = asRecord(
        await this.request("thread/read", {
          threadId: turn.threadId,
          includeTurns: true,
        }),
      );
      const threadRecord = asRecord(result?.thread);
      const turns = Array.isArray(threadRecord?.turns)
        ? threadRecord.turns
        : [];
      const turnRecord = turns
        .map(asRecord)
        .find((candidate) => candidate?.id === turnId);
      const current = this.pendingTurns.get(turnId);
      if (!current) return;
      current.pollInFlight = false;
      turn.pollFailures = 0;
      if (
        !turnRecord ||
        !["completed", "failed", "interrupted"].includes(
          String(turnRecord.status),
        )
      ) {
        this.scheduleTurnPoll(turnId);
        return;
      }
      this.captureTurnMessages(turn, turnRecord);
      if (
        turnRecord.status === "completed" &&
        !turn.finalMessage.trim() &&
        !turn.fallbackMessage.trim() &&
        turn.emptyCompletedPolls < 5
      ) {
        turn.emptyCompletedPolls += 1;
        this.scheduleTurnPoll(turnId);
        return;
      }
      this.logger.debug("Codex turn completion recovered through thread/read", {
        threadId: turn.threadId,
        turnId,
        status: turnRecord.status,
      });
      this.settleTurn(turnId, turnRecord);
    } catch (error) {
      const current = this.pendingTurns.get(turnId);
      if (!current || this.closed) return;
      current.pollInFlight = false;
      current.pollFailures += 1;
      if (current.pollFailures === 1 || current.pollFailures % 30 === 0) {
        this.logger.warn("Codex turn completion polling failed", {
          threadId: current.threadId,
          turnId,
          failures: current.pollFailures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (current.terminalRecord && current.pollFailures >= 5) {
        this.settleTurn(turnId, current.terminalRecord);
        return;
      }
      this.scheduleTurnPoll(turnId);
    }
  }

  private captureTurnMessages(
    pending: PendingTurn,
    turnRecord: Record<string, unknown> | null,
  ): void {
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
    const agentMessages = items.flatMap((value) => {
      const item = asRecord(value);
      return item?.type === "agentMessage" && typeof item.text === "string"
        ? [{ text: item.text, phase: item.phase }]
        : [];
    });
    const finalMessages = agentMessages
      .filter((item) => item.phase === "final_answer")
      .map((item) => item.text.trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      pending.finalMessage = finalMessages.join("\n\n");
      return;
    }
    const fallback = agentMessages.at(-1)?.text.trim();
    if (fallback && !pending.finalMessage) pending.fallbackMessage = fallback;
  }

  private settleTurn(
    turnId: string,
    turnRecord: Record<string, unknown> | null,
  ): void {
    const turn = this.pendingTurns.get(turnId);
    if (!turn) return;
    this.pendingTurns.delete(turnId);
    clearTimeout(turn.pollTimer);
    if (turnRecord?.status === "interrupted") {
      void Promise.resolve(turn.onInterrupted?.()).catch((error) => {
        this.logger.warn("Codex onInterrupted callback failed", {
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (turnRecord?.status === "failed") {
      const errorRecord = asRecord(turnRecord.error);
      void Promise.resolve(
        turn.onError(
          new Error(
            typeof errorRecord?.message === "string"
              ? errorRecord.message
              : "Codex turn failed.",
          ),
        ),
      ).catch((error) => {
        this.logger.warn("Codex onError callback failed", {
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    const finalMessage = (turn.finalMessage || turn.fallbackMessage).trim();
    void Promise.resolve(
      turn.onComplete({
        message:
          finalMessage || "Codex completed the turn without a text response.",
        ...(turn.usage ? { usage: turn.usage } : {}),
      }),
    ).catch((error) => {
      this.logger.warn("Codex onComplete callback failed", {
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private normalizeProgressEvent(input: {
    threadId: string;
    turnId: string;
    itemId: string;
    itemType: string;
    phase: "started" | "completed";
  }): CodexProgressEvent | null {
    const common = {
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      phase: input.phase,
    };
    if (input.itemType === "commandExecution") {
      return {
        ...common,
        kind: "command",
        message:
          input.phase === "started"
            ? "Codex is running a command."
            : "Codex finished a command.",
      };
    }
    if (input.itemType === "fileChange") {
      return {
        ...common,
        kind: "file-change",
        message:
          input.phase === "started"
            ? "Codex is preparing file changes."
            : "Codex finished applying file changes.",
      };
    }
    if (input.itemType === "plan") {
      return {
        ...common,
        kind: "plan",
        message: "Codex updated its plan.",
      };
    }
    if (input.itemType === "mcpToolCall") {
      return {
        ...common,
        kind: "mcp-tool",
        message:
          input.phase === "started"
            ? "Codex is using an MCP tool."
            : "Codex finished using an MCP tool.",
      };
    }
    if (input.itemType === "webSearch") {
      return {
        ...common,
        kind: "web-search",
        message:
          input.phase === "started"
            ? "Codex is searching the web."
            : "Codex finished searching the web.",
      };
    }
    return null;
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const method = message.method ?? "";
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      const params = asRecord(message.params);
      const threadId =
        typeof params?.threadId === "string" ? params.threadId : "";
      const turnId =
        typeof params?.turnId === "string" ? params.turnId : "";
      const itemId =
        typeof params?.itemId === "string" ? params.itemId : "";
      let decision: CodexApprovalDecision = "decline";

      if (!threadId || !turnId || !itemId) {
        this.logger.warn("Declining malformed Codex approval request", {
          method,
          hasThreadId: Boolean(threadId),
          hasTurnId: Boolean(turnId),
          hasItemId: Boolean(itemId),
        });
      } else if (!this.onApprovalRequest) {
        this.logger.warn("Declining Codex approval without a configured handler", {
          method,
          threadId,
          turnId,
          itemId,
        });
      } else {
        try {
          const networkContext = asRecord(params?.networkApprovalContext);
          decision = await this.onApprovalRequest({
            requestId: message.id!,
            kind:
              method === "item/commandExecution/requestApproval"
                ? "command"
                : "file-change",
            threadId,
            turnId,
            itemId,
            ...(typeof params?.reason === "string"
              ? { reason: params.reason }
              : {}),
            ...(typeof params?.command === "string"
              ? { command: params.command }
              : {}),
            ...(typeof params?.cwd === "string" ? { cwd: params.cwd } : {}),
            ...(typeof params?.grantRoot === "string"
              ? { grantRoot: params.grantRoot }
              : {}),
            ...(typeof networkContext?.host === "string"
              ? { networkHost: networkContext.host }
              : {}),
            ...(typeof networkContext?.protocol === "string"
              ? { networkProtocol: networkContext.protocol }
              : {}),
          });
        } catch (error) {
          this.logger.warn("Codex approval handler failed; declining request", {
            method,
            threadId,
            turnId,
            itemId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!this.closed && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({ id: message.id, result: { decision } }),
        );
      }
      return;
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.socket.send(
        JSON.stringify({
          id: message.id,
          result: {
            decision: {
              denied: { rejection: "Telegram approval UI is not enabled yet." },
            },
          },
        }),
      );
      return;
    }
    this.socket.send(
      JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      }),
    );
  }

  private handleDisconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const turn of this.pendingTurns.values()) {
      clearTimeout(turn.pollTimer);
      void Promise.resolve(turn.onError(error)).catch((callbackError) => {
        this.logger.warn("Codex onError callback failed during rejectAll", {
          error:
            callbackError instanceof Error
              ? callbackError.message
              : String(callbackError),
        });
      });
    }
    this.pendingTurns.clear();
    for (const pending of this.pendingThreadStarts) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingThreadStarts.clear();
  }
}
