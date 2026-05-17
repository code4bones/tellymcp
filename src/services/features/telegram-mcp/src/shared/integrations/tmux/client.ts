import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type TmuxRuntimeConfig = {
  socketPath?: string;
};

export type AllowedTmuxAction =
  | "up"
  | "down"
  | "enter"
  | "slash"
  | "delete"
  | "tab"
  | "escape"
  | "interrupt";

export type TmuxTargetHint = {
  tmuxSessionName?: string | undefined;
  tmuxWindowName?: string | undefined;
  tmuxWindowIndex?: number | undefined;
  tmuxPaneId?: string | undefined;
  tmuxPaneIndex?: number | undefined;
  tmuxTarget?: string | undefined;
};

const ENTER_AFTER_PASTE_DELAY_MS = 75;
const SUBMIT_LINE_KEY = "C-m";

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
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
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

function resolvePathInsideWorkspace(workspaceDir: string, filePath: string): string {
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
      attempt === 0
        ? safeFileName
        : `${baseName}--${attempt}${extension}`;
    const candidatePath = path.join(dir, candidateName);

    try {
      await access(candidatePath);
    } catch {
      return candidatePath;
    }
  }

  throw new Error("Could not allocate a unique file name in exchange directory.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function execFileOutputAsync(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function buildTmuxArgs(
  config: TmuxRuntimeConfig,
  args: string[],
  socketPath?: string,
): string[] {
  const resolvedSocketPath = socketPath ?? config.socketPath;
  return resolvedSocketPath ? ["-S", resolvedSocketPath, ...args] : args;
}

type TmuxPaneRecord = {
  sessionName: string;
  windowName: string;
  windowIndex: number;
  paneId: string;
  paneIndex: number;
};

export async function ensureXchangeDir(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
): Promise<string> {
  const resolvedDir = path.resolve(workspaceDir, exchangeDirName);
  await mkdir(resolvedDir, { recursive: true });
  return resolvedDir;
}

export async function writeXchangeFile(
  config: TmuxRuntimeConfig,
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
  config: TmuxRuntimeConfig,
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
  config: TmuxRuntimeConfig,
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
  config: TmuxRuntimeConfig,
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
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  filePath: string,
): Promise<Uint8Array> {
  const resolvedFilePath = resolvePathInsideWorkspace(workspaceDir, filePath);
  return readFile(resolvedFilePath);
}

export function isTmuxUnavailableError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    message.includes("error connecting to /tmp/tmux-") ||
    message.includes("No such file or directory") ||
    message.includes("ENOENT") ||
    message.includes("tmux is unavailable")
  );
}

export function isTmuxTargetInvalidError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    message.includes("can't find pane") ||
    message.includes("can't find window") ||
    message.includes("can't find session")
  );
}

async function listTmuxPanes(
  config: TmuxRuntimeConfig,
): Promise<TmuxPaneRecord[]> {
  const { stdout } = await execFileOutputAsync(
    "tmux",
    buildTmuxArgs(config, [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_name}\t#{window_index}\t#{pane_id}\t#{pane_index}",
    ]),
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sessionName = "", windowName = "", windowIndexRaw = "", paneId = "", paneIndexRaw = ""] =
        line.split("\t");
      return {
        sessionName,
        windowName,
        windowIndex: Number.parseInt(windowIndexRaw, 10),
        paneId,
        paneIndex: Number.parseInt(paneIndexRaw, 10),
      };
    })
    .filter(
      (pane) =>
        pane.sessionName &&
        pane.paneId &&
        Number.isFinite(pane.windowIndex) &&
        Number.isFinite(pane.paneIndex),
    );
}

export async function resolveTmuxTargetFromHint(
  config: TmuxRuntimeConfig,
  hint: TmuxTargetHint,
): Promise<string | null> {
  const panes = await listTmuxPanes(config);

  const byPaneId = hint.tmuxPaneId
    ? panes.find((pane) => pane.paneId === hint.tmuxPaneId)
    : null;
  if (byPaneId) {
    return byPaneId.paneId;
  }

  const exactMatch = panes.find((pane) => {
    if (!hint.tmuxSessionName) {
      return false;
    }

    if (pane.sessionName !== hint.tmuxSessionName) {
      return false;
    }

    if (
      typeof hint.tmuxWindowIndex === "number" &&
      pane.windowIndex !== hint.tmuxWindowIndex
    ) {
      return false;
    }

    if (
      typeof hint.tmuxPaneIndex === "number" &&
      pane.paneIndex !== hint.tmuxPaneIndex
    ) {
      return false;
    }

    if (
      hint.tmuxWindowName &&
      pane.windowName !== hint.tmuxWindowName
    ) {
      return false;
    }

    return true;
  });
  if (exactMatch) {
    return exactMatch.paneId;
  }

  const fallbackBySessionAndPane = panes.find((pane) => {
    if (!hint.tmuxSessionName || typeof hint.tmuxPaneIndex !== "number") {
      return false;
    }

    return (
      pane.sessionName === hint.tmuxSessionName &&
      pane.paneIndex === hint.tmuxPaneIndex
    );
  });

  return fallbackBySessionAndPane?.paneId ?? null;
}

