import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
  captureTmuxPaneRange,
  captureVisibleTmuxPane,
  getTmuxWindowHeight,
  isTmuxUnavailableError,
  sendAllowedTmuxAction,
  sendTmuxLiteralLine,
  type AllowedTmuxAction,
  type TmuxRuntimeConfig,
} from "../shared/integrations/tmux/client";

function loadEnv(): void {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
}

function readHeader(req: IncomingMessage, headerName: string): string | undefined {
  const value = req.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function writeText(res: ServerResponse, statusCode: number, text: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function resolveSocketConfig(
  body: unknown,
  defaultSocketPath: string,
): TmuxRuntimeConfig {
  const socketPath =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "socketPath") === "string"
      ? String(Reflect.get(body, "socketPath")).trim()
      : "";

  return {
    ...(socketPath
      ? { socketPath }
      : defaultSocketPath
        ? { socketPath: defaultSocketPath }
        : {}),
  };
}

function readTarget(body: unknown): string {
  return body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "target") === "string"
    ? String(Reflect.get(body, "target")).trim()
    : "";
}

function isAllowedAction(value: string): value is AllowedTmuxAction {
  return ["up", "down", "enter", "slash", "delete"].includes(value);
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
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  if (!normalized) {
    throw new Error("relativePath is required");
  }

  return normalized;
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

async function ensureXchangeDirOnHost(
  body: unknown,
): Promise<{ dir: string } | null> {
  const workspaceDir =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "workspaceDir") === "string"
      ? String(Reflect.get(body, "workspaceDir")).trim()
      : "";
  const exchangeDirName =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "exchangeDirName") === "string"
      ? String(Reflect.get(body, "exchangeDirName")).trim()
      : "";

  if (!workspaceDir || !exchangeDirName) {
    return null;
  }

  const resolvedDir = path.resolve(workspaceDir, exchangeDirName);
  await mkdir(resolvedDir, { recursive: true });
  return { dir: resolvedDir };
}

function resolveXchangeDirFromBody(body: unknown): string | null {
  const workspaceDir =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "workspaceDir") === "string"
      ? String(Reflect.get(body, "workspaceDir")).trim()
      : "";
  const exchangeDirName =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "exchangeDirName") === "string"
      ? String(Reflect.get(body, "exchangeDirName")).trim()
      : "";

  if (!workspaceDir || !exchangeDirName) {
    return null;
  }

  return path.resolve(workspaceDir, exchangeDirName);
}

function resolveWorkspaceDirFromBody(body: unknown): string | null {
  const workspaceDir =
    body &&
    typeof body === "object" &&
    typeof Reflect.get(body, "workspaceDir") === "string"
      ? String(Reflect.get(body, "workspaceDir")).trim()
      : "";

  return workspaceDir ? path.resolve(workspaceDir) : null;
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
    throw new Error("filePath is outside the workspace directory");
  }

  return resolvedFilePath;
}

function resolvePathInsideXchange(
  exchangeDir: string,
  relativePath: string,
): string {
  const safeRelativePath = sanitizeRelativeXchangePath(relativePath);
  const resolvedPath = path.resolve(exchangeDir, safeRelativePath);
  const relative = path.relative(exchangeDir, resolvedPath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("relativePath is outside the exchange directory");
  }

  return resolvedPath;
}

