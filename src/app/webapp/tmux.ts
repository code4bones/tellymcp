import { execFile } from "node:child_process";

export type AllowedTmuxAction = "up" | "down" | "enter" | "slash" | "delete";

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

export function isTmuxUnavailableError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    message.includes("error connecting to /tmp/tmux-") ||
    message.includes("No such file or directory") ||
    message.includes("ENOENT")
  );
}

export async function captureVisibleTmuxPane(
  target: string,
  fallbackLines: number,
  visibleScreens: number,
): Promise<string> {
  const { stdout: heightRaw } = await execFileOutputAsync("tmux", [
    "display-message",
    "-p",
    "-t",
    target,
    "#{window_height}",
  ]);
  const height = Number.parseInt(heightRaw.trim(), 10);
  const baseLines =
    Number.isFinite(height) && height > 0 ? height : Math.max(1, fallbackLines);
  const lines = Math.max(1, baseLines * Math.max(1, visibleScreens));

  let stdout = "";

  try {
    ({ stdout } = await execFileOutputAsync("tmux", [
      "capture-pane",
      "-p",
      "-e",
      "-a",
      "-t",
      target,
      "-S",
      `-${lines}`,
    ]));
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (!message.includes("no alternate screen")) {
      throw error;
    }

    ({ stdout } = await execFileOutputAsync("tmux", [
      "capture-pane",
      "-p",
      "-e",
      "-t",
      target,
      "-S",
      `-${lines}`,
    ]));
  }

  return stdout.replace(/\u0000/g, "");
}

export async function sendAllowedTmuxAction(
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
          : "Enter";
  await execFileAsync("tmux", ["send-keys", "-t", target, key]);
}
