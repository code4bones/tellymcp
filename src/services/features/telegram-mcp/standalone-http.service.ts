import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_HTTP_SERVICE_NAME,
  type TelegramMcpHttpServiceInstance,
} from "./mcp-http.service";
import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";

export const TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME = "telegramMcp.standaloneHttp";

type StandaloneHttpCarrier = Service & {
  httpServer?: Server | null;
};

function resolveStandaloneBind(runtime: TelegramMcpRuntimeServiceInstance["getRuntime"] extends () => infer TRuntime ? TRuntime : never): {
  host: string;
  port: number;
  publicRootPrefix: string;
} {
  const mode = runtime.config.distributed.mode;
  const publicRootPrefix = process.env.ROOT_PREFIX || "/api";

  if (mode === "gateway" || mode === "both") {
    const port = Number(process.env.PORT ?? runtime.config.mcp.httpPort);
    return {
      host: runtime.config.mcp.httpHost,
      port,
      publicRootPrefix,
    };
  }

  return {
    host: runtime.config.mcp.httpHost,
    port: runtime.config.mcp.httpPort,
    publicRootPrefix: "/",
  };
}

const TelegramMcpStandaloneHttpService: ServiceSchema = {
  name: TELEGRAM_MCP_STANDALONE_HTTP_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    TELEGRAM_MCP_HTTP_SERVICE_NAME,
  ],

  created(this: StandaloneHttpCarrier) {
    this.httpServer = null;
  },

  async started(this: StandaloneHttpCarrier) {
    if (process.env.TELLYMCP_STANDALONE_HTTP === "false") {
      return;
    }

    await this.broker.waitForServices([
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
      TELEGRAM_MCP_HTTP_SERVICE_NAME,
    ]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;
    const httpService = this.broker.getLocalService(
      TELEGRAM_MCP_HTTP_SERVICE_NAME,
    ) as TelegramMcpHttpServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }
    if (!httpService?.routeRequest) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_HTTP_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = await runtimeService.waitUntilReady();
    const { host, port, publicRootPrefix } = resolveStandaloneBind(runtime);

    this.httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const requestUrl = new URL(req.url ?? "/", "http://standalone.local");
          await httpService.routeRequest?.(req, res, requestUrl.pathname);
        } catch (error) {
          this.logger.error("Standalone HTTP request failed", {
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });

          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
          }

          if (!res.writableEnded) {
            res.end("Internal Server Error");
          }
        }
      },
    );

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer;
      if (!server) {
        reject(new Error("Standalone HTTP server was not created"));
        return;
      }

      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.logger.info("telegram_mcp standalone HTTP server is ready", {
      host,
      port,
      mode: runtime.config.distributed.mode,
      rootPrefix: publicRootPrefix,
      mcpPath:
        publicRootPrefix === "/"
          ? runtime.config.mcp.httpPath
          : `${publicRootPrefix}${runtime.config.mcp.httpPath}`,
      webappBasePath:
        publicRootPrefix === "/"
          ? runtime.config.webapp.basePath
          : `${publicRootPrefix}${runtime.config.webapp.basePath}`,
      gatewayPath:
        publicRootPrefix === "/" ? "/gateway" : `${publicRootPrefix}/gateway`,
    });
  },

  async stopped(this: StandaloneHttpCarrier) {
    const server = this.httpServer;
    this.httpServer = null;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  },
};

export default TelegramMcpStandaloneHttpService;
