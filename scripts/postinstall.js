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

function checkNativePty() {
  try {
    const nodePty = require("node-pty");
    return typeof nodePty.spawn === "function"
      ? { available: true }
      : {
          available: false,
          message: "node-pty loaded without a spawn function.",
        };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      message: message.split("\n", 1)[0] || "node-pty failed to load.",
    };
  }
}

line();
line(`${pc.bold(pc.cyan("TellyMCP"))} ${pc.dim("installed")}`);
line();

const nativePty = checkNativePty();
if (nativePty.available) {
  line(`${pc.green("OK")} Built-in PTY native module loaded.`);
} else {
  line(`${pc.red("ERROR")} Built-in PTY native module is unavailable.`);
  line(`  ${nativePty.message}`);
  line(
    `  Platform: ${process.platform}-${process.arch}, Node ${process.versions.node}`,
  );
  if (process.platform === "linux") {
    line("  Debian/Ubuntu prerequisites: sudo apt install -y python3 make g++");
  }
  line("  Ensure scripts are enabled: npm config set ignore-scripts false");
  line("  Rebuild: npm rebuild -g @deadragdoll/tellymcp --foreground-scripts");
}

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
