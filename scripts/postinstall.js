"use strict";

const { spawnSync } = require("node:child_process");
const pc = require("picocolors");

function hasCodex() {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function line(value = "") {
  process.stdout.write(`${value}\n`);
}

line();
line(`${pc.bold(pc.cyan("TellyMCP"))} ${pc.dim("installed")}`);
line();

line(`${pc.green("OK")} Built-in PTY terminal runtime is enabled.`);

line();
line(`${pc.yellow("INFO")} Browser tools need Playwright browser binaries.`);
line("If you plan to use browser_* tools, run:");
line(`  ${pc.bold("tellymcp browser install")}`);

if (hasCodex()) {
  line();
  line(`${pc.yellow("INFO")} Codex CLI detected on this machine.`);
  line("To sync or update the bundled Codex workflow plugin, run:");
  line(`  ${pc.bold("tellymcp codex-plugin install")}`);
}

line();
line(`Check your local setup: ${pc.bold("tellymcp doctor")}`);
line(`General help: ${pc.bold("tellymcp help")}`);
line(`MCP setup examples: ${pc.bold("tellymcp mcp --help")}`);
line();
