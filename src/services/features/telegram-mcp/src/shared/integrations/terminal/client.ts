import {
  access,
  appendFile,
  mkdir,
  realpath,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertBodySize, MAX_BODY_SIZE_BYTES } from "../../lib/bodyLimits";

import {
  buildPtyTarget,
  capturePtyRange,
  captureVisiblePty,
  renderVisiblePtyHtml,
  renderVisiblePtyAnsi,
  ensurePtySession,
  getPtyShellDisplayName,
  getPtyWindowHeight,
  getPtyWindowSize,
  hasPtyTarget,
  isPtyTarget,
  type PtyExitInfo,
  resizePtyTarget,
  sendPtyAction,
  sendPtyText,
  stopAllPtyTargets,
  subscribePtyTarget,
} from "../terminal/ptyRegistry";

export type TerminalRuntimeConfig = {
  shell?: string;
  cols?: number;
  rows?: number;
  scrollbackLines?: number;
};

export type AllowedTerminalAction =
  | "up"
  | "down"
  | "enter"
  | "slash"
  | "delete"
  | "tab"
  | "escape"
  | "interrupt";

export type TerminalExitInfo = PtyExitInfo;

export type TerminalTargetHint = {
  terminalTarget?: string | undefined;
};

const ENTER_AFTER_PASTE_DELAY_MS = 75;

function toPtyConfig(config: TerminalRuntimeConfig) {
  return {
    shell: config.shell?.trim() || process.env.SHELL || "bash",
    cols: config.cols ?? 120,
    rows: config.rows ?? 40,
    scrollbackLines: config.scrollbackLines ?? 4000,
  };
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName).trim();
  const withoutControlChars = Array.from(baseName)
    .map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
    .join("");
  const normalized = withoutControlChars
    .replace(/[/\\]/g, "-")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || "file.bin";
}

function sanitizeRelativeXchangePath(relativePath: string): string {
  const normalized = relativePath
    .split(/[/\\]+/u)
    .map((segment) => segment.trim())
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
    .join("/");

  if (!normalized) {
    throw new Error("Relative exchange path is required.");
  }

  return normalized;
}

function resolvePathInsideRoot(rootDir: string, relativePath: string): string {
  const safeRelativePath = sanitizeRelativeXchangePath(relativePath);
  const resolvedPath = path.resolve(rootDir, safeRelativePath);
  const relative = path.relative(rootDir, resolvedPath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("Resolved path is outside the exchange directory.");
  }

  return resolvedPath;
}

function resolvePathInsideWorkspace(
  workspaceDir: string,
  filePath: string,
): string {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedWorkspaceDir, filePath);
  const relative = path.relative(resolvedWorkspaceDir, resolvedFilePath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("File path is outside the workspace directory.");
  }

  return resolvedFilePath;
}

async function allocateAvailableFilePath(
  dir: string,
  fileName: string,
): Promise<string> {
  const safeFileName = sanitizeFileName(fileName);
  const extension = path.extname(safeFileName);
  const baseName = path.basename(safeFileName, extension);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidateName =
      attempt === 0 ? safeFileName : `${baseName}--${attempt}${extension}`;
    const candidatePath = path.join(dir, candidateName);

    try {
      await access(candidatePath);
    } catch {
      return candidatePath;
    }
  }

  throw new Error(
    "Could not allocate a unique file name in exchange directory.",
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function ensureXchangeDir(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
): Promise<string> {
  const resolvedDir = path.resolve(workspaceDir, exchangeDirName);
  await mkdir(resolvedDir, { recursive: true });
  return resolvedDir;
}

export async function writeXchangeFile(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  fileName: string,
  content: Uint8Array,
): Promise<string> {
  const dir = await ensureXchangeDir(config, workspaceDir, exchangeDirName);
  const outputPath = await allocateAvailableFilePath(dir, fileName);
  await writeFile(outputPath, content);
  return outputPath;
}

export async function writeXchangeRelativeFile(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  relativePath: string,
  content: Uint8Array,
  options?: {
    append?: boolean;
  },
): Promise<string> {
  const dir = await ensureXchangeDir(config, workspaceDir, exchangeDirName);
  const outputPath = resolvePathInsideRoot(dir, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });

  if (options?.append) {
    await appendFile(outputPath, content);
  } else {
    await writeFile(outputPath, content);
  }

  return outputPath;
}

export async function listXchangeFiles(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
): Promise<string[]> {
  const dir = await ensureXchangeDir(config, workspaceDir, exchangeDirName);
  return listFilesRecursively(dir);
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((left, right) => right.localeCompare(left));
}

export async function deleteXchangeFile(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  filePath: string,
): Promise<boolean> {
  const dir = await ensureXchangeDir(config, workspaceDir, exchangeDirName);
  const resolvedFilePath = path.resolve(filePath);
  const relative = path.relative(dir, resolvedFilePath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("File path is outside the exchange directory.");
  }

  await rm(resolvedFilePath, { force: true });
  return true;
}

