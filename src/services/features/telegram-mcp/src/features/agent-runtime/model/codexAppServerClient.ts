import { randomUUID } from "node:crypto";

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
  onComplete: (message: string) => void | Promise<void>;
  onError: (error: Error) => void | Promise<void>;
  onProgress?: ((event: CodexProgressEvent) => void | Promise<void>) | undefined;
  finalMessage: string;
  fallbackMessage: string;
};

export type CodexTurnSubmission = {
  threadId: string;
  turnId: string;
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
  private requestSequence = 0;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly logger: Logger,
    private readonly onApprovalRequest?: CodexApprovalHandler,
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
  }): Promise<CodexAppServerClient> {
    const socket = await openSocket(input.endpoint);
    const client = new CodexAppServerClient(
      socket,
      input.logger,
      input.onApprovalRequest,
    );
    try {
      await client.request("initialize", {
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
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  public async startThread(cwd: string): Promise<string> {
    const result = await this.request("thread/start", { cwd });
    return requireNestedString(result, "thread", "id");
  }

  public async submitTurn(input: {
    threadId: string;
    text: string;
    onComplete: (message: string) => void | Promise<void>;
    onError: (error: Error) => void | Promise<void>;
    onProgress?: ((event: CodexProgressEvent) => void | Promise<void>) | undefined;
  }): Promise<CodexTurnSubmission> {
    let turnId = "";
    await this.request(
      "turn/start",
      {
        threadId: input.threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: "text", text: input.text, text_elements: [] }],
      },
      (result) => {
        turnId = requireNestedString(result, "turn", "id");
        this.pendingTurns.set(turnId, {
          onComplete: input.onComplete,
          onError: input.onError,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          finalMessage: "",
          fallbackMessage: "",
        });
      },
    );
    return { threadId: input.threadId, turnId };
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
      void this.handleServerRequest(message);
      return;
    }

    if (!message.method) return;
    const params = asRecord(message.params);
    const turnId = typeof params?.turnId === "string" ? params.turnId : null;

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
      this.pendingTurns.delete(completedTurnId);
      if (turnRecord?.status === "failed") {
        const errorRecord = asRecord(turnRecord.error);
        void turn.onError(
          new Error(
            typeof errorRecord?.message === "string"
              ? errorRecord.message
              : "Codex turn failed.",
          ),
        );
        return;
      }
      const finalMessage = (turn.finalMessage || turn.fallbackMessage).trim();
      void turn.onComplete(
        finalMessage || "Codex completed the turn without a text response.",
      );
    }
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
      void turn.onError(error);
    }
    this.pendingTurns.clear();
  }
}
