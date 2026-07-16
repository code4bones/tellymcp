#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import net from "node:net";
import { parse as parseDotenv } from "dotenv";
import Redis from "ioredis";
import pc from "picocolors";
import WebSocket from "ws";
import {
  getCodexPluginStatus,
  installCodexPlugin,
} from "./codexPluginInstaller";
import { getTellyMcpPackageVersion } from "./services/features/telegram-mcp/src/shared/lib/version/versionHandshake";
import {
  readSessionMarkerState,
  resolveSessionDefaultsForCwd,
  writeSessionMarkerState,
} from "./services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { migrateEnvironmentContent } from "./envMigration";
import { startConfigureServer } from "./configureServer";

type InitMode = "client" | "gateway" | "both";
type CliCommand =
  | "help"
  | "init"
  | "configure"
  | "migrate-env"
  | "run"
  | "mcp"
  | "oauth"
  | "doctor"
  | "browser"
  | "extension"
  | "codex-plugin"
  | "system-prune";

const distDir = __dirname;
const packageRoot = path.resolve(distDir, "..");
const cliPackageVersion = getTellyMcpPackageVersion(__dirname);

type PlaywrightBrowserStatus =
  | { enabled: false }
  | { enabled: true; installed: true; executablePath: string }
  | { enabled: true; installed: false; message: string };

type NativePtyRuntimeStatus =
  | { available: true }
  | { available: false; message: string };

function nativePtyRecoveryLines(): string[] {
  return [
    ...(process.platform === "linux"
      ? [
          "Install native build prerequisites (Debian/Ubuntu): sudo apt install -y python3 make g++",
        ]
      : []),
    "Ensure npm lifecycle scripts are enabled: npm config set ignore-scripts false",
    "Remove the broken global package: npm uninstall -g @deadragdoll/tellymcp",
    "Reinstall and compile native dependencies: npm install -g @deadragdoll/tellymcp@latest --foreground-scripts",
  ];
}

async function checkNativePtyRuntime(): Promise<NativePtyRuntimeStatus> {
  try {
    const nodePty = await import("node-pty");
    if (typeof nodePty.spawn !== "function") {
      return {
        available: false,
        message: "node-pty loaded without a spawn function.",
      };
    }
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      message: message.split("\n", 1)[0] || "node-pty failed to load.",
    };
  }
}

function isForegroundPtyClientMode(parsed: Record<string, string>): boolean {
  return (parsed.DISTRIBUTED_MODE || "client").trim() === "client";
}

function printBanner(title: string, subtitle?: string): void {
  process.stdout.write(
    `${pc.bold(pc.cyan("TellyMCP"))} ${pc.bold(pc.white(`v${cliPackageVersion}`))} ${pc.dim(title)}\n`,
  );
  if (subtitle) {
    process.stdout.write(`${pc.dim(subtitle)}\n`);
  }
  process.stdout.write("\n");
}

