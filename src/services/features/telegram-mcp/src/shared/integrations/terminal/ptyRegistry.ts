import path from "node:path";

import { spawn, type IPty } from "node-pty";
import * as XtermHeadless from "@xterm/headless";

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
  terminal: InstanceType<typeof XtermHeadless.Terminal>;
  pendingWrite: Promise<void>;
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

type CellStyleState = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  underline: boolean;
  italic: boolean;
  inverse: boolean;
};

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

function createHeadlessTerminal(
  config: PtySessionConfig,
): InstanceType<typeof XtermHeadless.Terminal> {
  return new XtermHeadless.Terminal({
    cols: config.cols,
    rows: config.rows,
    scrollback: config.scrollbackLines,
    allowProposedApi: true,
  });
}

function createSessionRecord(
  config: PtySessionConfig,
  input: PtySessionInput,
): PtySessionRecord {
  const target = input.target?.trim() || buildPtyTarget(input.sessionId);
  const cwd = input.cwd?.trim() || process.cwd();
  const terminal = createHeadlessTerminal(config);
  const record: PtySessionRecord = {
    target,
    sessionId: input.sessionId.trim(),
    cwd,
    shell: config.shell,
    cols: config.cols,
    rows: config.rows,
    scrollbackLines: config.scrollbackLines,
    terminal,
    pendingWrite: Promise.resolve(),
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
    record.pendingWrite = record.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          record.terminal.write(data, resolve);
        }),
    );
  });

  pty.onExit(({ exitCode, signal }) => {
    record.pty = null;
    record.exited = true;
    record.exitCode = exitCode;
    record.signal = signal;
    record.pendingWrite = record.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          record.terminal.writeln(buildExitLine(record), resolve);
        }),
    );
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

function snapshotTerminalLines(record: PtySessionRecord): string[] {
  const buffer = record.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines;
}

function snapshotTerminalContentLines(record: PtySessionRecord): string[] {
  const lines = snapshotTerminalLines(record);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function xtermColor(index: number): string | null {
  const base = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];

  if (index < 16) {
    return base[index] ?? null;
  }

  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[r]},${steps[g]},${steps[b]})`;
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
  }

  return null;
}

function rgbColor(value: number): string {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgb(${r},${g},${b})`;
}

function cellColor(
  isDefault: boolean,
  isPalette: boolean,
  colorValue: number,
): string | null {
  if (isDefault) {
    return null;
  }
  if (isPalette) {
    return xtermColor(colorValue);
  }
  return rgbColor(colorValue);
}

function styleStateEquals(left: CellStyleState, right: CellStyleState): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.underline === right.underline &&
    left.italic === right.italic &&
    left.inverse === right.inverse
  );
}

function styleStateToHtml(state: CellStyleState): string {
  const fg = state.inverse ? state.bg : state.fg;
  const bg = state.inverse ? state.fg : state.bg;
  const classes: string[] = [];
  const styles: string[] = [];

  if (state.bold) {
    classes.push("ansi-bold");
  }
  if (state.underline) {
    classes.push("ansi-underline");
  }
  if (state.italic) {
    styles.push("font-style:italic");
  }
  if (fg) {
    styles.push(`color:${fg}`);
  }
  if (bg) {
    styles.push(`background:${bg}`);
  }

  if (classes.length === 0 && styles.length === 0) {
    return "";
  }

  const attrs: string[] = [];
  if (classes.length > 0) {
    attrs.push(`class="${classes.join(" ")}"`);
  }
  if (styles.length > 0) {
    attrs.push(`style="${styles.join(";")}"`);
  }
  return attrs.join(" ");
}

function getVisibleWindowRange(
  record: PtySessionRecord,
  fallbackLines: number,
  visibleScreens: number,
): { start: number; end: number } {
  const buffer = record.terminal.buffer.active;
  const lineCount = Math.max(
    1,
    (record.rows > 0 ? record.rows : fallbackLines) * Math.max(1, visibleScreens),
  );
  const start = Math.max(0, buffer.viewportY + record.rows - lineCount);
  const end = Math.min(buffer.length, start + lineCount);
  return { start, end };
}

function renderVisiblePtyHtmlFromRecord(
  record: PtySessionRecord,
  fallbackLines: number,
  visibleScreens: number,
): string {
  const buffer = record.terminal.buffer.active;
  const { start, end } = getVisibleWindowRange(
    record,
    fallbackLines,
    visibleScreens,
  );
  const lines: string[] = [];

  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      lines.push("");
      continue;
    }

    const parts: string[] = [];
    let chunk = "";
    let currentStyle: CellStyleState | null = null;

    const flushChunk = () => {
      if (!chunk) {
        return;
      }
      const escaped = escapeHtml(chunk);
      if (!currentStyle) {
        parts.push(escaped);
      } else {
        const attrs = styleStateToHtml(currentStyle);
        parts.push(attrs ? `<span ${attrs}>${escaped}</span>` : escaped);
      }
      chunk = "";
    };

    for (let x = 0; x < record.cols; x += 1) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }

      const nextStyle: CellStyleState = {
        fg: cellColor(cell.isFgDefault(), cell.isFgPalette(), cell.getFgColor()),
        bg: cellColor(cell.isBgDefault(), cell.isBgPalette(), cell.getBgColor()),
        bold: cell.isBold() > 0,
        underline: cell.isUnderline() > 0,
        italic: cell.isItalic() > 0,
        inverse: cell.isInverse() > 0,
      };

      if (!currentStyle || !styleStateEquals(currentStyle, nextStyle)) {
        flushChunk();
        currentStyle = nextStyle;
      }

      chunk += cell.getChars() || " ";
    }

    flushChunk();
    lines.push(parts.join(""));
  }

  return lines.join("\n");
}

