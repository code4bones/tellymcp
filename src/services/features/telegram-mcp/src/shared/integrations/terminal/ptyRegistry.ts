import path from "node:path";

import { spawn, type IPty } from "node-pty";

export type PtySessionConfig = {
  shell: string;
  cols: number;
  rows: number;
  scrollbackLines: number;
};

export type PtySessionInput = {
  sessionId: string;
  cwd?: string | undefined;
  target?: string | undefined;
};

type PtySessionRecord = {
  target: string;
  sessionId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  scrollbackLines: number;
  partialLine: string;
  lines: string[];
  pty: IPty | null;
  exited: boolean;
  exitCode?: number | undefined;
  signal?: number | undefined;
};

export type PtyExitInfo = {
  exitCode: number;
  signal?: number | undefined;
};

const PTY_TARGET_PREFIX = "pty:";
const sessions = new Map<string, PtySessionRecord>();

function toLineBuffer(input: string): string[] {
  return input
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n");
}

function trimLines(record: PtySessionRecord): void {
  if (record.lines.length <= record.scrollbackLines) {
    return;
  }
  record.lines.splice(0, record.lines.length - record.scrollbackLines);
}

function appendOutput(record: PtySessionRecord, chunk: string): void {
  const parts = toLineBuffer(record.partialLine + chunk);
  record.partialLine = parts.pop() ?? "";
  if (parts.length > 0) {
    record.lines.push(...parts);
    trimLines(record);
  }
}

function getShellDisplayName(shell: string): string {
  const baseName = path.basename(shell.trim());
  return baseName || shell.trim() || "bash";
}

function buildExitLine(record: PtySessionRecord): string {
  const parts = ["[pty exited"];
  if (typeof record.exitCode === "number") {
    parts.push(`code=${record.exitCode}`);
  }
  if (typeof record.signal === "number") {
    parts.push(`signal=${record.signal}`);
  }
  return `${parts.join(" ")}]`;
}

export function isPtyTarget(target: string | null | undefined): boolean {
  return typeof target === "string" && target.startsWith(PTY_TARGET_PREFIX);
}

export function buildPtyTarget(sessionId: string): string {
  return `${PTY_TARGET_PREFIX}${sessionId.trim()}`;
}

export function getPtyShellDisplayName(config: PtySessionConfig): string {
  return getShellDisplayName(config.shell);
}

function createSessionRecord(
  config: PtySessionConfig,
  input: PtySessionInput,
): PtySessionRecord {
  const target = input.target?.trim() || buildPtyTarget(input.sessionId);
  const cwd = input.cwd?.trim() || process.cwd();
  const record: PtySessionRecord = {
    target,
    sessionId: input.sessionId.trim(),
    cwd,
    shell: config.shell,
    cols: config.cols,
    rows: config.rows,
    scrollbackLines: config.scrollbackLines,
    partialLine: "",
    lines: [],
    pty: null,
    exited: false,
  };

  const pty = spawn(record.shell, [], {
    name: "xterm-color",
    cols: record.cols,
    rows: record.rows,
    cwd: record.cwd,
    env: process.env as Record<string, string>,
  });

  pty.onData((data) => {
    appendOutput(record, data);
  });

  pty.onExit(({ exitCode, signal }) => {
    record.pty = null;
    record.exited = true;
    record.exitCode = exitCode;
    record.signal = signal;
    appendOutput(record, `\n${buildExitLine(record)}\n`);
  });

  record.pty = pty;
  return record;
}

function getSessionRecord(target: string): PtySessionRecord {
  const record = sessions.get(target);
  if (!record) {
    throw new Error(`pty target is unavailable: ${target}`);
  }
  return record;
}

function ensureRunningPty(record: PtySessionRecord): IPty {
  if (!record.pty || record.exited) {
    throw new Error(`pty target is unavailable: ${record.target}`);
  }
  return record.pty;
}

function parseCaptureStart(start: string): number | null {
  const parsed = Number.parseInt(start.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasPtyTarget(target: string): boolean {
  return sessions.has(target);
}

export function listPtyTargets(): string[] {
  return [...sessions.keys()];
}

export function ensurePtySession(
  config: PtySessionConfig,
  input: PtySessionInput,
): string {
  const target = input.target?.trim() || buildPtyTarget(input.sessionId);
  const existing = sessions.get(target);
  if (existing && existing.pty && !existing.exited) {
    return target;
  }

  const record = createSessionRecord(config, {
    ...input,
    target,
  });
  sessions.set(target, record);
  return target;
}

export function getPtyWindowHeight(target: string): number | null {
  const record = getSessionRecord(target);
  return record.rows;
}

export function capturePtyRange(target: string, start: string): string {
  const record = getSessionRecord(target);
  const captureStart = parseCaptureStart(start);
  const lines = [...record.lines];
  if (record.partialLine.length > 0) {
    lines.push(record.partialLine);
  }

  if (lines.length === 0) {
    return "";
  }

  if (captureStart === null) {
    return lines.join("\n");
  }

  if (captureStart < 0) {
    return lines.slice(Math.max(0, lines.length + captureStart)).join("\n");
  }

  return lines.slice(captureStart).join("\n");
}

export function captureVisiblePty(
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): string {
  const record = getSessionRecord(target);
  const lineCount = Math.max(
    1,
    (record.rows > 0 ? record.rows : fallbackLines) * Math.max(1, visibleScreens),
  );
  return capturePtyRange(target, `-${lineCount}`);
}

export function sendPtyAction(
  target: string,
  action:
    | "up"
    | "down"
    | "enter"
    | "slash"
    | "delete"
    | "tab"
    | "escape"
    | "interrupt",
): void {
  const pty = ensureRunningPty(getSessionRecord(target));
  const input =
    action === "up"
      ? "\u001b[A"
      : action === "down"
        ? "\u001b[B"
        : action === "enter"
          ? "\r"
          : action === "slash"
            ? "/"
            : action === "delete"
              ? "\u007f"
              : action === "tab"
                ? "\t"
                : action === "escape"
                  ? "\u001b"
                  : "\u0003";
  pty.write(input);
}

export function sendPtyText(target: string, text: string): void {
  const pty = ensureRunningPty(getSessionRecord(target));
  pty.write(text);
}

export function resizePtyTarget(
  target: string,
  cols: number,
  rows: number,
): void {
  const record = getSessionRecord(target);
  const pty = ensureRunningPty(record);
  record.cols = cols;
  record.rows = rows;
  pty.resize(cols, rows);
}

export function subscribePtyTarget(
  target: string,
  input: {
    onData?: ((data: string) => void) | undefined;
    onExit?: ((info: PtyExitInfo) => void) | undefined;
  },
): () => void {
  const record = getSessionRecord(target);
  const pty = ensureRunningPty(record);
  const disposers: Array<() => void> = [];

  if (input.onData) {
    const disposable = pty.onData(input.onData);
    disposers.push(() => {
      disposable.dispose();
    });
  }

  if (input.onExit) {
    const disposable = pty.onExit(({
      exitCode,
      signal,
    }: {
      exitCode: number;
      signal?: number | undefined;
    }) => {
      input.onExit?.({ exitCode, signal });
    });
    disposers.push(() => {
      disposable.dispose();
    });
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

export function stopPtyTarget(target: string): boolean {
  const record = sessions.get(target);
  if (!record) {
    return false;
  }
  record.pty?.kill();
  record.pty = null;
  record.exited = true;
  return true;
}

export function stopAllPtyTargets(): void {
  for (const target of listPtyTargets()) {
    stopPtyTarget(target);
  }
}
