import { execFile } from "node:child_process";

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
    return response.content.replace(/\u0000/g, "");
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
  return stdout.replace(/\u0000/g, "");
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
    return response.content.replace(/\u0000/g, "");
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

  return stdout.replace(/\u0000/g, "");
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
