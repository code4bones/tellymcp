import { spawnSync } from "node:child_process";

export type CodexRuntimeCapabilities = {
  appServer: boolean;
  unixSocketListen: boolean;
  remoteTui: boolean;
  schemaGeneration: boolean;
};

export type CodexRuntimeDiagnostics = {
  status: "ready" | "incompatible";
  executablePath: string;
  version?: string | undefined;
  capabilities: CodexRuntimeCapabilities;
  message: string;
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

type CommandRunner = (executablePath: string, args: string[]) => CommandResult;

function defaultCommandRunner(
  executablePath: string,
  args: string[],
): CommandResult {
  const result = spawnSync(executablePath, args, {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function combinedOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

export function inspectCodexRuntime(
  executablePath: string,
  runCommand: CommandRunner = defaultCommandRunner,
): CodexRuntimeDiagnostics {
  const versionResult = runCommand(executablePath, ["--version"]);
  const versionOutput = combinedOutput(versionResult);
  const versionMatch = versionOutput.match(/codex(?:-cli)?\s+([^\s]+)/iu);
  const version = versionMatch?.[1]?.trim();

  const appServerResult = runCommand(executablePath, ["app-server", "--help"]);
  const appServerHelp = combinedOutput(appServerResult);
  const rootHelpResult = runCommand(executablePath, ["--help"]);
  const rootHelp = combinedOutput(rootHelpResult);
  const capabilities: CodexRuntimeCapabilities = {
    appServer:
      appServerResult.status === 0 && appServerHelp.includes("--listen"),
    unixSocketListen:
      appServerResult.status === 0 &&
      appServerHelp.includes("--listen") &&
      appServerHelp.includes("unix://"),
    remoteTui: rootHelpResult.status === 0 && rootHelp.includes("--remote"),
    schemaGeneration:
      appServerResult.status === 0 &&
      appServerHelp.includes("generate-ts") &&
      appServerHelp.includes("generate-json-schema"),
  };
  const requiredCapabilities = {
    appServer: capabilities.appServer,
    unixSocketListen: capabilities.unixSocketListen,
    remoteTui: capabilities.remoteTui,
  };
  const missing = Object.entries(requiredCapabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  const commandError =
    versionResult.error ?? appServerResult.error ?? rootHelpResult.error;

  if (versionResult.status !== 0 || !version || missing.length > 0) {
    const detail = commandError?.message ||
      combinedOutput(appServerResult) ||
      versionOutput ||
      "required commands are unavailable";
    return {
      status: "incompatible",
      executablePath,
      ...(version ? { version } : {}),
      capabilities,
      message: `Codex CLI is incompatible with TellyMCP structured chat (${missing.join(", ") || "version probe failed"}): ${detail.slice(0, 300)}`,
    };
  }

  return {
    status: "ready",
    executablePath,
    version,
    capabilities,
    message: `Codex CLI ${version} supports app-server, Unix sockets, and remote TUI.`,
  };
}

export function assertCodexRuntimeCompatible(
  diagnostics: CodexRuntimeDiagnostics,
): void {
  if (diagnostics.status !== "ready") {
    throw new Error(diagnostics.message);
  }
}
