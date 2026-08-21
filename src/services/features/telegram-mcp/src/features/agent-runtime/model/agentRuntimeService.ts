import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type { SessionStore } from "../../../shared/api/storage/contract";
import {
  ensureTerminalTargetForSession,
  sendTerminalLiteralLine,
  subscribeForegroundTerminal,
  type TerminalExitInfo,
} from "../../../shared/integrations/terminal/client";
import type { Logger } from "../../../shared/lib/logger/logger";
import { getTellyMcpPackageVersion } from "../../../shared/lib/version/versionHandshake";
import {
  inspectAgentProviders,
  resolveAgentProvider,
  type AgentProviderStatus,
  type AgentTransportKind,
  type CodingAgentId,
} from "./agentProviderRegistry";
import {
  CodexAppServerClient,
  TELLYMCP_CODEX_POLICY,
  type CodexApprovalDecision,
  type CodexApprovalHandler,
  type CodexApprovalRequest,
  type CodexServerInfo,
  type CodexTokenUsage,
} from "./codexAppServerClient";
import {
  assertCodexRuntimeCompatible,
  inspectCodexRuntime,
  type CodexRuntimeDiagnostics,
} from "./codexRuntimeDiagnostics";

export type AgentProcessState = "idle" | "running";

export type AgentRuntimeStatus = AgentProviderStatus & {
  state: AgentProcessState;
  startedAt?: string | undefined;
  lastExitCode?: number | undefined;
};

export type ListAgentRuntimeInput = {
  session_id: string;
};

export type ListAgentRuntimeOutput = {
  session_id: string;
  agents: AgentRuntimeStatus[];
  active_agent_id?: CodingAgentId | undefined;
  turn_in_progress?: boolean | undefined;
  active_turn_id?: string | undefined;
  codex_runtime?:
    | {
        thread_id: string;
        cwd: string;
        cli_version?: string | undefined;
        server_user_agent?: string | undefined;
        approval_policy: "on-request";
        sandbox: "workspace-write";
        network_access: false;
        last_turn?: AgentTurnCompletion | undefined;
      }
    | undefined;
};

export type AgentTurnCompletion = {
  status: "completed" | "interrupted" | "failed";
  finished_at: string;
  usage?: CodexTokenUsage | undefined;
  error?: string | undefined;
};

export type StartAgentRuntimeInput = {
  session_id: string;
  agent_id: string;
};

export type StartAgentRuntimeOutput = {
  ok: true;
  session_id: string;
  terminal_target: string;
  agent_id: CodingAgentId;
  provider_id: string;
  transport: AgentTransportKind;
  started_at: string;
  thread_id?: string | undefined;
};

export type AttachAgentRuntimeInput = {
  session_id: string;
  agent_id: string;
};

export type AttachAgentRuntimeOutput = {
  ok: true;
  session_id: string;
  agent_id: CodingAgentId;
  provider_id: string;
  transport: AgentTransportKind;
  started_at: string;
  thread_id?: string | undefined;
};

export type SubmitAgentMessageInput = {
  session_id: string;
  message: string;
  agent_id?: string | undefined;
};

export type SubmitAgentMessageOutput =
  | { handled: false; session_id: string }
  | {
      handled: true;
      session_id: string;
      agent_id: "codex";
      thread_id: string;
      turn_id: string;
    };

export type StopAgentTurnInput = {
  session_id: string;
};

export type StopAgentTurnOutput = {
  ok: true;
  session_id: string;
  agent_id: "codex";
  thread_id: string;
  turn_id: string;
  status: "interrupt_requested";
};

type CodexTurnClient = Pick<
  CodexAppServerClient,
  "submitTurn" | "interruptTurn" | "close"
>;

export type ManagedAppServer = {
  endpoint: string;
  threadId: string;
  cwd: string;
  client: CodexTurnClient;
  diagnostics?: CodexRuntimeDiagnostics | undefined;
  serverInfo?: CodexServerInfo | undefined;
  stop: () => void;
};