function printSection(title: string, lines: string[]): void {
  process.stdout.write(`${pc.bold(title)}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("\n");
}

async function getPlaywrightBrowserStatus(
  browserEnabled: boolean,
): Promise<PlaywrightBrowserStatus> {
  if (!browserEnabled) {
    return { enabled: false };
  }

  try {
    const playwright = await import("playwright");
    const executablePath = playwright.chromium.executablePath();

    if (executablePath && existsSync(executablePath)) {
      return {
        enabled: true,
        installed: true,
        executablePath,
      };
    }

    return {
      enabled: true,
      installed: false,
      message: "Chromium browser binaries are missing.",
    };
  } catch (error) {
    return {
      enabled: true,
      installed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function printHelp(): void {
  printBanner("CLI", "Telegram control plane for MCP-connected coding agents");
  printSection("Usage", [
    "  tellymcp init <client|gateway|both> [directory]",
    "  tellymcp configure [--no-open]",
    "  tellymcp migrate-env <input.env> > .migrated-env",
    "  tellymcp run [--env <file>]",
    "  tellymcp run --env=<file>",
    "  tellymcp run --env .env-client -s backendDev",
    "  tellymcp run              # if .mcpsession.json already stores env_file + local_session_id",
    "  tellymcp doctor [--env <file>]",
    "  tellymcp system-prune [--env <file>] --yes",
    "  tellymcp browser install",
    "  tellymcp extension firefox",
    "  tellymcp extension chrome",
    "  tellymcp codex-plugin install",
    "  tellymcp codex-plugin status",
    "  tellymcp mcp [--url <url>] [--bearer <token>] [--format claude|legacy]",
    "  tellymcp oauth key",
    "  tellymcp help",
  ]);
  printSection("Examples", [
    "  tellymcp init client",
    "  tellymcp init gateway ./gateway-node",
    "  tellymcp configure",
    "  tellymcp migrate-env ./old.env > ./new.env",
    "  tellymcp run",
    "  tellymcp run --env .env.client",
    "  tellymcp run --env .env-client -s backendDev",
    "  tellymcp run              # reuses .mcpsession.json in the current workspace",
    "  tellymcp doctor --env .env.client",
    "  tellymcp system-prune --env .env.gateway --yes",
    "  tellymcp browser install",
    "  tellymcp extension firefox",
    "  tellymcp extension chrome ./tellymcp-chrome-attach",
    "  tellymcp codex-plugin install",
    "  tellymcp codex-plugin status",
    "  tellymcp mcp --help",
    "  tellymcp oauth key",
  ]);
  printSection("terminal", [
    "  built-in PTY runtime (validated by tellymcp doctor and tellymcp run)",
    "  Live view, session nudges and browser flows use the built-in terminal runtime.",
  ]);
}

type LoadedCliEnv = {
  envPath: string;
  parsed: Record<string, string>;
};

function resolveMarkerEnvPath(rawPath: string, cwd: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function formatMarkerEnvPath(envPath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedEnvPath = path.resolve(envPath);
  const relativePath = path.relative(resolvedCwd, resolvedEnvPath);
  return relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
    ? relativePath
    : resolvedEnvPath;
}

function getSessionMarkerForCwd(cwd: string) {
  return readSessionMarkerState(cwd);
}

function resolveCliSessionDefaults(input: {
  envPath: string;
  sessionId?: string | undefined;
  sessionLabel?: string | undefined;
}) {
  return resolveSessionDefaultsForCwd({
    cwd: process.cwd(),
    ...(input.sessionId?.trim() ? { session_id: input.sessionId.trim() } : {}),
    ...(input.sessionLabel?.trim()
      ? { session_label: input.sessionLabel.trim() }
      : {}),
  });
}

function persistCliSessionMarker(input: {
  cwd: string;
  envPath: string;
  sessionId?: string | undefined;
  sessionLabel?: string | undefined;
}): void {
  const current = getSessionMarkerForCwd(input.cwd);
  const resolved =
    resolveCliSessionDefaults({
      envPath: input.envPath,
      sessionId: input.sessionId,
      sessionLabel: input.sessionLabel,
    }) ?? null;
  const localSessionId =
    input.sessionId?.trim() || current?.localSessionId || resolved?.sessionId;
  if (!localSessionId) {
    return;
  }

  writeSessionMarkerState({
    cwd: input.cwd,
    localSessionId,
    ...(input.sessionLabel?.trim()
      ? { sessionLabel: input.sessionLabel.trim() }
      : current?.sessionLabel
        ? { sessionLabel: current.sessionLabel }
        : resolved?.sessionLabel
          ? { sessionLabel: resolved.sessionLabel }
          : {}),
    envFile: formatMarkerEnvPath(input.envPath, input.cwd),
  });
}

function loadCliEnv(args: string[]): LoadedCliEnv {
  const envPath = resolveRunEnvPath(args);
  const marker = getSessionMarkerForCwd(process.cwd());
  const explicitSessionOverride =
    readFlagValue(args, "-s") ?? readFlagValue(args, "--session");
  const sessionOverride =
    explicitSessionOverride ?? marker?.localSessionId ?? null;
  const sessionLabelOverride = explicitSessionOverride
    ? explicitSessionOverride
    : (marker?.sessionLabel ?? sessionOverride ?? null);
  if (!existsSync(envPath)) {
    fail(`Missing env file: ${envPath}`);
  }

  const envContent = readFileSync(envPath, "utf8");
  const fileEnv = parseDotenv(envContent);
  const runtimeEnvOverrides = Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => typeof value === "string",
    ),
  ) as Record<string, string>;

  return {
    envPath,
    parsed: {
      ...fileEnv,
      ...runtimeEnvOverrides,
      ...(sessionOverride
        ? {
            TELLYMCP_SESSION_ID: sessionOverride,
            TELLYMCP_SESSION_LABEL: sessionLabelOverride || sessionOverride,
          }
        : {}),
    },
  };
}

function printMcpHelp(): void {
  printBanner(
    "MCP helper",
    "Prints JSON snippets for Claude, Codex, and other MCP clients",
  );
  printSection("Usage", [
    "  tellymcp mcp --help",
    "  tellymcp mcp --url <url>",
    "  tellymcp mcp --url <url> --bearer <token>",
    "  tellymcp mcp --url <url> --format legacy",
  ]);
  printSection("What this command does", [
    "  It prints a config snippet.",
    "  It does not register MCP in your agent automatically.",
    "  Copy the printed JSON into your agent's MCP config.",
  ]);
  printSection("What you need", [
    "  1. Terminal live view and nudges use the built-in PTY runtime.",
    "  2. Your MCP endpoint depends on mode:",
    "     - client/local: http://127.0.0.1:8787/mcp",
    "     - gateway/both behind nginx: https://your-host.example/api/mcp",
    "  3. For local and remote agents, use the MCP HTTP endpoint exposed by tellymcp run.",
  ]);
  printSection("Claude / modern streamable-http example", [
    "{",
    '  "mcpServers": {',
    '    "telegramHuman": {',
    '      "transport": {',
    '        "type": "streamable-http",',
    '        "url": "https://builder.undoo.ru/api/mcp"',
    "      }",
    "    }",
    "  }",
    "}",
  ]);
  printSection("Legacy example", [
    "{",
    '  "mcpServers": {',
    '    "telegramHuman": {',
    '      "type": "streamable-http",',
    '      "url": "https://builder.undoo.ru/api/mcp"',
    "    }",
    "  }",
    "}",
  ]);
  printSection("With bearer token", [
    "{",
    '  "mcpServers": {',
    '    "telegramHuman": {',
    '      "transport": {',
    '        "type": "streamable-http",',
    '        "url": "https://builder.undoo.ru/api/mcp",',
    '        "headers": {',
    '          "Authorization": "Bearer YOUR_TOKEN"',
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ]);
  printSection("Examples", [
    "  tellymcp mcp --url https://builder.undoo.ru/api/mcp",
    "  tellymcp mcp --url https://builder.undoo.ru/api/mcp --bearer YOUR_TOKEN",
    "  tellymcp mcp --url https://builder.undoo.ru/api/mcp --format legacy",
  ]);
}

function runOAuthCommand(args: string[]): void {
  const [subcommand] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printBanner("OAuth helper", "Generate connector signing material");
    printSection("Usage", ["  tellymcp oauth key"]);
    printSection("Output", [
      "  Prints a dotenv-ready TELLYMCP_OAUTH_PRIVATE_KEY_PEM value.",
      "  Store it only on the gateway and never expose it to chat clients.",
    ]);
    return;
  }
  if (subcommand !== "key") {
    fail("Supported OAuth subcommands: key");
  }

  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString()
    .replace(/\n/gu, "\\n");
  process.stdout.write(`TELLYMCP_OAUTH_PRIVATE_KEY_PEM="${privateKeyPem}"\n`);
}

function printBrowserHelp(): void {
  printBanner(
    "browser helper",
    "Manage Playwright browser binaries used by browser_* tools",
  );
  printSection("Usage", ["  tellymcp browser install"]);
  printSection("What this command does", [
    "  Installs the bundled Playwright Chromium browser.",
    "  Uses the Playwright dependency shipped with TellyMCP.",
    "  Avoids generic npx warnings about missing local project dependencies.",
  ]);
}

function printExtensionHelp(): void {
  printBanner(
    "extension helper",
    "Export bundled browser attach extensions into a local directory",
  );
  printSection("Usage", [
    "  tellymcp extension firefox [output-directory]",
    "  tellymcp extension ff [output-directory]",
    "  tellymcp extension chrome [output-directory]",
    "  tellymcp extension <firefox|ff|chrome> --out-dir <directory>",
    "  tellymcp extension <firefox|ff|chrome> --force",
  ]);
  printSection("What this command does", [
    "  Copies the packaged unpacked extension bundle out of the installed tellymcp package.",
    "  By default exports into the current directory.",
    "  Creates a browser-specific folder you can load into Firefox or Chrome.",
  ]);
  printSection("Examples", [
    "  tellymcp extension firefox",
    "  tellymcp extension chrome",
    "  tellymcp extension firefox ./tellymcp-firefox-attach",
    "  tellymcp extension chrome --out-dir ./browser-addon",
  ]);
}

function printCodexPluginHelp(): void {
  printBanner(
    "codex plugin",
    "Install or inspect the bundled Codex workflow plugin",
  );
  printSection("Usage", [
    "  tellymcp codex-plugin install",
    "  tellymcp codex-plugin status",
  ]);
  printSection("What this command does", [
    "  Copies the bundled telly-workflows plugin from the package into a managed local Codex plugin directory.",
    "  Ensures the local personal marketplace entry points at that managed plugin source.",
    "  If the Codex CLI is installed, checks whether the installed plugin version matches the bundled package version and installs or updates it when needed.",
  ]);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function ensureMode(value: string | undefined): InitMode {
  if (value === "client" || value === "gateway" || value === "both") {
    return value;
  }

  fail("Mode must be one of: client, gateway, both.");
}

function loadTemplate(mode: InitMode): string {
  const templateName =
    mode === "client"
      ? "env.client.template"
      : mode === "gateway"
        ? "env.gateway.template"
        : "env.both.template";
  const templatePath = path.join(packageRoot, templateName);
  const nestedTemplatePath = path.join(
    packageRoot,
    "config",
    "templates",
    templateName,
  );
  const resolvedTemplatePath = existsSync(templatePath)
    ? templatePath
    : nestedTemplatePath;
  if (!existsSync(resolvedTemplatePath)) {
    fail(`Missing packaged template: ${templateName}`);
  }

  return readFileSync(resolvedTemplatePath, "utf8");
}

async function runConfigure(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printBanner(
      "configure",
      "Local web configurator for a TellyMCP dotenv file",
    );
    printSection("Usage", [
      "  tellymcp configure [--no-open]",
      "  tellymcp configure [--port 8790] [--no-open]",
    ]);
    printSection("Safety", [
      "  The configurator binds only to 127.0.0.1 on a random free port.",
      "  Its URL contains a one-time access token.",
      "  The browser downloads .env-client or .env-gateway after validation.",
    ]);
    return;
  }

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--no-open" || value?.startsWith("--port=")) {
      continue;
    }
    if (value === "--port") {
      index += 1;
      continue;
    }
    fail(
      "configure does not accept a role or output path; choose Client or Gateway in the browser wizard.",
    );
  }

  const portArg = readFlagValue(args, "--port");
  const port = portArg === null ? 0 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail("--port must be an integer between 0 and 65535.");
  }
  printBanner(
    "configure",
    "Choose Client or Gateway in the local browser wizard",
  );
  await startConfigureServer({
    templates: {
      client: loadTemplate("client"),
      gateway: loadTemplate("gateway"),
    },
    port,
    open: !args.includes("--no-open"),
    onListening(url) {
      printSection("Configurator", [
        `  ${pc.green("OPEN")} ${url}`,
        "  Keep this terminal open until the file is saved.",
        "  Press Ctrl+C to cancel.",
      ]);
    },
    onDownloaded(filename) {
      printSection("Download", [
        `  ${pc.green("OK")} ${filename} sent to the browser`,
        `  next: chmod 600 ${filename}`,
      ]);
    },
  });
}

function initWorkspace(mode: InitMode, directoryArg?: string): void {
  const targetDir = path.resolve(directoryArg ?? process.cwd());
  mkdirSync(targetDir, { recursive: true });

  const envPath = path.join(targetDir, ".env");
  if (existsSync(envPath)) {
    fail(`Refusing to overwrite existing ${envPath}`);
  }

  const template = loadTemplate(mode);
  writeFileSync(envPath, template, "utf8");

  for (const subdir of ["logs", "data", "artifacts"]) {
    mkdirSync(path.join(targetDir, subdir), { recursive: true });
  }

  printBanner("workspace initialized");
  printSection("Created", [
    `  ${envPath}`,
    `  ${path.join(targetDir, "logs")}`,
    `  ${path.join(targetDir, "data")}`,
    `  ${path.join(targetDir, "artifacts")}`,
  ]);
  printSection("Next", [
    "  1. Edit .env",
    `  2. cd ${targetDir}`,
    "  3. tellymcp run",
  ]);
}

function runMigrateEnv(args: string[]): void {
  const [inputArg, extraArg] = args;
  if (!inputArg || extraArg || inputArg === "--help" || inputArg === "-h") {
    printBanner("migrate-env", "Normalize a legacy TellyMCP environment file");
    printSection("Usage", [
      "  tellymcp migrate-env <input.env> > .migrated-env",
      "  The role is read from DISTRIBUTED_MODE or inferred from gateway-only keys.",
      "  Normalized dotenv is written to stdout; migration notes go to stderr.",
    ]);
    if (!inputArg || inputArg === "--help" || inputArg === "-h") {
      return;
    }
    fail("migrate-env expects exactly one input env file.");
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  if (!existsSync(inputPath)) {
    fail(`Missing input env file: ${inputPath}`);
  }

  const result = migrateEnvironmentContent(readFileSync(inputPath, "utf8"));
  process.stdout.write(result.content);

  const notes = [
    `migrate-env: role=${result.role}`,
    `migrate-env: kept ${result.keptKeys.length} keys from ${inputPath}`,
  ];
  if (result.renamedKeys.length > 0) {
    notes.push(
      `migrate-env: renamed ${result.renamedKeys
        .map(({ from, to }) => `${from}->${to}`)
        .join(", ")}`,
    );
  }
  if (result.droppedKeys.length > 0) {
    notes.push(`migrate-env: dropped ${result.droppedKeys.join(", ")}`);
  }
  process.stderr.write(`${notes.join("\n")}\n`);
}

function resolveRunEnvPath(args: string[]): string {
  const [firstArg, secondArg] = args;
  const marker = getSessionMarkerForCwd(process.cwd());

  if (firstArg?.startsWith("--env=")) {
    const value = firstArg.slice("--env=".length).trim();
    if (!value) {
      fail("Expected a file path after --env=");
    }
    return path.resolve(process.cwd(), value);
  }

  if (firstArg === "--env") {
    if (!secondArg?.trim()) {
      fail("Expected a file path after --env");
    }
    return path.resolve(process.cwd(), secondArg);
  }

  if (marker?.envFile?.trim()) {
    return resolveMarkerEnvPath(marker.envFile.trim(), process.cwd());
  }

  return path.resolve(process.cwd(), ".env");
}

function joinUrlPath(left: string, right: string): string {
  const normalizedLeft = left.endsWith("/") ? left.slice(0, -1) : left;
  const normalizedRight = right.startsWith("/") ? right : `/${right}`;
  return `${normalizedLeft}${normalizedRight}`.replace(/\/{2,}/gu, "/");
}

function deriveGatewayHealthUrlFromPublicUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/u, "");

    if (pathname.endsWith("/gateway")) {
      url.pathname = `${pathname.slice(0, -"/gateway".length) || ""}/healthz`;
      return url.toString();
    }

    if (pathname.endsWith("/webapp")) {
      url.pathname = `${pathname.slice(0, -"/webapp".length) || ""}/healthz`;
      return url.toString();
    }

    if (pathname.endsWith("/mcp")) {
      url.pathname = `${pathname.slice(0, -"/mcp".length) || ""}/healthz`;
      return url.toString();
    }

    url.pathname = joinUrlPath(pathname || "/", "/healthz");
    return url.toString();
  } catch {
    return null;
  }
}

function readFlagValue(args: string[], flagName: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flagName) {
      const next = args[index + 1]?.trim();
      if (!next) {
        fail(`Expected a value after ${flagName}`);
      }
      return next;
    }

    if (value?.startsWith(`${flagName}=`)) {
      const inlineValue = value.slice(flagName.length + 1).trim();
      if (!inlineValue) {
        fail(`Expected a value after ${flagName}=`);
      }
      return inlineValue;
    }
  }

  return null;
}

function printMcpConfig(args: string[]): void {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printMcpHelp();
    return;
  }

  const url = readFlagValue(args, "--url");
  if (!url) {
    fail(
      "Missing --url <mcp-endpoint>. Run 'tellymcp mcp --help' for examples.",
    );
  }

  const bearer = readFlagValue(args, "--bearer");
  const format = (readFlagValue(args, "--format") ?? "claude").toLowerCase();

  if (format !== "claude" && format !== "legacy") {
    fail("Supported --format values: claude, legacy.");
  }

  const config =
    format === "legacy"
      ? {
          mcpServers: {
            telegramHuman: {
              type: "streamable-http",
              url,
              ...(bearer
                ? {
                    headers: {
                      Authorization: `Bearer ${bearer}`,
                    },
                  }
                : {}),
            },
          },
        }
      : {
          mcpServers: {
            telegramHuman: {
              transport: {
                type: "streamable-http",
                url,
                ...(bearer
                  ? {
                      headers: {
                        Authorization: `Bearer ${bearer}`,
                      },
                    }
                  : {}),
              },
            },
          },
        };

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function checkTcpPort(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ ok: boolean; message: string }> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });

    const finish = (ok: boolean, message: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, message });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `${host}:${port} is reachable`));
    socket.once("timeout", () => finish(false, `${host}:${port} timed out`));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(false, `${host}:${port} failed: ${error.code ?? error.message}`);
    });
  });
}

async function checkHttpHealth(
  url: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      ok: response.ok,
      message: `${url} returned ${response.status}`,
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      message: `${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkWebSocketUrl(
  url: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; message: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let opened = false;

    const finish = (ok: boolean, message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok, message });
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    };

    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      finish(false, `${url} timed out`);
    }, timeoutMs);

    socket.once("open", () => {
      opened = true;
      finish(true, `${url} accepted a WebSocket connection`);
    });

    socket.once(
      "unexpected-response",
      (_req: unknown, response: { statusCode?: number }) => {
        finish(
          false,
          `${url} returned HTTP ${response.statusCode ?? "unknown"} during WebSocket upgrade`,
        );
      },
    );

    socket.on("error", (error: Error) => {
      finish(false, `${url} failed: ${error.message}`);
    });

    socket.once("close", (code: number) => {
      if (!opened) {
        finish(false, `${url} closed before open (code ${code})`);
      }
      socket.removeAllListeners();
    });
  });
}

