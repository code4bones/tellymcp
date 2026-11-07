import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import {
  listLocalSessions,
  resolveLocalOwner,
} from "./services/features/telegram-mcp/src/features/detached-terminal/model/localSessions";
import type { LocalRegistry } from "./services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry";
import { formatSessionsTable } from "./cliSessionsTable";

const clean = (value: string) =>
  stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");

/** Select by owner handle; listing and cancellation never acquire a controller. */
export async function pickLocalSession(
  registry: LocalRegistry,
): Promise<string | undefined> {
  const sessions = await listLocalSessions(registry);
  if (!sessions.length) {
    process.stdout.write("No local sessions. Start one with tellymcp run.\n");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Session selection requires an interactive TTY. Use tellymcp attach <handle> from a terminal.",
    );
  const available = sessions.filter(
    (session) => session.state === "running" && session.attached === false,
  );
  if (!available.length) {
    process.stdout.write(
      formatSessionsTable(sessions, { columns: process.stdout.columns || 80 }),
    );
    throw new Error("No detached local sessions are available to attach.");
  }
  let initialValue = available[0]!.handle;
  try {
    const current = resolveLocalOwner(registry);
    if (available.some((session) => session.handle === current.instance))
      initialValue = current.instance;
  } catch {
    // Selection also works outside a workspace, without a marker or profile.
  }
  const { select, isCancel, intro, cancel } = await import("@clack/prompts");
  // Clack toggles raw mode; retain the exact termios for attach and cancellation.
  const stdin = process.stdin;
  const saved = execFileSync("stty", ["-g"], {
    stdio: [stdin.fd, "pipe", "ignore"],
    timeout: 1000,
  })
    .toString()
    .trim();
  const wasRaw = stdin.isRaw,
    wasFlowing = stdin.readableFlowing === true;
  const controller = new AbortController();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    process.exitCode =
      signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 130;
    controller.abort();
  };
  const onEnd = () => controller.abort();
  for (const signal of signals) process.on(signal, onSignal);
  stdin.once("end", onEnd);
  try {
    intro(pc.bgCyan(pc.black(" TellyMCP · attach ")));
    const handle = await select({
      message: "Select a session (Esc to cancel)",
      initialValue,
      maxItems: 8,
      signal: controller.signal,
      options: sessions.map((session) => {
        const detached = available.some(
          (candidate) => candidate.handle === session.handle,
        );
        const status =
          session.state !== "running"
            ? session.state
            : session.attached
              ? "attached · busy"
              : "detached";
        return {
          value: session.handle,
          label:
            clean(session.session_label) +
            "  " +
            (detached ? pc.green(status) : pc.dim(status)) +
            "  " +
            pc.dim(session.handle.slice(0, 8)),
          hint: clean(session.cwd) + " · " + session.handle,
          disabled: !detached,
        };
      }),
    });
    if (isCancel(handle)) {
      cancel("Attach cancelled.");
      return;
    }
    return handle;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    stdin.off("end", onEnd);
    try {
      stdin.setRawMode(wasRaw);
    } finally {
      execFileSync("stty", [saved], {
        stdio: [stdin.fd, "ignore", "ignore"],
        timeout: 1000,
      });
      if (!wasFlowing) stdin.pause();
    }
  }
}
