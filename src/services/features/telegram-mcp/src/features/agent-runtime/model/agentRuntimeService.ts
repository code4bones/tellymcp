import { randomUUID } from "node:crypto";

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
  started_at: string;
};

type RunningAgent = {
  agentId: CodingAgentId;
  startedAt: string;
  sentinel: string;
  outputTail: string;
  unsubscribe: () => void;
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
};

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
    const command = buildAgentLaunchCommand({
      executablePath: provider.executablePath,
      args: provider.launchArgs,
      sentinel,
    });
    let unsubscribe: () => void = () => undefined;
    const record: RunningAgent = {
      agentId: definition.agentId,
      startedAt,
      sentinel,
      outputTail: "",
      unsubscribe: () => unsubscribe(),
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
      throw error;
    }

    this.logger.info("Coding agent started", {
      sessionId,
      terminalTarget,
      agentId: definition.agentId,
      providerId: definition.providerId,
      executablePath: provider.executablePath,
      startedAt,
    });

    return {
      ok: true,
      session_id: sessionId,
      terminal_target: terminalTarget,
      agent_id: definition.agentId,
      provider_id: definition.providerId,
      started_at: startedAt,
    };
  }

  public stopTracking(): void {
    for (const record of this.runningBySessionId.values()) {
      record.unsubscribe();
    }
    this.runningBySessionId.clear();
  }
}