export async function getTmuxWindowHeight(
  config: TmuxRuntimeConfig,
  target: string,
): Promise<number | null> {
  const { stdout: heightRaw } = await execFileOutputAsync(
    "tmux",
    buildTmuxArgs(config, ["display-message", "-p", "-t", target, "#{window_height}"]),
  );
  const height = Number.parseInt(heightRaw.trim(), 10);
  return Number.isFinite(height) && height > 0 ? height : null;
}

export async function captureTmuxPaneRange(
  config: TmuxRuntimeConfig,
  target: string,
  start: string,
  includeEscapes: boolean,
): Promise<string> {
  const args = [
    "capture-pane",
    "-p",
    ...(includeEscapes ? ["-e"] : []),
    "-t",
    target,
    "-S",
    start,
  ];
  const { stdout } = await execFileOutputAsync("tmux", buildTmuxArgs(config, args));
  return stdout.replaceAll("\u0000", "");
}

export async function captureVisibleTmuxPane(
  config: TmuxRuntimeConfig,
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  const height = await getTmuxWindowHeight(config, target);
  const baseLines =
    typeof height === "number" && height > 0 ? height : Math.max(1, fallbackLines);
  const lines = Math.max(1, baseLines * Math.max(1, visibleScreens));

  let stdout = "";

  try {
    ({ stdout } = await execFileOutputAsync(
      "tmux",
      buildTmuxArgs(config, [
        "capture-pane",
        "-p",
        "-e",
        "-a",
        "-t",
        target,
        "-S",
        `-${lines}`,
      ]),
    ));
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (!message.includes("no alternate screen")) {
      throw error;
    }

    ({ stdout } = await execFileOutputAsync(
      "tmux",
      buildTmuxArgs(config, [
        "capture-pane",
        "-p",
        "-e",
        "-t",
        target,
        "-S",
        `-${lines}`,
      ]),
    ));
  }

  return stdout.replaceAll("\u0000", "");
}

export async function sendAllowedTmuxAction(
  config: TmuxRuntimeConfig,
  target: string,
  action: AllowedTmuxAction,
): Promise<void> {
  const key =
    action === "up"
      ? "Up"
      : action === "down"
        ? "Down"
        : action === "slash"
          ? "/"
          : action === "delete"
            ? "BSpace"
            : action === "tab"
              ? "Tab"
              : action === "escape"
                ? "Escape"
                : action === "interrupt"
                  ? "C-c"
                  : "Enter";
  await execFileAsync("tmux", buildTmuxArgs(config, ["send-keys", "-t", target, key]));
}

export async function sendTmuxLiteralText(
  config: TmuxRuntimeConfig,
  target: string,
  text: string,
): Promise<void> {
  const normalized = text.replace(/\r?\n/g, " ");

  const bufferName = `telegram-mcp-${Date.now().toString(36)}`;
  if (normalized.length > 0) {
    try {
      await execFileAsync(
        "tmux",
        buildTmuxArgs(config, ["set-buffer", "-b", bufferName, normalized]),
      );
      await execFileAsync(
        "tmux",
        buildTmuxArgs(config, [
          "paste-buffer",
          "-d",
          "-b",
          bufferName,
          "-t",
          target,
        ]),
      );
    } finally {
      await execFileAsync(
        "tmux",
        buildTmuxArgs(config, ["delete-buffer", "-b", bufferName]),
      ).catch(() => undefined);
    }
  }
}

export async function sendTmuxLiteralLine(
  config: TmuxRuntimeConfig,
  target: string,
  text: string,
): Promise<void> {
  await sendTmuxLiteralText(config, target, text);
  if (text.length > 0) {
    await delay(ENTER_AFTER_PASTE_DELAY_MS);
  }
  await execFileAsync(
    "tmux",
    buildTmuxArgs(config, ["send-keys", "-t", target, SUBMIT_LINE_KEY]),
  );
}
