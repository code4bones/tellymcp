import {
  captureVisibleTerminal,
  ensureTerminalTargetForSession,
  getConfiguredTerminalShellDisplayName,
  resizeForegroundTerminal,
  sendForegroundTerminalInput,
  stopAllForegroundTerminals,
  subscribeForegroundTerminal,
} from "../../../shared/integrations/terminal/client";
import { createEmbeddedRuntimeBroker } from "../../embedded-runtime/model/embeddedRuntimeBroker";
import type { AppRuntime } from "../../../app/bootstrap/runtime";

export type ForegroundRuntimeHandle = {
  broker: {
    call(actionName: string, params?: Record<string, unknown>): Promise<unknown>;
    stop(): Promise<void>;
    getLocalService(name: string): unknown;
  };
  runtime: AppRuntime;
};

export function isForegroundPtyClientMode(parsed: Record<string, string>): boolean {
  return (
    (parsed.DISTRIBUTED_MODE || "client").trim() === "client" &&
    (parsed.TERMINAL_TRANSPORT || "tmux").trim() === "pty"
  );
}

type RunForegroundPtyRuntimeInput = {
  envPath: string;
  packageRoot: string;
  printBanner: (title: string, subtitle?: string) => void;
};

async function createForegroundBroker(
  envPath: string,
  packageRoot: string,
): Promise<ForegroundRuntimeHandle> {
  if (!process.env.LOG_STDERR_LEVEL?.trim()) {
    process.env.LOG_STDERR_LEVEL = "error";
  }
  if (!process.env.LOG_FILE_ENABLED?.trim()) {
    process.env.LOG_FILE_ENABLED = "true";
  }
  if (!process.env.LOG_FILE_LEVEL?.trim()) {
    process.env.LOG_FILE_LEVEL = process.env.LOG_LEVEL?.trim() || "info";
  }
  return createEmbeddedRuntimeBroker({
    envPath,
    packageRoot,
    standaloneHttp: false,
  });
}

async function ensureForegroundPtySession(
  runtime: ForegroundRuntimeHandle["runtime"],
): Promise<{ sessionId: string; sessionLabel: string; target: string }> {
  const resolved = runtime.projectIdentityResolver.resolveSessionDefaults({
    cwd: process.cwd(),
  });
  const existing = await runtime.sessionStore.getSession(resolved.sessionId);
  const target = ensureTerminalTargetForSession(runtime.config.tmux, {
    sessionId: resolved.sessionId,
    cwd: resolved.cwd,
    ...(typeof existing?.tmuxTarget === "string"
      ? { target: existing.tmuxTarget }
      : {}),
  });

  if (!target) {
    throw new Error("PTY terminal target could not be created");
  }

  const updatedAt = new Date().toISOString();
  const shellDisplayName = getConfiguredTerminalShellDisplayName(runtime.config.tmux);

  await runtime.sessionStore.setSession({
    sessionId: resolved.sessionId,
    ...(typeof existing?.label === "string"
      ? { label: existing.label }
      : { label: resolved.sessionLabel }),
    ...(typeof existing?.cwd === "string" ? { cwd: existing.cwd } : { cwd: resolved.cwd }),
    ...(typeof existing?.linkedSessionId === "string"
      ? { linkedSessionId: existing.linkedSessionId }
      : {}),
    ...(typeof existing?.activeProjectUuid === "string"
      ? { activeProjectUuid: existing.activeProjectUuid }
      : {}),
    ...(typeof existing?.activeProjectName === "string"
      ? { activeProjectName: existing.activeProjectName }
      : {}),
    ...(typeof existing?.task === "string" ? { task: existing.task } : {}),
    ...(typeof existing?.summary === "string" ? { summary: existing.summary } : {}),
    ...(Array.isArray(existing?.files) ? { files: existing.files } : {}),
    ...(Array.isArray(existing?.decisions)
      ? { decisions: existing.decisions }
      : {}),
    ...(Array.isArray(existing?.risks) ? { risks: existing.risks } : {}),
    tmuxSessionName: "pty",
    tmuxWindowName: shellDisplayName,
    tmuxPaneId: target,
    tmuxTarget: target,
    ...(typeof existing?.tmuxWindowIndex === "number"
      ? { tmuxWindowIndex: existing.tmuxWindowIndex }
      : {}),
    ...(typeof existing?.tmuxPaneIndex === "number"
      ? { tmuxPaneIndex: existing.tmuxPaneIndex }
      : {}),
    ...(typeof existing?.lastTmuxNudgeAt === "string"
      ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
      : {}),
    ...(typeof existing?.lastSeenToolsHash === "string"
      ? { lastSeenToolsHash: existing.lastSeenToolsHash }
      : {}),
    ...(typeof existing?.lastNotifiedToolsHash === "string"
      ? { lastNotifiedToolsHash: existing.lastNotifiedToolsHash }
      : {}),
    updatedAt,
  });

  return {
    sessionId: resolved.sessionId,
    sessionLabel:
      typeof existing?.label === "string" && existing.label.trim()
        ? existing.label
        : resolved.sessionLabel,
    target,
  };
}

