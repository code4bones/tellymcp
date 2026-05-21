import { afterEach, describe, expect, it } from "vitest";

import {
  captureTmuxPaneRange,
  captureVisibleTmuxPane,
  ensureTerminalTargetForSession,
  sendAllowedTmuxAction,
  sendTmuxLiteralText,
  type TmuxRuntimeConfig,
} from "@src/services/features/telegram-mcp/src/shared/integrations/tmux/client";
import { stopAllPtyTargets } from "@src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

const PTY_CONFIG: TmuxRuntimeConfig = {
  transport: "pty",
  shell: "/bin/cat",
  cols: 80,
  rows: 24,
  scrollbackLines: 200,
};

const PTY_SHELL_CONFIG: TmuxRuntimeConfig = {
  transport: "pty",
  shell: "/bin/sh",
  cols: 80,
  rows: 24,
  scrollbackLines: 200,
};

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("Timed out while waiting for PTY output");
}

afterEach(() => {
  stopAllPtyTargets();
});

describe("pty terminal transport", () => {
  it("creates a built-in shell target and captures output", async () => {
    const target = ensureTerminalTargetForSession(PTY_CONFIG, {
      sessionId: "backend",
      cwd: process.cwd(),
    });

    expect(target).toBe("pty:backend");

    await sendTmuxLiteralText(PTY_CONFIG, target, "hello from pty");
    await sendAllowedTmuxAction(PTY_CONFIG, target, "enter");

    await waitFor(async () => {
      const snapshot = await captureTmuxPaneRange(
        PTY_CONFIG,
        target,
        "-20",
        false,
      );
      return snapshot.includes("hello from pty");
    });

    const visible = await captureVisibleTmuxPane(PTY_CONFIG, target, 20, 1);
    expect(visible).toContain("hello from pty");
  });

  it("strips PTY redraw escape garbage from captured buffer", async () => {
    const target = ensureTerminalTargetForSession(PTY_SHELL_CONFIG, {
      sessionId: "ansi-cleanup",
      cwd: process.cwd(),
    });

    await sendTmuxLiteralText(PTY_SHELL_CONFIG, target, "stty -echo");
    await sendAllowedTmuxAction(PTY_SHELL_CONFIG, target, "enter");

    await sendTmuxLiteralText(
      PTY_SHELL_CONFIG,
      target,
      "printf '\\033[Kfoo\\rbar\\033[27;3H\\033]0;title\\007\\n'",
    );
    await sendAllowedTmuxAction(PTY_SHELL_CONFIG, target, "enter");

    await waitFor(async () => {
      const snapshot = await captureVisibleTmuxPane(
        PTY_SHELL_CONFIG,
        target,
        20,
        1,
      );
      return snapshot.includes("bar");
    });

    const visible = await captureVisibleTmuxPane(
      PTY_SHELL_CONFIG,
      target,
      20,
      1,
    );
    expect(visible).toContain("bar");
    expect(visible).not.toContain("\u001b[");
    expect(visible).not.toContain("\u001b]");
  });
});