export type ManagedAppServerBootstrap = Omit<ManagedAppServer, "threadId"> & {
  waitForThread: () => Promise<string>;
};

type RunningAgent = {
  agentId: CodingAgentId;
  startedAt: string;
  sentinel: string;
  outputTail: string;
  unsubscribe: () => void;
  stopBackend: () => void;
  appServer?: ManagedAppServer | undefined;
  turnInProgress: boolean;
  activeTurnId?: string | undefined;
  cancelProgress?: (() => void) | undefined;
  lastTurn?: AgentTurnCompletion | undefined;
};

type LastAgentExit = {
  agentId: CodingAgentId;
  exitCode: number;
};

type AgentRuntimeDependencies = {
  inspectProviders?: () => AgentProviderStatus[];
  sendLine?: (
    config: AppConfig["terminal"],
    target: string,
    text: string,
  ) => Promise<void>;
  subscribe?: (
    target: string,
    input: {
      onData?: ((data: string) => void) | undefined;
      onExit?: ((info: TerminalExitInfo) => void) | undefined;
    },
  ) => () => void;
  ensureTarget?: (
    config: AppConfig["terminal"],
    input: {
      sessionId: string;
      cwd?: string | undefined;
      target?: string | undefined;
    },
  ) => string | null;
  startAppServer?: (input: {
    executablePath: string;
    sessionId: string;
    cwd: string;
    logger: Logger;
    onApprovalRequest: CodexApprovalHandler;
    clientVersion?: string | undefined;
  }) => Promise<ManagedAppServerBootstrap>;
  requestApproval?: (input: {
    sessionId: string;
    request: CodexApprovalRequest;
  }) => Promise<CodexApprovalDecision>;
  notifyTelegram?: (input: {
    sessionId: string;
    message: string;
  }) => Promise<void>;
};

const CODEX_PROGRESS_DEBOUNCE_MS = 1_500;
const CODEX_PROGRESS_MAX_UPDATES = 3;

export function createCodexProgressRelay(input: {
  notify: (message: string) => void | Promise<void>;
  isActive: () => boolean;
  debounceMs?: number;
  maxUpdates?: number;
}): { push: (message: string) => void; stop: () => void } {
  const debounceMs = input.debounceMs ?? CODEX_PROGRESS_DEBOUNCE_MS;
  const maxUpdates = input.maxUpdates ?? CODEX_PROGRESS_MAX_UPDATES;
  let timer: NodeJS.Timeout | undefined;
  let pendingMessage = "";
  let lastDeliveredMessage = "";
  let deliveredUpdates = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    pendingMessage = "";
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (
      stopped ||
      timer ||
      !pendingMessage ||
      deliveredUpdates >= maxUpdates
    ) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !input.isActive()) {
        stop();
        return;
      }
      const message = pendingMessage;
      pendingMessage = "";
      if (!message || message === lastDeliveredMessage) return;
      lastDeliveredMessage = message;
      deliveredUpdates += 1;
      void Promise.resolve()
        .then(() => input.notify(`⏳ ${message}`))
        .catch(() => undefined)
        .finally(() => {
          schedule();
        });
    }, debounceMs);
  };

  return {
    push: (message) => {
      if (stopped || deliveredUpdates >= maxUpdates) return;
      const normalized = message.trim().slice(0, 300);
      if (!normalized || normalized === lastDeliveredMessage) return;
      pendingMessage = normalized;
      schedule();
    },
    stop,
  };
}

function waitForSocket(input: {
  socketPath: string;
  isExited: () => boolean;
  readError: () => string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(input.socketPath)) {
        resolve();
        return;
      }
      if (input.isExited()) {
        reject(
          new Error(
            `Codex app-server exited before opening its Unix socket${input.readError() ? `: ${input.readError()}` : "."}`,
          ),
        );
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `Timed out waiting for Codex app-server${input.readError() ? `: ${input.readError()}` : "."}`,
          ),
        );
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

