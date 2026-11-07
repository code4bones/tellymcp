import fs from "node:fs";
import os from "node:os";
import { parse as parseDotenv } from "dotenv";
import { resolveRuntimeEnvPath } from "./cliRuntimeOptions";
import { readSessionMarkerState } from "./services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import {
  attachEndpoint,
  connectGatewayTerminal,
} from "./services/features/telegram-mcp/src/features/remote-terminal/model/remoteConnection";
import {
  attachTerminalConnection,
  requireInteractiveTerminal,
} from "./services/features/telegram-mcp/src/features/detached-terminal/model/terminalAttachment";

/** Does not launch a runtime, register a console, or write a workspace marker. */
export async function runRemoteAttach(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=", 1)[0]!;
    if (!["--code", "--gateway", "--env"].includes(name) || values.has(name))
      throw new Error(
        "Usage: tellymcp attach --code <code> [--gateway <url>] [--env <file>]",
      );
    const value = arg.includes("=")
      ? arg.slice(arg.indexOf("=") + 1)
      : args[++i];
    if (!value?.trim() || value.startsWith("-"))
      throw new Error("Missing remote attach option value");
    values.set(name, value.trim());
  }
  const code = values.get("--code");
  if (!code || !/^\d{8}$/u.test(code))
    throw new Error("Use the 8-digit attach code from Telegram Live");
  requireInteractiveTerminal();
  const explicitEnv = values.get("--env");
  const marker = readSessionMarkerState(process.cwd());
  const envPath = resolveRuntimeEnvPath(
    explicitEnv ? ["--env", explicitEnv] : [],
    {
      cwd: process.cwd(),
      homeDir: os.homedir(),
      markerEnvFile: marker?.envFile,
    },
  );
  if (explicitEnv && !fs.existsSync(envPath))
    throw new Error("Explicit env file not found");
  const config = fs.existsSync(envPath)
    ? parseDotenv(fs.readFileSync(envPath))
    : {};
  const gateway =
    values.get("--gateway") ||
    config.GATEWAY_WS_URL ||
    process.env.GATEWAY_WS_URL ||
    config.GATEWAY_PUBLIC_URL ||
    process.env.GATEWAY_PUBLIC_URL;
  if (!gateway)
    throw new Error(
      "Use --gateway <url> from the Telegram message, or configure GATEWAY_PUBLIC_URL",
    );
  const endpoint = attachEndpoint(
    gateway,
    !values.has("--gateway") &&
      Boolean(config.GATEWAY_WS_URL || process.env.GATEWAY_WS_URL),
  );
  const connection = await connectGatewayTerminal(endpoint, code, {
    httpProxy: config.TELLYMCP_HTTP_PROXY ?? process.env.TELLYMCP_HTTP_PROXY,
    noProxy: config.TELLYMCP_NO_PROXY ?? process.env.TELLYMCP_NO_PROXY,
  });
  const result = await attachTerminalConnection(
    connection.instance,
    connection,
  );
  if (result.detached)
    process.stdout.write(
      "Detached. To attach again, generate a fresh code from Telegram Live.\n",
    );
  process.exitCode = result.exitCode;
}