async function main(): Promise<void> {
  loadEnv();

  const host = process.env.TMUX_PROXY_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.TMUX_PROXY_PORT || "8788", 10);
  const bearerToken = process.env.TMUX_PROXY_TOKEN?.trim() || "";
  const defaultSocketPath = process.env.TMUX_SOCKET_PATH?.trim() || "";

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/healthz") {
      writeJson(res, 200, { ok: true, service: "telegram-human-tmux-proxy" });
      return;
    }

    if (bearerToken) {
      const authorization = readHeader(req, "authorization");
      if (authorization !== `Bearer ${bearerToken}`) {
        writeText(res, 401, "Unauthorized");
        return;
      }
    }

    if (method !== "POST") {
      writeText(res, 405, "Method not allowed");
      return;
    }

    const body = await readJsonBody(req).catch(() => undefined);
    const config = resolveSocketConfig(body, defaultSocketPath);

    try {
      if (url.pathname === "/window-height") {
        const target = readTarget(body);
        if (!target) {
          writeText(res, 400, "target is required");
          return;
        }

        const height = await getTmuxWindowHeight(config, target);
        writeJson(res, 200, { height });
        return;
      }

      if (url.pathname === "/capture-visible") {
        const target = readTarget(body);
        const fallbackLines =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "fallbackLines") === "number"
            ? Number(Reflect.get(body, "fallbackLines"))
            : 300;
        const visibleScreens =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "visibleScreens") === "number"
            ? Number(Reflect.get(body, "visibleScreens"))
            : 2;

        if (!target) {
          writeText(res, 400, "target is required");
          return;
        }

        const content = await captureVisibleTmuxPane(
          config,
          target,
          fallbackLines,
          visibleScreens,
        );
        writeJson(res, 200, { content });
        return;
      }

      if (url.pathname === "/capture-range") {
        const target = readTarget(body);
        const start =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "start") === "string"
            ? String(Reflect.get(body, "start")).trim()
            : "";
        const includeEscapes =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "includeEscapes") === "boolean"
            ? Boolean(Reflect.get(body, "includeEscapes"))
            : false;

        if (!target || !start) {
          writeText(res, 400, "target and start are required");
          return;
        }

        const content = await captureTmuxPaneRange(
          config,
          target,
          start,
          includeEscapes,
        );
        writeJson(res, 200, { content });
        return;
      }

      if (url.pathname === "/send-action") {
        const target = readTarget(body);
        const action =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "action") === "string"
            ? String(Reflect.get(body, "action")).trim().toLowerCase()
            : "";

        if (!target || !isAllowedAction(action)) {
          writeText(res, 400, "target and valid action are required");
          return;
        }

        await sendAllowedTmuxAction(config, target, action);
        writeJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/send-line") {
        const target = readTarget(body);
        const text =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "text") === "string"
            ? String(Reflect.get(body, "text"))
            : "";

        if (!target) {
          writeText(res, 400, "target is required");
          return;
        }

        await sendTmuxLiteralLine(config, target, text);
        writeJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/xchange/ensure") {
        const ensured = await ensureXchangeDirOnHost(body);
        if (!ensured) {
          writeText(res, 400, "workspaceDir and exchangeDirName are required");
          return;
        }

        writeJson(res, 200, ensured);
        return;
      }

      if (url.pathname === "/xchange/write") {
        const workspaceDir =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "workspaceDir") === "string"
            ? String(Reflect.get(body, "workspaceDir")).trim()
            : "";
        const exchangeDirName =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "exchangeDirName") === "string"
            ? String(Reflect.get(body, "exchangeDirName")).trim()
            : "";
        const fileName =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "fileName") === "string"
            ? String(Reflect.get(body, "fileName")).trim()
            : "";
        const contentBase64 =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "contentBase64") === "string"
            ? String(Reflect.get(body, "contentBase64"))
            : "";

        if (!workspaceDir || !exchangeDirName || !fileName || !contentBase64) {
          writeText(
            res,
            400,
            "workspaceDir, exchangeDirName, fileName, and contentBase64 are required",
          );
          return;
        }

        const ensured = await ensureXchangeDirOnHost(body);
        if (!ensured) {
          writeText(res, 400, "workspaceDir and exchangeDirName are required");
          return;
        }

        const outputPath = await allocateAvailableFilePath(
          ensured.dir,
          fileName,
        );
        await writeFile(outputPath, Buffer.from(contentBase64, "base64"));
        writeJson(res, 200, { path: outputPath });
        return;
      }

      if (url.pathname === "/xchange/write-relative") {
        const resolvedDir = resolveXchangeDirFromBody(body);
        const relativePath =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "relativePath") === "string"
            ? String(Reflect.get(body, "relativePath")).trim()
            : "";
        const contentBase64 =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "contentBase64") === "string"
            ? String(Reflect.get(body, "contentBase64"))
            : "";
        const append =
          body &&
          typeof body === "object" &&
          Reflect.get(body, "append") === true;

        if (!resolvedDir || !relativePath || !contentBase64) {
          writeText(
            res,
            400,
            "workspaceDir, exchangeDirName, relativePath, and contentBase64 are required",
          );
          return;
        }

        await mkdir(resolvedDir, { recursive: true });
        const outputPath = resolvePathInsideXchange(resolvedDir, relativePath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        const content = Buffer.from(contentBase64, "base64");

        if (append) {
          await appendFile(outputPath, content);
        } else {
          await writeFile(outputPath, content);
        }

        writeJson(res, 200, { path: outputPath });
        return;
      }

      if (url.pathname === "/xchange/list") {
        const resolvedDir = resolveXchangeDirFromBody(body);
        if (!resolvedDir) {
          writeText(res, 400, "workspaceDir and exchangeDirName are required");
          return;
        }

        await mkdir(resolvedDir, { recursive: true });
        const files = await listFilesRecursively(resolvedDir);
        writeJson(res, 200, { files });
        return;
      }

      if (url.pathname === "/xchange/delete") {
        const resolvedDir = resolveXchangeDirFromBody(body);
        const filePath =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "filePath") === "string"
            ? String(Reflect.get(body, "filePath")).trim()
            : "";
        if (!resolvedDir || !filePath) {
          writeText(
            res,
            400,
            "workspaceDir, exchangeDirName, and filePath are required",
          );
          return;
        }

        const resolvedFilePath = path.resolve(filePath);
        const relative = path.relative(resolvedDir, resolvedFilePath);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          relative.trim() === ""
        ) {
          writeText(res, 400, "filePath is outside the exchange directory");
          return;
        }

        await rm(resolvedFilePath, { force: true });
        writeJson(res, 200, { deleted: true });
        return;
      }

      if (url.pathname === "/workspace/read") {
        const workspaceDir = resolveWorkspaceDirFromBody(body);
        const filePath =
          body &&
          typeof body === "object" &&
          typeof Reflect.get(body, "filePath") === "string"
            ? String(Reflect.get(body, "filePath")).trim()
            : "";

        if (!workspaceDir || !filePath) {
          writeText(res, 400, "workspaceDir and filePath are required");
          return;
        }

        const resolvedFilePath = resolvePathInsideWorkspace(workspaceDir, filePath);
        const content = await readFile(resolvedFilePath);
        writeJson(res, 200, {
          contentBase64: Buffer.from(content).toString("base64"),
        });
        return;
      }

      writeText(res, 404, "Not found");
    } catch (error) {
      writeText(
        res,
        isTmuxUnavailableError(error) ? 503 : 500,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        service: "telegram-human-tmux-proxy",
        host,
        port,
        socketPath: defaultSocketPath || null,
        bearerAuthEnabled: Boolean(bearerToken),
      }),
    );
  });
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

void main();