function styleStateToSgrCodes(state: CellStyleState): number[] {
  const codes: number[] = [0];

  if (state.bold) {
    codes.push(1);
  }
  if (state.italic) {
    codes.push(3);
  }
  if (state.underline) {
    codes.push(4);
  }
  if (state.inverse) {
    codes.push(7);
  }

  const pushColor = (value: string | null, isBackground: boolean) => {
    if (!value) {
      return;
    }
    if (value.startsWith("#")) {
      const normalized = value.slice(1);
      if (normalized.length === 6) {
        const numeric = Number.parseInt(normalized, 16);
        const r = (numeric >> 16) & 0xff;
        const g = (numeric >> 8) & 0xff;
        const b = numeric & 0xff;
        codes.push(isBackground ? 48 : 38, 2, r, g, b);
      }
      return;
    }
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/u.exec(value);
    if (!match) {
      return;
    }
    codes.push(
      isBackground ? 48 : 38,
      2,
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
  };

  pushColor(state.fg, false);
  pushColor(state.bg, true);
  return codes;
}

function renderVisiblePtyAnsiFromRecord(
  record: PtySessionRecord,
  fallbackLines: number,
  visibleScreens: number,
): string {
  const buffer = record.terminal.buffer.active;
  const { start, end } = getVisibleWindowRange(
    record,
    fallbackLines,
    visibleScreens,
  );
  const lines: string[] = [];

  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      lines.push("");
      continue;
    }

    let row = "";
    let currentStyle: CellStyleState | null = null;

    for (let x = 0; x < record.cols; x += 1) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }

      const nextStyle: CellStyleState = {
        fg: cellColor(cell.isFgDefault(), cell.isFgPalette(), cell.getFgColor()),
        bg: cellColor(cell.isBgDefault(), cell.isBgPalette(), cell.getBgColor()),
        bold: cell.isBold() > 0,
        underline: cell.isUnderline() > 0,
        italic: cell.isItalic() > 0,
        inverse: cell.isInverse() > 0,
      };

      if (!currentStyle || !styleStateEquals(currentStyle, nextStyle)) {
        row += `\u001b[${styleStateToSgrCodes(nextStyle).join(";")}m`;
        currentStyle = nextStyle;
      }

      row += cell.getChars() || " ";
    }

    if (currentStyle) {
      row += "\u001b[0m";
    }
    lines.push(row.trimEnd());
  }

  return lines.join("\n");
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

  if (existing) {
    existing.terminal.dispose();
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

export function getPtyWindowSize(
  target: string,
): { cols: number; rows: number } | null {
  const record = sessions.get(target);
  if (!record) {
    return null;
  }

  return {
    cols: record.cols,
    rows: record.rows,
  };
}

export async function capturePtyRange(
  target: string,
  start: string,
): Promise<string> {
  const record = getSessionRecord(target);
  await record.pendingWrite;
  const captureStart = parseCaptureStart(start);
  const lines = snapshotTerminalContentLines(record);

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

export async function captureVisiblePty(
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  const record = getSessionRecord(target);
  await record.pendingWrite;
  const buffer = record.terminal.buffer.active;
  const lineCount = Math.max(
    1,
    (record.rows > 0 ? record.rows : fallbackLines) * Math.max(1, visibleScreens),
  );
  const start = Math.max(0, buffer.viewportY + record.rows - lineCount);
  const end = Math.min(buffer.length, start + lineCount);
  const lines: string[] = [];

  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return lines.join("\r\n");
}

export async function renderVisiblePtyHtml(
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  const record = getSessionRecord(target);
  await record.pendingWrite;
  return renderVisiblePtyHtmlFromRecord(record, fallbackLines, visibleScreens);
}

export async function renderVisiblePtyAnsi(
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  const record = getSessionRecord(target);
  await record.pendingWrite;
  return renderVisiblePtyAnsiFromRecord(record, fallbackLines, visibleScreens);
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
  record.terminal.resize(cols, rows);
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
  record.terminal.dispose();
  return true;
}

export function stopAllPtyTargets(): void {
  for (const target of listPtyTargets()) {
    stopPtyTarget(target);
  }
}