export async function readWorkspaceFile(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  filePath: string,
  maxBytes = MAX_BODY_SIZE_BYTES,
): Promise<Uint8Array> {
  const resolved = await resolveWorkspaceFileForRead(
    config,
    workspaceDir,
    filePath,
    maxBytes,
  );
  return readFile(resolved.filePath);
}

export async function resolveWorkspaceFileForRead(
  config: TerminalRuntimeConfig,
  workspaceDir: string,
  filePath: string,
  maxBytes = MAX_BODY_SIZE_BYTES,
): Promise<{ filePath: string; sizeBytes: number }> {
  void config;
  const resolvedFilePath = resolvePathInsideWorkspace(workspaceDir, filePath);
  const [realWorkspaceDir, realFilePath] = await Promise.all([
    realpath(path.resolve(workspaceDir)),
    realpath(resolvedFilePath),
  ]);
  const relative = path.relative(realWorkspaceDir, realFilePath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("File path is outside the workspace directory.");
  }

  const fileStats = await stat(realFilePath);
  if (!fileStats.isFile()) {
    throw new Error("File path does not point to a regular file.");
  }
  assertBodySize(fileStats.size, maxBytes);
  return {
    filePath: realFilePath,
    sizeBytes: fileStats.size,
  };
}

export function isTerminalUnavailableError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.includes("pty target is unavailable");
}

export function isTerminalTargetInvalidError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.includes("unknown pty target");
}

export function getConfiguredTerminalShell(
  config: TerminalRuntimeConfig,
): string {
  return toPtyConfig(config).shell;
}

export function getConfiguredTerminalShellDisplayName(
  config: TerminalRuntimeConfig,
): string {
  return getPtyShellDisplayName(toPtyConfig(config));
}

export function isStreamableTerminalTarget(target: string): boolean {
  return isPtyTarget(target);
}

export function ensureTerminalTargetForSession(
  config: TerminalRuntimeConfig,
  input: {
    sessionId: string;
    cwd?: string | undefined;
    target?: string | undefined;
  },
): string | null {
  return ensurePtySession(toPtyConfig(config), {
    sessionId: input.sessionId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(isPtyTarget(input.target) ? { target: input.target } : {}),
  });
}

export async function resolveTerminalTargetFromHint(
  config: TerminalRuntimeConfig,
  hint: TerminalTargetHint,
): Promise<string | null> {
  const target = hint.terminalTarget?.trim() || buildPtyTarget("default");
  return hasPtyTarget(target) ? target : (hint.terminalTarget?.trim() ?? null);
}

export async function getTerminalWindowHeight(
  config: TerminalRuntimeConfig,
  target: string,
): Promise<number | null> {
  return getPtyWindowHeight(target);
}

export async function getTerminalWindowSize(
  config: TerminalRuntimeConfig,
  target: string,
): Promise<{ cols: number; rows: number } | null> {
  return getPtyWindowSize(target);
}

export async function captureTerminalPaneRange(
  config: TerminalRuntimeConfig,
  target: string,
  start: string,
  includeEscapes: boolean,
): Promise<string> {
  void includeEscapes;
  return await capturePtyRange(target, start);
}

export async function captureVisibleTerminal(
  config: TerminalRuntimeConfig,
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  return await captureVisiblePty(target, fallbackLines, visibleScreens);
}

export async function captureVisibleTerminalHtml(
  config: TerminalRuntimeConfig,
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string | null> {
  return await renderVisiblePtyHtml(target, fallbackLines, visibleScreens);
}

export async function captureVisibleTerminalAnsi(
  config: TerminalRuntimeConfig,
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  return await renderVisiblePtyAnsi(target, fallbackLines, visibleScreens);
}

export async function sendAllowedTerminalAction(
  config: TerminalRuntimeConfig,
  target: string,
  action: AllowedTerminalAction,
): Promise<void> {
  void config;
  sendPtyAction(target, action);
}

export async function sendTerminalLiteralText(
  config: TerminalRuntimeConfig,
  target: string,
  text: string,
): Promise<void> {
  void config;
  const normalized = text.replace(/\r?\n/g, " ");
  if (normalized.length > 0) {
    sendPtyText(target, normalized);
  }
}

export async function sendTerminalLiteralLine(
  config: TerminalRuntimeConfig,
  target: string,
  text: string,
): Promise<void> {
  await sendTerminalLiteralText(config, target, text);
  if (text.replace(/\r?\n/g, " ").length > 0) {
    await delay(ENTER_AFTER_PASTE_DELAY_MS);
  }
  sendPtyAction(target, "enter");
}

export function resizeForegroundTerminal(
  target: string,
  cols: number,
  rows: number,
): void {
  resizePtyTarget(target, cols, rows);
}

export function sendForegroundTerminalInput(
  target: string,
  data: string,
): void {
  sendPtyText(target, data);
}

export function subscribeForegroundTerminal(
  target: string,
  input: {
    onData?: ((data: string) => void) | undefined;
    onExit?: ((info: TerminalExitInfo) => void) | undefined;
  },
): () => void {
  return subscribePtyTarget(target, input);
}

export function stopAllForegroundTerminals(): void {
  stopAllPtyTargets();
}
