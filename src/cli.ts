#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

type InitMode = "client" | "gateway" | "both";
type CliCommand = "help" | "init" | "run";

const distDir = __dirname;
const packageRoot = path.resolve(distDir, "..");

function printHelp(): void {
  process.stdout.write(`TellyMCP CLI

Usage:
  tellymcp init <client|gateway|both> [directory]
  tellymcp run [--env <file>]
  tellymcp run --env=<file>
  tellymcp help

Examples:
  tellymcp init client
  tellymcp init gateway ./gateway-node
  tellymcp run
  tellymcp run --env .env.client
`);
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
  const nestedTemplatePath = path.join(packageRoot, "config", "templates", templateName);
  const resolvedTemplatePath = existsSync(templatePath) ? templatePath : nestedTemplatePath;
  if (!existsSync(resolvedTemplatePath)) {
    fail(`Missing packaged template: ${templateName}`);
  }

  return readFileSync(resolvedTemplatePath, "utf8");
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

  process.stdout.write(`Created ${envPath}\n`);
  process.stdout.write(`Next: edit .env, then run: cd ${targetDir} && tellymcp run\n`);
}

function resolveRunEnvPath(args: string[]): string {
  const [firstArg, secondArg] = args;

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

  return path.resolve(process.cwd(), ".env");
}

function runRuntime(args: string[]): void {
  const envPath = resolveRunEnvPath(args);
  if (!existsSync(envPath)) {
    fail(`Missing ${envPath}. Run 'tellymcp init <client|gateway|both>' first or pass --env <file>.`);
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

function main(argv: string[]): void {
  const [rawCommand, firstArg, secondArg] = argv;
  const command: CliCommand = rawCommand === "init" || rawCommand === "run" || rawCommand === "help"
    ? rawCommand
    : "help";

  if (command === "help" || !rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    initWorkspace(ensureMode(firstArg), secondArg);
    return;
  }

  runRuntime(argv.slice(1));
}

main(process.argv.slice(2));
