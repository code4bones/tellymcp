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
  proxyUrl?: string;
  proxyToken?: string;
  socketPath?: string;
};

export type AllowedTmuxAction =
  | "up"
  | "down"
  | "enter"
  | "slash"
  | "delete";

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

async function proxyJsonRequest<T>(
  config: TmuxRuntimeConfig,
  path: string,
  payload: unknown,
): Promise<T> {
  if (!config.proxyUrl) {
    throw new Error("TMUX proxy URL is not configured.");
  }

  const url = new URL(path, config.proxyUrl.endsWith("/") ? config.proxyUrl : `${config.proxyUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.proxyToken
        ? { authorization: `Bearer ${config.proxyToken}` }
        : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `TMUX proxy request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function ensureXchangeDir(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
): Promise<string> {
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ dir: string }>(
      config,
      "/xchange/ensure",
      {
        workspaceDir,
        exchangeDirName,
      },
    );
    return response.dir;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ path: string }>(
      config,
      "/xchange/write",
      {
        workspaceDir,
        exchangeDirName,
        fileName,
        contentBase64: Buffer.from(content).toString("base64"),
      },
    );
    return response.path;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ path: string }>(
      config,
      "/xchange/write-relative",
      {
        workspaceDir,
        exchangeDirName,
        relativePath,
        contentBase64: Buffer.from(content).toString("base64"),
        append: options?.append === true,
      },
    );
    return response.path;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ files: string[] }>(
      config,
      "/xchange/list",
      {
        workspaceDir,
        exchangeDirName,
      },
    );
    return response.files;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ deleted: boolean }>(
      config,
      "/xchange/delete",
      {
        workspaceDir,
        exchangeDirName,
        filePath,
      },
    );
    return response.deleted;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ contentBase64: string }>(
      config,
      "/workspace/read",
      {
        workspaceDir,
        filePath,
      },
    );
    return Buffer.from(response.contentBase64, "base64");
  }

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

export async function getTmuxWindowHeight(
  config: TmuxRuntimeConfig,
  target: string,
): Promise<number | null> {
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ height: number | null }>(
      config,
      "/window-height",
      {
        target,
        ...(config.socketPath ? { socketPath: config.socketPath } : {}),
      },
    );
    return typeof response.height === "number" ? response.height : null;
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ content: string }>(
      config,
      "/capture-range",
      {
        target,
        start,
        includeEscapes,
        ...(config.socketPath ? { socketPath: config.socketPath } : {}),
      },
    );
    return response.content.replaceAll("\u0000", "");
  }

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
  if (config.proxyUrl) {
    const response = await proxyJsonRequest<{ content: string }>(
      config,
      "/capture-visible",
      {
        target,
        fallbackLines,
        visibleScreens,
        ...(config.socketPath ? { socketPath: config.socketPath } : {}),
      },
    );
    return response.content.replaceAll("\u0000", "");
  }

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
  if (config.proxyUrl) {
    await proxyJsonRequest<{ ok: true }>(config, "/send-action", {
      target,
      action,
      ...(config.socketPath ? { socketPath: config.socketPath } : {}),
    });
    return;
  }

  const key =
    action === "up"
      ? "Up"
      : action === "down"
        ? "Down"
        : action === "slash"
          ? "/"
          : action === "delete"
            ? "BSpace"
            : "Enter";
  await execFileAsync("tmux", buildTmuxArgs(config, ["send-keys", "-t", target, key]));
}

export async function sendTmuxLiteralLine(
  config: TmuxRuntimeConfig,
  target: string,
  text: string,
): Promise<void> {
  const normalized = text.replace(/\r?\n/g, " ").trim();

  if (config.proxyUrl) {
    await proxyJsonRequest<{ ok: true }>(config, "/send-line", {
      target,
      text: normalized,
      ...(config.socketPath ? { socketPath: config.socketPath } : {}),
    });
    return;
  }

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

    await delay(ENTER_AFTER_PASTE_DELAY_MS);
  }
  await execFileAsync(
    "tmux",
    buildTmuxArgs(config, ["send-keys", "-t", target, SUBMIT_LINE_KEY]),
  );
}