async function runDoctor(args: string[]): Promise<void> {
  const { envPath, parsed } = loadCliEnv(args);
  const nativePtyStatus = await checkNativePtyRuntime();

  printBanner("doctor", "Local installation diagnostics");

  printSection("terminal", [
    nativePtyStatus.available
      ? `${pc.green("  OK")} built-in PTY runtime: native module loaded`
      : `${pc.red("  ERROR")} built-in PTY runtime: ${nativePtyStatus.message}`,
    `  platform: ${process.platform}-${process.arch}, Node ${process.versions.node}`,
    `  shell: ${parsed.TERMINAL_SHELL?.trim() || process.env.SHELL || "bash"}`,
    `  size:  ${parsed.TERMINAL_COLS?.trim() || "120"}x${parsed.TERMINAL_ROWS?.trim() || "40"}`,
    ...(!nativePtyStatus.available
      ? nativePtyRecoveryLines().map(
          (line) => `${pc.yellow("  ACTION")} ${line}`,
        )
      : []),
  ]);

  const mode = (parsed.DISTRIBUTED_MODE || "client").trim();
  const httpHost = (parsed.MCP_HTTP_HOST || "0.0.0.0").trim();
  const httpPort =
    mode === "gateway" || mode === "both"
      ? (parsed.PORT || parsed.MCP_HTTP_PORT || "8080").trim()
      : (parsed.MCP_HTTP_PORT || "8787").trim();
  const rootPrefix =
    mode === "gateway" || mode === "both"
      ? (parsed.ROOT_PREFIX || "/api").trim()
      : "";
  const mcpPath = (parsed.MCP_HTTP_PATH || "/mcp").trim();
  const webappPath = (parsed.WEBAPP_BASE_PATH || "/webapp").trim();
  const mcpUrlPath =
    mode === "gateway" || mode === "both"
      ? joinUrlPath(rootPrefix, mcpPath)
      : mcpPath;
  const webappUrlPath =
    mode === "gateway" || mode === "both"
      ? joinUrlPath(rootPrefix, webappPath)
      : webappPath;
  const healthUrlPath =
    mode === "gateway" || mode === "both"
      ? joinUrlPath(rootPrefix, "/healthz")
      : "/healthz";
  const publicGatewayUrl = parsed.GATEWAY_PUBLIC_URL?.trim();
  const gatewayWsUrl = parsed.GATEWAY_WS_URL?.trim();
  const publicWebappUrl = parsed.WEBAPP_PUBLIC_URL?.trim();
  const mcpBearerToken = parsed.MCP_HTTP_BEARER_TOKEN?.trim();
  const browserEnabled =
    (parsed.BROWSER_ENABLED || "true").trim().toLowerCase() !== "false";
  const externalHealthUrl =
    deriveGatewayHealthUrlFromPublicUrl(publicGatewayUrl || "") ??
    deriveGatewayHealthUrlFromPublicUrl(publicWebappUrl || "");

  printSection("env", [
    `${pc.green("  OK")} ${envPath}`,
    `  mode: ${mode}`,
    "  terminal transport: built-in PTY",
    ...(parsed.TELLYMCP_SESSION_ID
      ? [`  session override: ${parsed.TELLYMCP_SESSION_ID}`]
      : []),
    `  bind: http://${httpHost}:${httpPort}`,
    `  mcp:  http://${httpHost}:${httpPort}${mcpUrlPath}`,
    `  web:  http://${httpHost}:${httpPort}${webappUrlPath}`,
    `  mcp auth: ${mcpBearerToken ? "bearer token required" : "disabled"}`,
    ...(publicGatewayUrl ? [`  public gateway: ${publicGatewayUrl}`] : []),
    ...(gatewayWsUrl ? [`  public ws:      ${gatewayWsUrl}`] : []),
    ...(publicWebappUrl ? [`  public web:     ${publicWebappUrl}`] : []),
    ...(externalHealthUrl ? [`  public health:  ${externalHealthUrl}`] : []),
  ]);

  const checks: string[] = [];
  const capabilities: string[] = [];

  const playwrightStatus = await getPlaywrightBrowserStatus(browserEnabled);
  if (!playwrightStatus.enabled) {
    checks.push(`${pc.dim("  SKIP")} playwright: browser tools are disabled`);
    capabilities.push(`${pc.dim("  SKIP")} browser tools: disabled`);
  } else if (playwrightStatus.installed) {
    checks.push(
      `${pc.green("  OK")} playwright chromium: ${playwrightStatus.executablePath}`,
    );
    capabilities.push(`${pc.green("  OK")} browser tools: available`);
  } else {
    checks.push(
      `${pc.red("  ERROR")} playwright chromium: ${playwrightStatus.message}`,
    );
    capabilities.push(
      `${pc.red("  ERROR")} browser tools: browsers are not installed`,
    );
  }

  if (mode === "client") {
    checks.push(
      `${pc.green("  OK")} local state: process-local (Redis is not required)`,
    );
  } else {
    const redisHost = (parsed.REDIS_HOST || "127.0.0.1").trim();
    const redisPort = Number(parsed.REDIS_PORT || 6379);
    const redisCheck = await checkTcpPort(redisHost, redisPort);
    checks.push(
      `${redisCheck.ok ? pc.green("  OK") : pc.red("  ERROR")} redis: ${redisCheck.message}`,
    );
  }

  if (mode === "client") {
    const gatewayPublicUrl = parsed.GATEWAY_PUBLIC_URL?.trim();
    if (gatewayPublicUrl) {
      const gatewayHealth = await checkHttpHealth(
        `${gatewayPublicUrl.replace(/\/+$/u, "")}/healthz`,
      );
      checks.push(
        `${gatewayHealth.ok ? pc.green("  OK") : pc.red("  ERROR")} gateway: ${gatewayHealth.message}`,
      );
      capabilities.push(
        `${gatewayHealth.ok ? pc.green("  OK") : pc.red("  ERROR")} remote collaboration API: ${gatewayHealth.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(
        `${pc.yellow("  WARN")} gateway: GATEWAY_PUBLIC_URL is empty`,
      );
      capabilities.push(
        `${pc.yellow("  WARN")} remote collaboration API: not configured`,
      );
    }

    if (gatewayWsUrl) {
      const gatewayWs = await checkWebSocketUrl(gatewayWsUrl);
      checks.push(
        `${gatewayWs.ok ? pc.green("  OK") : pc.red("  ERROR")} gateway ws: ${gatewayWs.message}`,
      );
      capabilities.push(
        `${gatewayWs.ok ? pc.green("  OK") : pc.red("  ERROR")} remote live relay: ${gatewayWs.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(`${pc.yellow("  WARN")} gateway ws: GATEWAY_WS_URL is empty`);
      capabilities.push(
        `${pc.yellow("  WARN")} remote live relay: not configured`,
      );
    }

    if (publicWebappUrl) {
      const publicWebapp = await checkHttpHealth(publicWebappUrl);
      checks.push(
        `${publicWebapp.ok ? pc.green("  OK") : pc.red("  ERROR")} public webapp: ${publicWebapp.message}`,
      );
      capabilities.push(
        `${publicWebapp.ok ? pc.green("  OK") : pc.red("  ERROR")} remote webapp launcher: ${publicWebapp.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(
        `${pc.yellow("  WARN")} public webapp: WEBAPP_PUBLIC_URL is empty`,
      );
      capabilities.push(
        `${pc.yellow("  WARN")} remote webapp launcher: not configured`,
      );
    }
  }

  if (mode === "gateway" || mode === "both") {
    const localHealth = await checkHttpHealth(
      `http://${httpHost}:${httpPort}${healthUrlPath}`,
    );
    checks.push(
      `${localHealth.ok ? pc.green("  OK") : pc.yellow("  WARN")} local healthz: ${localHealth.message}`,
    );
    capabilities.push(
      `${localHealth.ok ? pc.green("  OK") : pc.red("  ERROR")} local gateway api: ${localHealth.ok ? "available" : "unavailable"}`,
    );

    if (externalHealthUrl) {
      const externalHealth = await checkHttpHealth(externalHealthUrl);
      checks.push(
        `${externalHealth.ok ? pc.green("  OK") : pc.red("  ERROR")} public healthz: ${externalHealth.message}`,
      );
      capabilities.push(
        `${externalHealth.ok ? pc.green("  OK") : pc.red("  ERROR")} public gateway api: ${externalHealth.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(
        `${pc.yellow("  WARN")} public healthz: no public gateway/webapp URL is configured`,
      );
      capabilities.push(
        `${pc.yellow("  WARN")} public gateway api: not configured`,
      );
    }

    if (gatewayWsUrl) {
      const gatewayWs = await checkWebSocketUrl(gatewayWsUrl);
      checks.push(
        `${gatewayWs.ok ? pc.green("  OK") : pc.red("  ERROR")} public ws: ${gatewayWs.message}`,
      );
      capabilities.push(
        `${gatewayWs.ok ? pc.green("  OK") : pc.red("  ERROR")} public live relay: ${gatewayWs.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(`${pc.yellow("  WARN")} public ws: GATEWAY_WS_URL is empty`);
      capabilities.push(
        `${pc.yellow("  WARN")} public live relay: not configured`,
      );
    }

    if (publicWebappUrl) {
      const publicWebapp = await checkHttpHealth(publicWebappUrl);
      checks.push(
        `${publicWebapp.ok ? pc.green("  OK") : pc.red("  ERROR")} public webapp: ${publicWebapp.message}`,
      );
      capabilities.push(
        `${publicWebapp.ok ? pc.green("  OK") : pc.red("  ERROR")} public webapp launcher: ${publicWebapp.ok ? "available" : "unavailable"}`,
      );
    } else {
      checks.push(
        `${pc.yellow("  WARN")} public webapp: WEBAPP_PUBLIC_URL is empty`,
      );
      capabilities.push(
        `${pc.yellow("  WARN")} public webapp launcher: not configured`,
      );
    }

    const dbHost = parsed.DB_HOST?.trim();
    if (dbHost) {
      const dbPort = Number(parsed.DB_PORT || 5432);
      const dbCheck = await checkTcpPort(dbHost, dbPort);
      checks.push(
        `${dbCheck.ok ? pc.green("  OK") : pc.red("  ERROR")} postgres: ${dbCheck.message}`,
      );
    } else {
      checks.push(`${pc.yellow("  WARN")} postgres: DB_HOST is empty`);
    }

    const rmqHost = parsed.RMQ_HOST?.trim();
    if (rmqHost) {
      const rmqPort = Number(parsed.RMQ_PORT || 5672);
      const rmqCheck = await checkTcpPort(rmqHost, rmqPort);
      checks.push(
        `${rmqCheck.ok ? pc.green("  OK") : pc.red("  ERROR")} rmq: ${rmqCheck.message}`,
      );
    } else {
      checks.push(`${pc.dim("  SKIP")} rmq: RMQ_HOST is not configured`);
    }
  }

  printSection("capabilities", capabilities);
  printSection("checks", checks);

  const notes: string[] = [];
  if (!parsed.TELEGRAM_BOT_TOKEN?.trim()) {
    notes.push(`${pc.yellow("  WARN")} TELEGRAM_BOT_TOKEN is empty`);
  }
  if (mcpBearerToken) {
    notes.push(
      `${pc.yellow("  WARN")} MCP_HTTP_BEARER_TOKEN is set. MCP clients must send Authorization: Bearer <token>.`,
    );
  }
  if ((mode === "gateway" || mode === "both") && !parsed.ROOT_PREFIX?.trim()) {
    notes.push(
      `${pc.yellow("  WARN")} ROOT_PREFIX is not set, default /api will be used`,
    );
  }
  if ((mode === "gateway" || mode === "both") && !parsed.PORT?.trim()) {
    notes.push(
      `${pc.yellow("  WARN")} PORT is not set, default bind port will be used`,
    );
  }

  if (notes.length > 0) {
    printSection("notes", notes);
  } else {
    printSection("notes", [
      `${pc.green("  OK")} No obvious local config issues detected.`,
    ]);
  }

  if (
    browserEnabled &&
    (!playwrightStatus.enabled || !playwrightStatus.installed)
  ) {
    printSection("playwright", [
      `${pc.yellow("  ACTION")} Install browser binaries before using browser_* tools:`,
      "    tellymcp browser install",
    ]);
  }
}

function hasFlag(args: string[], flagName: string): boolean {
  return args.includes(flagName);
}

type ExtensionFlavor = "firefox" | "chrome";

function normalizeExtensionFlavor(
  rawValue: string | undefined,
): ExtensionFlavor | null {
  if (rawValue === "firefox" || rawValue === "ff") {
    return "firefox";
  }
  if (rawValue === "chrome") {
    return "chrome";
  }
  return null;
}

function getBundledExtensionDir(flavor: ExtensionFlavor): string {
  return path.join(
    packageRoot,
    "packages",
    flavor === "firefox"
      ? "firefox-attach-extension"
      : "chrome-attach-extension",
    "dist",
  );
}

function getDefaultExtensionTargetDir(flavor: ExtensionFlavor): string {
  return path.resolve(
    process.cwd(),
    flavor === "firefox" ? "tellymcp-firefox-attach" : "tellymcp-chrome-attach",
  );
}

function resolveExtensionTargetDir(
  args: string[],
  flavor: ExtensionFlavor,
): string {
  const explicitOutDir = readFlagValue(args, "--out-dir");
  if (explicitOutDir) {
    return path.resolve(process.cwd(), explicitOutDir);
  }

  const positionalOutDir = args.find((value, index) => {
    if (index === 0 || !value) {
      return false;
    }
    if (value === "--force") {
      return false;
    }
    return !value.startsWith("--out-dir=");
  });

  return positionalOutDir
    ? path.resolve(process.cwd(), positionalOutDir)
    : getDefaultExtensionTargetDir(flavor);
}

async function runSystemPrune(args: string[]): Promise<void> {
  const confirmed = hasFlag(args, "--yes");
  if (!confirmed) {
    fail("system-prune is destructive. Re-run with --yes.");
  }

  const filteredArgs = args.filter((arg) => arg !== "--yes");
  const { envPath, parsed } = loadCliEnv(filteredArgs);
  const mode = (parsed.DISTRIBUTED_MODE || "client").trim();
  const redisHost = (parsed.REDIS_HOST || "127.0.0.1").trim();
  const redisPort = Number(parsed.REDIS_PORT || 6379);
  const redisDb = Number(parsed.REDIS_DB || 1);
  const redisUsername = parsed.REDIS_USERNAME?.trim();
  const redisPassword = parsed.REDIS_PASSWORD?.trim();
  const dbHost = parsed.DB_HOST?.trim();
  const dbPort = Number(parsed.DB_PORT || 5432);
  const dbUser = parsed.DB_USER?.trim();
  const dbPassword = parsed.DB_PASSWORD?.trim();
  const dbName = parsed.DB_NAME?.trim();
  const dbSchema = (parsed.DB_SCHEMA || "mcp").trim();
  const xchangeDir = path.resolve(
    process.cwd(),
    parsed.MCP_XCHANGE_DIR || ".mcp-xchange",
  );
  const sessionMarkerPath = path.resolve(process.cwd(), ".mcpsession.json");
  const sqliteDbPath = path.join(xchangeDir, "xchange.sqlite3");

  printBanner("system-prune", "Destroying local and gateway state");
  printSection("Target", [
    `  env: ${envPath}`,
    `  mode: ${mode}`,
    ...(mode === "client"
      ? [`  state: process-local (Redis skipped)`]
      : [`  redis: ${redisHost}:${redisPort}/${redisDb}`]),
    ...(dbHost && dbUser && dbName
      ? [`  postgres: ${dbHost}:${dbPort}/${dbName} schema ${dbSchema}`]
      : [`  postgres: ${pc.dim("skipped (not configured)")}`]),
    `  xchange dir: ${xchangeDir}`,
    `  session marker: ${sessionMarkerPath}`,
  ]);

  let deletedRedisKeys = 0;
  if (mode !== "client") {
    const redis = new Redis({
      host: redisHost,
      port: redisPort,
      db: redisDb,
      ...(redisUsername ? { username: redisUsername } : {}),
      ...(redisPassword ? { password: redisPassword } : {}),
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });

    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          "telegram-mcp:*",
          "COUNT",
          500,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          deletedRedisKeys += await redis.del(...keys);
        }
      } while (cursor !== "0");
    } finally {
      redis.disconnect();
    }
  }

  let truncatedTables: string[] = [];
  if (dbHost && dbUser && dbName) {
    const pgModule = (await import("pg")) as unknown as {
      Client: new (config: Record<string, unknown>) => {
        connect(): Promise<void>;
        query(sql: string): Promise<void>;
        end(): Promise<void>;
      };
    };
    const { Client: PgClient } = pgModule;
    const pg = new PgClient({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
    });

    try {
      await pg.connect();
      truncatedTables = [
        "gateway_deliveries",
        "gateway_message_artifacts",
        "gateway_messages",
        "gateway_session_links",
        "gateway_sessions",
        "gateway_project_members",
        "gateway_projects",
        "gateway_clients",
      ];
      await pg.query(
        `TRUNCATE TABLE ${truncatedTables
          .map((table) => `"${dbSchema}"."${table}"`)
          .join(", ")} RESTART IDENTITY CASCADE`,
      );
    } finally {
      await pg.end();
    }
  }

  let deletedLocalArtifacts = 0;
  if (existsSync(sqliteDbPath)) {
    rmSync(sqliteDbPath, { force: true });
    deletedLocalArtifacts += 1;
  }
  if (existsSync(xchangeDir)) {
    rmSync(xchangeDir, { recursive: true, force: true });
    deletedLocalArtifacts += 1;
  }
  if (existsSync(sessionMarkerPath)) {
    rmSync(sessionMarkerPath, { force: true });
    deletedLocalArtifacts += 1;
  }

  printSection("Result", [
    `${pc.green("  OK")} redis keys deleted: ${deletedRedisKeys}`,
    ...(truncatedTables.length > 0
      ? [
          `${pc.green("  OK")} postgres tables truncated: ${truncatedTables.join(", ")}`,
        ]
      : [`${pc.dim("  SKIP")} postgres tables: not configured`]),
    `${pc.green("  OK")} local artifacts removed: ${deletedLocalArtifacts}`,
  ]);
}

function runBrowserCommand(args: string[]): void {
  const [subcommand] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printBrowserHelp();
    return;
  }

  if (subcommand !== "install") {
    fail("Supported browser subcommands: install");
  }

  const cliPath = path.join(
    packageRoot,
    "node_modules",
    "playwright",
    "cli.js",
  );
  if (!existsSync(cliPath)) {
    fail(`Missing bundled Playwright CLI: ${cliPath}`);
  }

  printBanner("browser install", "Installing bundled Playwright Chromium");
  const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function runExtensionCommand(args: string[]): void {
  const [rawFlavor] = args;
  if (!rawFlavor || rawFlavor === "--help" || rawFlavor === "-h") {
    printExtensionHelp();
    return;
  }

  const flavor = normalizeExtensionFlavor(rawFlavor);
  if (!flavor) {
    fail("Supported extension targets: firefox, ff, chrome");
  }

  const sourceDir = getBundledExtensionDir(flavor);
  const sourceManifestPath = path.join(sourceDir, "manifest.json");
  if (!existsSync(sourceManifestPath)) {
    fail(
      `Missing bundled ${flavor} extension. Reinstall or republish tellymcp with packaged extension bundles.`,
    );
  }

  const targetDir = resolveExtensionTargetDir(args, flavor);
  const force = hasFlag(args, "--force");
  if (existsSync(targetDir)) {
    if (!force) {
      fail(
        `Refusing to overwrite existing directory: ${targetDir}. Re-run with --force.`,
      );
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });

  printBanner(`extension ${flavor}`, "Bundled attach extension exported");
  printSection("result", [
    `  source: ${sourceDir}`,
    `  target: ${targetDir}`,
    `  manifest: ${path.join(targetDir, "manifest.json")}`,
  ]);

  if (flavor === "firefox") {
    printSection("next", [
      "  1. Open about:debugging#/runtime/this-firefox",
      "  2. Click 'Load Temporary Add-on'",
      `  3. Choose ${path.join(targetDir, "manifest.json")}`,
    ]);
    return;
  }

  printSection("next", [
    "  1. Open chrome://extensions",
    "  2. Enable Developer mode",
    "  3. Click 'Load unpacked'",
    `  4. Choose ${targetDir}`,
  ]);
}

function runCodexPluginCommand(args: string[]): void {
  const [subcommand] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printCodexPluginHelp();
    return;
  }

  if (subcommand !== "install" && subcommand !== "status") {
    fail("Supported codex-plugin subcommands: install, status");
  }

  if (subcommand === "status") {
    const status = getCodexPluginStatus(packageRoot);
    printBanner("codex plugin status", "Bundled telly-workflows plugin");
    printSection("plugin", [
      `  name: ${status.pluginName}`,
      `  bundled version: ${status.bundledVersion}`,
      `  source version: ${status.sourceVersion ?? "not synced yet"}`,
      `  installed version: ${status.installedVersion ?? "not installed"}`,
      `  codex cli: ${status.codexAvailable ? "detected" : "not detected"}`,
      `  marketplace registered: ${status.marketplaceRegistered ? "yes" : "no"}`,
      `  up to date: ${status.upToDate ? "yes" : "no"}`,
    ]);
    printSection("paths", [
      `  bundled: ${status.bundledPluginDir}`,
      `  managed: ${status.managedPluginDir}`,
      `  marketplace root: ${status.marketplaceRoot}`,
      `  marketplace file: ${status.marketplaceFile}`,
    ]);
    return;
  }

  const status = installCodexPlugin(packageRoot);
  printBanner("codex plugin install", "Bundled telly-workflows plugin");
  printSection("result", [
    `  plugin: ${status.pluginName}@${status.marketplaceName}`,
    `  bundled version: ${status.bundledVersion}`,
    `  source version: ${status.sourceVersion ?? "unknown"}`,
    `  installed version: ${status.installedVersion ?? "not installed"}`,
    `  marketplace registered: ${status.marketplaceRegistered ? "yes" : "no"}`,
    `  up to date: ${status.upToDate ? "yes" : "no"}`,
  ]);
  printSection("paths", [
    `  managed plugin dir: ${status.managedPluginDir}`,
    `  marketplace file: ${status.marketplaceFile}`,
  ]);
  if (!status.codexAvailable) {
    printSection("next", [
      "  Codex CLI was not detected on this machine.",
      "  The plugin source and marketplace manifest were synced locally.",
      "  Install Codex, then rerun: tellymcp codex-plugin install",
    ]);
  }
}

async function runRuntime(args: string[]): Promise<void> {
  const { envPath, parsed } = loadCliEnv(args);
  if (parsed.TELLYMCP_SESSION_ID) {
    process.env.TELLYMCP_SESSION_ID = parsed.TELLYMCP_SESSION_ID;
  }
  if (parsed.TELLYMCP_SESSION_LABEL) {
    process.env.TELLYMCP_SESSION_LABEL = parsed.TELLYMCP_SESSION_LABEL;
  }
  persistCliSessionMarker({
    cwd: process.cwd(),
    envPath,
    sessionId: parsed.TELLYMCP_SESSION_ID,
    sessionLabel: parsed.TELLYMCP_SESSION_LABEL,
  });

  const nativePtyStatus = await checkNativePtyRuntime();
  if (!nativePtyStatus.available) {
    fail(
      [
        `Built-in PTY runtime is unavailable on ${process.platform}-${process.arch} with Node ${process.versions.node}.`,
        nativePtyStatus.message,
        "",
        ...nativePtyRecoveryLines(),
        "Then rerun: tellymcp doctor --env <file>",
      ].join("\n"),
    );
  }

  if (isForegroundPtyClientMode(parsed)) {
    const { runForegroundPtyRuntime } =
      await import("./services/features/telegram-mcp/src/features/foreground-terminal/model/foregroundTerminalRuntime.js");
    await runForegroundPtyRuntime({
      envPath,
      packageRoot,
      printBanner,
    });
    return;
  }

  const runnerPath = path.join(
    packageRoot,
    "node_modules",
    "moleculer",
    "bin",
    "moleculer-runner.js",
  );
  const configPath = path.join(packageRoot, "dist", "moleculer.config.js");
  const servicesPath = path.join(packageRoot, "dist", "services");

  if (!existsSync(runnerPath)) {
    fail(`Missing bundled runner: ${runnerPath}`);
  }
  if (!existsSync(configPath)) {
    fail(`Missing compiled config: ${configPath}`);
  }
  if (!existsSync(servicesPath)) {
    fail(`Missing compiled services: ${servicesPath}`);
  }

  printBanner("run", "Starting packaged runtime");
  process.stdout.write(`${pc.green("terminal runtime:")} built-in PTY\n`);
  process.stdout.write(`${pc.cyan("Using env:")} ${envPath}\n\n`);

  const child = spawn(
    process.execPath,
    [
      runnerPath,
      servicesPath,
      "--config",
      configPath,
      "--mask",
      "**/*.service.js",
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        ENV_FILE: envPath,
        TELLYMCP_STANDALONE_HTTP: "true",
        ...(parsed.TELLYMCP_SESSION_ID
          ? { TELLYMCP_SESSION_ID: parsed.TELLYMCP_SESSION_ID }
          : {}),
        ...(parsed.TELLYMCP_SESSION_LABEL
          ? { TELLYMCP_SESSION_LABEL: parsed.TELLYMCP_SESSION_LABEL }
          : {}),
      },
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main(argv: string[]): Promise<void> {
  const [rawCommand, firstArg, secondArg] = argv;
  const command: CliCommand =
    rawCommand === "init" ||
    rawCommand === "configure" ||
    rawCommand === "migrate-env" ||
    rawCommand === "run" ||
    rawCommand === "help" ||
    rawCommand === "mcp" ||
    rawCommand === "oauth" ||
    rawCommand === "doctor" ||
    rawCommand === "browser" ||
    rawCommand === "system-prune" ||
    rawCommand === "codex-plugin" ||
    rawCommand === "extension"
      ? rawCommand
      : "help";

  if (
    command === "help" ||
    !rawCommand ||
    rawCommand === "--help" ||
    rawCommand === "-h"
  ) {
    printHelp();
    return;
  }

  if (command === "init") {
    initWorkspace(ensureMode(firstArg), secondArg);
    return;
  }

  if (command === "configure") {
    await runConfigure(argv.slice(1));
    return;
  }

  if (command === "migrate-env") {
    runMigrateEnv(argv.slice(1));
    return;
  }

  if (command === "mcp") {
    printMcpConfig(argv.slice(1));
    return;
  }

  if (command === "oauth") {
    runOAuthCommand(argv.slice(1));
    return;
  }

  if (command === "doctor") {
    await runDoctor(argv.slice(1));
    return;
  }

  if (command === "browser") {
    runBrowserCommand(argv.slice(1));
    return;
  }

  if (command === "extension") {
    runExtensionCommand(argv.slice(1));
    return;
  }

  if (command === "codex-plugin") {
    runCodexPluginCommand(argv.slice(1));
    return;
  }

  if (command === "system-prune") {
    await runSystemPrune(argv.slice(1));
    return;
  }

  await runRuntime(argv.slice(1));
}

void main(process.argv.slice(2));