const UNIX_SOCKET_PATH_MAX_BYTES = 100;

function canUseCodexSocketDirectory(directory: string): boolean {
  try {
    const stats = statSync(directory);
    const ownedByCurrentUser =
      typeof process.getuid !== "function" || stats.uid === process.getuid();
    return (
      stats.isDirectory() && ownedByCurrentUser && (stats.mode & 0o022) === 0
    );
  } catch {
    return false;
  }
}

export function createCodexSocketLocation(input: {
  cwd: string;
  socketDirectory?: string | undefined;
}): {
  socketPath: string;
  cleanup: () => void;
} {
  const socketId = createHash("sha256")
    .update(`${process.pid}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 12);
  const projectSocketDirectory = path.resolve(
    input.socketDirectory ?? path.join(input.cwd, ".tellymcp"),
  );
  mkdirSync(projectSocketDirectory, { recursive: true, mode: 0o700 });
  const projectSocketPath = path.join(
    projectSocketDirectory,
    `codex-${socketId}.sock`,
  );
  const useProjectDirectory =
    canUseCodexSocketDirectory(projectSocketDirectory) &&
    Buffer.byteLength(projectSocketPath) <= UNIX_SOCKET_PATH_MAX_BYTES;
  const privateDirectory = useProjectDirectory
    ? null
    : mkdtempSync(path.join(os.tmpdir(), "tellymcp-codex-"));
  const socketPath = useProjectDirectory
    ? projectSocketPath
    : path.join(privateDirectory!, `c-${socketId}.sock`);
  let cleaned = false;

  return {
    socketPath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(socketPath, { force: true });
      if (privateDirectory) {
        rmSync(privateDirectory, { force: true, recursive: true });
      }
    },
  };
}

export async function startCodexAppServer(input: {
  executablePath: string;
  sessionId: string;
  cwd: string;
  logger: Logger;
  onApprovalRequest: CodexApprovalHandler;
  clientVersion?: string | undefined;
  socketDirectory?: string | undefined;
}): Promise<ManagedAppServerBootstrap> {
  const diagnostics = inspectCodexRuntime(input.executablePath);
  assertCodexRuntimeCompatible(diagnostics);
  const socketLocation = createCodexSocketLocation({
    cwd: input.cwd,
    ...(input.socketDirectory
      ? { socketDirectory: input.socketDirectory }
      : {}),
  });
  const { socketPath } = socketLocation;
  const endpoint = `unix://${socketPath}`;
  const child = spawn(
    input.executablePath,
    ["app-server", "--listen", endpoint],
    {
      cwd: input.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let exited = false;
  let stopped = false;
  let errorTail = "";
  let client: CodexAppServerClient | null = null;

  child.stderr?.on("data", (chunk: Buffer | string) => {
    errorTail = `${errorTail}${String(chunk)}`.trim().slice(-1_024);
  });
  child.on("error", (error) => {
    exited = true;
    errorTail = error.message;
  });
  child.on("exit", (exitCode, signal) => {
    exited = true;
    if (!stopped) {
      input.logger.warn("Codex app-server exited", {
        sessionId: input.sessionId,
        exitCode,
        signal,
        errorTail,
      });
    }
    socketLocation.cleanup();
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    client?.close();
    if (!exited) child.kill("SIGTERM");
    socketLocation.cleanup();
  };

  try {
    await waitForSocket({
      socketPath,
      isExited: () => exited,
      readError: () => errorTail,
    });
    client = await CodexAppServerClient.connect({
      endpoint,
      logger: input.logger,
      onApprovalRequest: input.onApprovalRequest,
      clientVersion:
        input.clientVersion ?? getTellyMcpPackageVersion(__dirname),
    });
    let existingThreads: Awaited<ReturnType<CodexAppServerClient["listThreads"]>>;
    try {
      existingThreads = await client.listThreads(input.cwd);
    } catch (error) {
      throw new Error(
        `Installed Codex app-server does not support the required thread/list contract: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      endpoint,
      cwd: path.resolve(input.cwd),
      client,
      diagnostics,
      serverInfo: client.getServerInfo(),
      waitForThread: () =>
        client!.waitForThreadStarted({
          cwd: input.cwd,
          excludeThreadIds: existingThreads.map((thread) => thread.id),
        }),
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function buildAgentLaunchCommand(input: {
  executablePath: string;
  args: readonly string[];
  sentinel: string;
}): string {
  const invocation = [input.executablePath, ...input.args]
    .map(shellSingleQuote)
    .join(" ");
  return [
    invocation,
    "__tellymcp_agent_exit=$?",
    `printf '\\n${input.sentinel}%s\\n' "$__tellymcp_agent_exit"`,
    "unset __tellymcp_agent_exit",
  ].join("; ");
}

export class AgentRuntimeService {
  private readonly runningBySessionId = new Map<string, RunningAgent>();
  private readonly lastExitBySessionId = new Map<string, LastAgentExit>();
  private readonly inspectProviders: () => AgentProviderStatus[];
  private readonly sendLine: NonNullable<AgentRuntimeDependencies["sendLine"]>;
  private readonly subscribe: NonNullable<
    AgentRuntimeDependencies["subscribe"]
  >;
  private readonly ensureTarget: NonNullable<
    AgentRuntimeDependencies["ensureTarget"]
  >;
  private readonly startAppServer: NonNullable<
    AgentRuntimeDependencies["startAppServer"]
  >;
  private readonly requestApproval: NonNullable<
    AgentRuntimeDependencies["requestApproval"]
  >;
  private readonly notifyTelegram?: AgentRuntimeDependencies["notifyTelegram"];

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    dependencies: AgentRuntimeDependencies = {},
  ) {
    this.inspectProviders =
      dependencies.inspectProviders ?? (() => inspectAgentProviders());
    this.sendLine = dependencies.sendLine ?? sendTerminalLiteralLine;
    this.subscribe = dependencies.subscribe ?? subscribeForegroundTerminal;
    this.ensureTarget =
      dependencies.ensureTarget ?? ensureTerminalTargetForSession;
    this.startAppServer = dependencies.startAppServer ?? startCodexAppServer;
    this.requestApproval =
      dependencies.requestApproval ?? (async () => "decline");
    this.notifyTelegram = dependencies.notifyTelegram;
  }

  public async listAgents(
    input: ListAgentRuntimeInput,
  ): Promise<ListAgentRuntimeOutput> {
    const sessionId = input.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }

    const running = this.runningBySessionId.get(sessionId);
    const lastExit = this.lastExitBySessionId.get(sessionId);
    return {
      session_id: sessionId,
      agents: this.inspectProviders().map((provider) => ({
        ...provider,
        state: running?.agentId === provider.agentId ? "running" : "idle",
        ...(running?.agentId === provider.agentId
          ? { startedAt: running.startedAt }
          : lastExit?.agentId === provider.agentId
            ? { lastExitCode: lastExit.exitCode }
            : {}),
      })),
      ...(running ? { active_agent_id: running.agentId } : {}),
      ...(running?.appServer
        ? {
            turn_in_progress: running.turnInProgress,
            ...(running.activeTurnId
              ? { active_turn_id: running.activeTurnId }
              : {}),
          }
        : {}),
      ...(running?.appServer
        ? {
            codex_runtime: {
              thread_id: running.appServer.threadId,
              cwd: running.appServer.cwd,
              ...(running.appServer.diagnostics?.version
                ? { cli_version: running.appServer.diagnostics.version }
                : {}),
              ...(running.appServer.serverInfo?.userAgent
                ? {
                    server_user_agent:
                      running.appServer.serverInfo.userAgent,
                  }
                : {}),
              approval_policy: "on-request" as const,
              sandbox: "workspace-write" as const,
              network_access: false as const,
              ...(running.lastTurn ? { last_turn: running.lastTurn } : {}),
            },
          }
        : {}),
    };
  }

  public async startAgent(
    input: StartAgentRuntimeInput,
  ): Promise<StartAgentRuntimeOutput> {
    const sessionId = input.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }

    const definition = resolveAgentProvider(input.agent_id);
    if (!definition) {
      throw new Error(`Unsupported agent: ${input.agent_id}`);
    }

    const running = this.runningBySessionId.get(sessionId);
    if (running) {
      throw new Error(
        `Agent '${running.agentId}' is already running for session '${sessionId}'.`,
      );
    }

    const provider = this.inspectProviders().find(
      (candidate) => candidate.agentId === definition.agentId,
    );
    if (!provider?.available || !provider.executablePath) {
      throw new Error(
        `${definition.agentName} is not installed or '${definition.executable}' is not available in PATH.`,
      );
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' is unavailable on this client.`);
    }

    const terminalTarget = this.ensureTarget(this.config.terminal, {
      sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.terminalTarget ? { target: session.terminalTarget } : {}),
    });
    if (!terminalTarget) {
      throw new Error("terminal target is not configured for this console");
    }

    if (session.terminalTarget !== terminalTarget) {
      await this.sessionStore.setSession({
        ...session,
        terminalTarget,
        updatedAt: new Date().toISOString(),
      });
    }

    const startedAt = new Date().toISOString();
    const sentinel = `__TELLYMCP_AGENT_EXIT_${randomUUID().replaceAll("-", "")}__`;
    let backend: ManagedAppServerBootstrap | null = null;
    if (definition.transport === "app-server") {
      backend = await this.startAppServer({
        executablePath: provider.executablePath,
        sessionId,
        cwd: session.cwd || process.cwd(),
        logger: this.logger,
        onApprovalRequest: (request) =>
          this.requestApproval({ sessionId, request }),
      });
    }
    const launchArgs = backend
      ? [
          "--remote",
          backend.endpoint,
          "-C",
          session.cwd || process.cwd(),
          "--ask-for-approval",
          TELLYMCP_CODEX_POLICY.approvalPolicy,
          "--sandbox",
          TELLYMCP_CODEX_POLICY.sandbox,
        ]
      : provider.launchArgs;
    const command = buildAgentLaunchCommand({
      executablePath: provider.executablePath,
      args: launchArgs,
      sentinel,
    });
    let unsubscribe: () => void = () => undefined;
    const record: RunningAgent = {
      agentId: definition.agentId,
      startedAt,
      sentinel,
      outputTail: "",
      unsubscribe: () => unsubscribe(),
      stopBackend: () => backend?.stop(),
      turnInProgress: false,
    };

    const finish = (exitCode: number) => {
      if (this.runningBySessionId.get(sessionId) !== record) {
        return;
      }
      this.runningBySessionId.delete(sessionId);
      this.lastExitBySessionId.set(sessionId, {
        agentId: record.agentId,
        exitCode,
      });
      record.unsubscribe();
      record.cancelProgress?.();
      record.stopBackend();
      this.logger.info("Coding agent exited", {
        sessionId,
        agentId: record.agentId,
        exitCode,
      });
    };

    unsubscribe = this.subscribe(terminalTarget, {
      onData: (data) => {
        record.outputTail = `${record.outputTail}${data}`.slice(-512);
        const sentinelIndex = record.outputTail.lastIndexOf(record.sentinel);
        if (sentinelIndex < 0) {
          return;
        }
        const exitText = record.outputTail.slice(
          sentinelIndex + record.sentinel.length,
        );
        const match = exitText.match(/^(\d+)/u);
        if (match) {
          finish(Number.parseInt(match[1]!, 10));
        }
      },
      onExit: (info) => finish(info.exitCode),
    });
    this.runningBySessionId.set(sessionId, record);

    let appServer: ManagedAppServer | null = null;
    const threadStarted = backend?.waitForThread();
    try {
      await this.sendLine(this.config.terminal, terminalTarget, command);
      if (backend && threadStarted) {
        const threadId = await threadStarted;
        if (this.runningBySessionId.get(sessionId) !== record) {
          throw new Error(
            "Codex TUI exited before its app-server thread became available.",
          );
        }
        appServer = {
          endpoint: backend.endpoint,
          threadId,
          cwd: backend.cwd,
          client: backend.client,
          ...(backend.diagnostics ? { diagnostics: backend.diagnostics } : {}),
          ...(backend.serverInfo ? { serverInfo: backend.serverInfo } : {}),
          stop: backend.stop,
        };
        record.appServer = appServer;
      }
    } catch (error) {
      void threadStarted?.catch(() => undefined);
      this.runningBySessionId.delete(sessionId);
      record.unsubscribe();
      record.stopBackend();
      throw error;
    }

    this.logger.info("Coding agent started", {
      sessionId,
      terminalTarget,
      agentId: definition.agentId,
      providerId: definition.providerId,
      executablePath: provider.executablePath,
      transport: definition.transport,
      ...(appServer ? { appServerEndpoint: appServer.endpoint } : {}),
      startedAt,
    });

    return {
      ok: true,
      session_id: sessionId,
      terminal_target: terminalTarget,
      agent_id: definition.agentId,
      provider_id: definition.providerId,
      transport: definition.transport,
      started_at: startedAt,
      ...(appServer ? { thread_id: appServer.threadId } : {}),
    };
  }

  public attachAgent(input: AttachAgentRuntimeInput): AttachAgentRuntimeOutput {
    const sessionId = input.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }

    const definition = resolveAgentProvider(input.agent_id);
    if (!definition) {
      throw new Error(`Unsupported agent: ${input.agent_id}`);
    }

    const running = this.runningBySessionId.get(sessionId);
    if (!running) {
      throw new Error(
        `No Telly-managed ${definition.agentName} conversation is running. Start it locally with 'tellymcp run --agent ${definition.agentId}'.`,
      );
    }
    if (running.agentId !== definition.agentId) {
      throw new Error(
        `Cannot attach ${definition.agentName}: ${running.agentId} is the active Telly-managed agent for this session.`,
      );
    }
    if (definition.transport === "app-server" && !running.appServer) {
      throw new Error(
        `Cannot attach ${definition.agentName}: its Telly-managed app-server is unavailable.`,
      );
    }

    this.logger.info("Telegram attached to Telly-managed coding agent", {
      sessionId,
      agentId: definition.agentId,
      providerId: definition.providerId,
      ...(running.appServer ? { threadId: running.appServer.threadId } : {}),
    });

    return {
      ok: true,
      session_id: sessionId,
      agent_id: definition.agentId,
      provider_id: definition.providerId,
      transport: definition.transport,
      started_at: running.startedAt,
      ...(running.appServer ? { thread_id: running.appServer.threadId } : {}),
    };
  }

  public async submitMessage(
    input: SubmitAgentMessageInput,
  ): Promise<SubmitAgentMessageOutput> {
    const sessionId = input.session_id.trim();
    const message = input.message.trim();
    if (!sessionId || !message) {
      throw new Error("session_id and message are required");
    }

    const running = this.runningBySessionId.get(sessionId);
    if (input.agent_id && running?.agentId !== input.agent_id.trim()) {
      return { handled: false, session_id: sessionId };
    }
    if (!running?.appServer || running.agentId !== "codex") {
      return { handled: false, session_id: sessionId };
    }
    if (running.turnInProgress) {
      throw new Error(
        `A Codex turn is still running for this session${running.activeTurnId ? ` (${running.activeTurnId})` : ""}.`,
      );
    }
    running.turnInProgress = true;

    const notify = async (text: string) => {
      if (!this.notifyTelegram) {
        this.logger.warn("Codex final response has no Telegram notifier", {
          sessionId,
        });
        return;
      }
      try {
        await this.notifyTelegram({ sessionId, message: text });
      } catch (error) {
        this.logger.error("Failed to deliver Codex response to Telegram", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const progressRelay = createCodexProgressRelay({
      notify,
      isActive: () =>
        this.runningBySessionId.get(sessionId) === running &&
        running.turnInProgress,
    });
    running.cancelProgress?.();
    running.cancelProgress = progressRelay.stop;

    let submission: Awaited<ReturnType<CodexTurnClient["submitTurn"]>>;
    try {
      submission = await running.appServer.client.submitTurn({
        threadId: running.appServer.threadId,
        cwd: running.appServer.cwd,
        text: message,
        onProgress: (event) => {
          progressRelay.push(event.message);
        },
        onComplete: async (result) => {
          progressRelay.stop();
          if (this.runningBySessionId.get(sessionId) === running) {
            running.turnInProgress = false;
            running.activeTurnId = undefined;
            running.cancelProgress = undefined;
            running.lastTurn = {
              status: "completed",
              finished_at: new Date().toISOString(),
              ...(result.usage ? { usage: result.usage } : {}),
            };
          }
          await notify(result.message);
        },
        onInterrupted: async () => {
          progressRelay.stop();
          if (this.runningBySessionId.get(sessionId) === running) {
            running.turnInProgress = false;
            running.activeTurnId = undefined;
            running.cancelProgress = undefined;
            running.lastTurn = {
              status: "interrupted",
              finished_at: new Date().toISOString(),
            };
          }
          await notify("Codex turn stopped.");
        },
        onError: async (error) => {
          progressRelay.stop();
          if (this.runningBySessionId.get(sessionId) === running) {
            running.turnInProgress = false;
            running.activeTurnId = undefined;
            running.cancelProgress = undefined;
            running.lastTurn = {
              status: "failed",
              finished_at: new Date().toISOString(),
              error: error.message.slice(0, 500),
            };
          }
          await notify(`Codex turn failed: ${error.message}`);
        },
      });
    } catch (error) {
      progressRelay.stop();
      running.turnInProgress = false;
      running.cancelProgress = undefined;
      throw error;
    }
    if (running.turnInProgress) {
      running.activeTurnId = submission.turnId;
    }
    this.logger.info("Telegram message submitted to Codex app-server", {
      sessionId,
      threadId: submission.threadId,
      turnId: submission.turnId,
    });
    return {
      handled: true,
      session_id: sessionId,
      agent_id: "codex",
      thread_id: submission.threadId,
      turn_id: submission.turnId,
    };
  }

  public async stopTurn(
    input: StopAgentTurnInput,
  ): Promise<StopAgentTurnOutput> {
    const sessionId = input.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }

    const running = this.runningBySessionId.get(sessionId);
    if (
      !running?.appServer ||
      running.agentId !== "codex" ||
      !running.turnInProgress ||
      !running.activeTurnId
    ) {
      throw new Error(`No active Codex turn for session '${sessionId}'.`);
    }

    const threadId = running.appServer.threadId;
    const turnId = running.activeTurnId;
    await running.appServer.client.interruptTurn({ threadId, turnId });
    this.logger.info("Codex app-server turn interrupt requested", {
      sessionId,
      threadId,
      turnId,
    });
    return {
      ok: true,
      session_id: sessionId,
      agent_id: "codex",
      thread_id: threadId,
      turn_id: turnId,
      status: "interrupt_requested",
    };
  }

  public stopTracking(): void {
    for (const record of this.runningBySessionId.values()) {
      record.unsubscribe();
      record.cancelProgress?.();
      record.stopBackend();
    }
    this.runningBySessionId.clear();
  }
}