async function attachCurrentTerminalToPty(
  runtime: ForegroundRuntimeHandle["runtime"],
  target: string,
): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const resize = () => {
    if (stdout.isTTY) {
      resizeForegroundTerminal(target, stdout.columns || 120, stdout.rows || 40);
    }
  };

  resize();

  const snapshot = await captureVisibleTerminal(runtime.config.tmux, target, 80, 1);
  if (snapshot.trim().length > 0) {
    stdout.write(`${snapshot}${snapshot.endsWith("\n") ? "" : "\n"}`);
  }

  return new Promise<number>((resolve, reject) => {
    let finished = false;

    const finish = async (code: number) => {
      if (finished) {
        return;
      }
      finished = true;
      detach();
      try {
        await Promise.resolve();
      } finally {
        resolve(code);
      }
    };

    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const onStdinData = (chunk: Buffer | string) => {
      sendForegroundTerminalInput(
        target,
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    };

    const detachPty = subscribeForegroundTerminal(target, {
      onData: (data) => {
        stdout.write(data);
      },
      onExit: ({ exitCode }) => {
        void finish(exitCode);
      },
    });

    const onSigwinch = () => {
      resize();
    };

    const onSignal = (signal: NodeJS.Signals) => {
      void runtime.logger.warn("Foreground PTY runtime interrupted", { signal });
      void finish(signal === "SIGTERM" ? 143 : 130);
    };

    const detach = () => {
      detachPty();
      stdin.off("data", onStdinData);
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
      stdout.off("resize", onSigwinch);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const sigintHandler = () => {
      onSignal("SIGINT");
    };
    const sigtermHandler = () => {
      onSignal("SIGTERM");
    };

    stdin.on("data", onStdinData);
    stdout.on("resize", onSigwinch);
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);

    process.nextTick(() => {
      try {
        sendForegroundTerminalInput(target, "");
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function runForegroundPtyRuntime(
  input: RunForegroundPtyRuntimeInput,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Foreground PTY mode requires an interactive TTY. Run this command in a real terminal or switch TERMINAL_TRANSPORT=tmux.",
    );
  }

  input.printBanner("run", "Starting foreground PTY runtime");
  process.stdout.write(`Using env: ${input.envPath}\n`);
  process.stdout.write("Mode: client + built-in PTY\n\n");

  const handle = await createForegroundBroker(input.envPath, input.packageRoot);

  try {
    const session = await ensureForegroundPtySession(handle.runtime);
    await handle.broker
      .call("telegramMcp.gatewaySocket.refreshClientHello")
      .catch((error: unknown) => {
        handle.runtime.logger.warn("Foreground PTY hello refresh failed", {
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          sessionId: session.sessionId,
        });
      });
    process.stdout.write(
      `Attached session: ${session.sessionLabel} (${session.sessionId})\n`,
    );
    process.stdout.write(`Terminal target: ${session.target}\n\n`);

    const exitCode = await attachCurrentTerminalToPty(handle.runtime, session.target);
    await handle.broker.stop();
    stopAllForegroundTerminals();
    process.exit(exitCode);
  } catch (error) {
    stopAllForegroundTerminals();
    await handle.broker.stop().catch(() => undefined);
    throw error;
  }
}
