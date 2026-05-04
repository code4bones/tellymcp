import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  captureTmuxPaneRange,
  captureVisibleTmuxPane,
  getTmuxWindowHeight,
  isTmuxUnavailableError,
  sendAllowedTmuxAction,
  sendTmuxLiteralLine,
  type AllowedTmuxAction,
  type TmuxRuntimeConfig,
} from "../shared/integrations/tmux/client.js";

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

void main();
