import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

export type AgentProviderId = "openai" | "anthropic";
export type CodingAgentId = "codex" | "claude";
export type AgentTransportKind = "app-server" | "agent-sdk" | "pty";

export type AgentProviderDefinition = {
  providerId: AgentProviderId;
  providerName: string;
  agentId: CodingAgentId;
  agentName: string;
  executable: string;
  transport: AgentTransportKind;
  launchArgs: readonly string[];
  aliases: readonly string[];
};

export type AgentProviderStatus = AgentProviderDefinition & {
  available: boolean;
  executablePath?: string | undefined;
};

const BUILTIN_AGENT_PROVIDERS: readonly AgentProviderDefinition[] = [
  {
    providerId: "openai",
    providerName: "OpenAI",
    agentId: "codex",
    agentName: "Codex",
    executable: "codex",
    transport: "app-server",
    launchArgs: [],
    aliases: ["openai", "codex"],
  },
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    agentId: "claude",
    agentName: "Claude Code",
    executable: "claude",
    transport: "agent-sdk",
    launchArgs: [],
    aliases: ["anthropic", "claude", "claude-code"],
  },
] as const;

function executableExtensions(environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [""];
  }

  return (environment.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
}

function canExecute(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }

  try {
    accessSync(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmed = executable.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
    return canExecute(trimmed) ? path.resolve(trimmed) : null;
  }

  const pathEntries = (environment.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = executableExtensions(environment);

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(pathEntry, `${trimmed}${extension}`);
      if (canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function listAgentProviderDefinitions(): AgentProviderDefinition[] {
  return BUILTIN_AGENT_PROVIDERS.map((definition) => ({ ...definition }));
}

export function resolveAgentProvider(
  input: string,
): AgentProviderDefinition | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    BUILTIN_AGENT_PROVIDERS.find(
      (definition) =>
        definition.agentId === normalized ||
        definition.providerId === normalized ||
        definition.aliases.includes(normalized),
    ) ?? null
  );
}

export function inspectAgentProviders(
  environment: NodeJS.ProcessEnv = process.env,
): AgentProviderStatus[] {
  return BUILTIN_AGENT_PROVIDERS.map((definition) => {
    const executablePath = resolveExecutablePath(
      definition.executable,
      environment,
    );
    return {
      ...definition,
      available: Boolean(executablePath),
      ...(executablePath ? { executablePath } : {}),
    };
  });
}
