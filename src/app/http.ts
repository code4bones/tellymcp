import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createAppRuntime } from "./bootstrap/runtime.js";

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const method = Reflect.get(body, "method");
  return method === "initialize";
}

function readHeader(
  req: IncomingMessage,
  headerName: string,
): string | undefined {
  const value = req.headers[headerName];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
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
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as unknown;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

function isAuthorized(
  req: IncomingMessage,
  expectedBearerToken?: string,
): boolean {
  if (!expectedBearerToken) {
    return true;
  }

  const header = readHeader(req, "authorization");
  return header === `Bearer ${expectedBearerToken}`;
}

async function main(): Promise<void> {
  const runtime = await createAppRuntime();
  const transports = new Map<string, SessionEntry>();

  const closeSessionEntry = async (entry: SessionEntry): Promise<void> => {
    await entry.transport.close();
    await entry.server.close();
  };

  const nodeServer = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${runtime.config.mcp.httpHost}:${runtime.config.mcp.httpPort}`,
    );

    if (requestUrl.pathname === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        service: "telegram-human-mcp",
        transport: "streamable-http",
      });
      return;
    }

    if (requestUrl.pathname !== runtime.config.mcp.httpPath) {
      writeText(res, 404, "Not found");
      return;
    }

    if (!isAuthorized(req, runtime.config.mcp.bearerToken)) {
      runtime.logger.warn("Unauthorized MCP HTTP request rejected", {
        method,
        path: requestUrl.pathname,
        remoteAddress: req.socket.remoteAddress,
      });
      writeText(res, 401, "Unauthorized");
      return;
    }

    const sessionId = readHeader(req, "mcp-session-id");
    const parsedBody =
      method === "POST" || method === "DELETE"
        ? await readJsonBody(req)
        : undefined;

    runtime.logger.debug("MCP HTTP request received", {
      method,
      path: requestUrl.pathname,
      sessionId,
      hasBody: parsedBody !== undefined,
    });

    try {
      if (method === "POST") {
        if (sessionId) {
          const entry = transports.get(sessionId);
          if (!entry) {
            writeJson(res, 404, {
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: "Unknown MCP session",
              },
              id: null,
            });
            return;
          }

          await entry.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Initialization request is required for a new session",
            },
            id: null,
          });
          return;
        }

        const entryRef: { current: SessionEntry | null } = { current: null };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            if (entryRef.current) {
              transports.set(createdSessionId, entryRef.current);
              runtime.logger.info("MCP HTTP session initialized", {
                sessionId: createdSessionId,
              });
            }
          },
        });
        const server = runtime.createServer();
        entryRef.current = { server, transport };
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            runtime.logger.info("MCP HTTP session closed", {
              sessionId: closedSessionId,
            });
          }
          void server.close();
        };
        transport.onerror = (error) => {
          runtime.logger.error("MCP HTTP transport error", {
            sessionId: transport.sessionId,
            error: error.stack ?? error.message,
          });
        };

        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (method === "GET" || method === "DELETE") {
        if (!sessionId) {
          writeText(res, 400, "Missing MCP session ID");
          return;
        }

        const entry = transports.get(sessionId);
        if (!entry) {
          writeText(res, 404, "Unknown MCP session");
          return;
        }

        await entry.transport.handleRequest(req, res, parsedBody);
        return;
      }

      writeText(res, 405, "Method not allowed");
    } catch (error) {
      runtime.logger.error("Error handling MCP HTTP request", {
        method,
        path: requestUrl.pathname,
        sessionId,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });

      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  nodeServer.listen(runtime.config.mcp.httpPort, runtime.config.mcp.httpHost);
  runtime.logger.info("MCP HTTP server listening", {
    host: runtime.config.mcp.httpHost,
    port: runtime.config.mcp.httpPort,
    path: runtime.config.mcp.httpPath,
    healthz: `http://${runtime.config.mcp.httpHost}:${runtime.config.mcp.httpPort}/healthz`,
    url: `http://${runtime.config.mcp.httpHost}:${runtime.config.mcp.httpPort}${runtime.config.mcp.httpPath}`,
    bearerAuthEnabled: Boolean(runtime.config.mcp.bearerToken),
  });

  const shutdown = async (): Promise<void> => {
    runtime.logger.info("HTTP service shutdown requested");
    nodeServer.close();
    await Promise.all(
      Array.from(transports.values()).map((entry) => closeSessionEntry(entry)),
    );
    transports.clear();
    await runtime.shutdown();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Startup failed: ${message}\n`);
  process.exit(1);
});
