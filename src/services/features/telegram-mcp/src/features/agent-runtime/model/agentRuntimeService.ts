import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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
import {
  inspectAgentProviders,
  resolveAgentProvider,
  type AgentProviderStatus,
  type AgentTransportKind,
  type CodingAgentId,
} from "./agentProviderRegistry";

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
};

export type ManagedAppServer = {
  endpoint: string;
  stop: () => void;
};

type RunningAgent = {
  agentId: CodingAgentId;
  startedAt: string;
  sentinel: string;
  outputTail: string;
  unsubscribe: () => void;
  stopBackend: () => void;
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
  }) => Promise<ManagedAppServer>;
};

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

export async function startCodexAppServer(input: {
  executablePath: string;
  sessionId: string;
  cwd: string;
  logger: Logger;
}): Promise<ManagedAppServer> {
  const socketId = createHash("sha256")
    .update(`${process.pid}:${input.sessionId}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 20);
  const socketPath = path.join(os.tmpdir(), `tellymcp-codex-${socketId}.sock`);
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
    rmSync(socketPath, { force: true });
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!exited) child.kill("SIGTERM");
    rmSync(socketPath, { force: true });
  };

  try {
    await waitForSocket({
      socketPath,
      isExited: () => exited,
      readError: () => errorTail,
    });
  } catch (error) {
    stop();
    throw error;
  }

  return { endpoint, stop };
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
    let backend: ManagedAppServer | null = null;
    if (definition.transport === "app-server") {
      backend = await this.startAppServer({
        executablePath: provider.executablePath,
        sessionId,
        cwd: session.cwd || process.cwd(),
        logger: this.logger,
      });
    }
    const launchArgs = backend
      ? ["--remote", backend.endpoint, "-C", session.cwd || process.cwd()]
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

    try {
      await this.sendLine(this.config.terminal, terminalTarget, command);
    } catch (error) {
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
      ...(backend ? { appServerEndpoint: backend.endpoint } : {}),
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
    };
  }

  public stopTracking(): void {
    for (const record of this.runningBySessionId.values()) {
      record.unsubscribe();
      record.stopBackend();
    }
    this.runningBySessionId.clear();
  }
}
