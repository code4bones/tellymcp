"use strict";

const { spawnSync } = require("node:child_process");
const pc = require("picocolors");

function getTmuxStatus() {
  const result = spawnSync("tmux", ["-V"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    return {
      found: true,
      version: (result.stdout || "tmux").trim(),
    };
  }

  return { found: false };
}

function getInstallHints() {
  if (process.platform === "darwin") {
    return ["brew install tmux"];
  }

  return [
    "Ubuntu/Debian: sudo apt install tmux",
    "Fedora/RHEL:   sudo dnf install tmux",
    "Arch:          sudo pacman -S tmux",
  ];
}

function line(value = "") {
  process.stdout.write(`${value}\n`);
}

const tmux = getTmuxStatus();

line();
line(`${pc.bold(pc.cyan("TellyMCP"))} ${pc.dim("installed")}`);
line();

if (tmux.found) {
  line(`${pc.green("OK")} tmux detected: ${tmux.version}`);
  line("Live view and session nudges should work on this machine.");
} else {
  line(`${pc.yellow("WARN")} tmux was not found on this system.`);
  line("TellyMCP can still run, but Live view and nudges will be limited.");
  line("Install tmux, for example:");
  for (const hint of getInstallHints()) {
    line(`  ${hint}`);
  }
}

line();
line(`${pc.yellow("INFO")} Browser tools need Playwright browser binaries.`);
line("If you plan to use browser_* tools, run:");
line(`  ${pc.bold("tellymcp browser install")}`);

line();
line(`Check your local setup: ${pc.bold("tellymcp doctor")}`);
line(`General help: ${pc.bold("tellymcp help")}`);
line(`MCP setup examples: ${pc.bold("tellymcp mcp --help")}`);
line();
