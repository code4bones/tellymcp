import type { Service, ServiceSchema } from "moleculer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
  type TelegramMcpMcpServerServiceInstance,
} from "./mcp-server.service";
import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME,
  type TelegramMcpGatewaySocketServiceInstance,
} from "./gateway-socket.service";
import {
  createMcpHttpHandler,
  type McpHttpHandler,
} from "./src/app/http";

export const TELEGRAM_MCP_HTTP_SERVICE_NAME = "telegramMcp.http";

type HttpServiceCarrier = Service & {
  httpHandler?: McpHttpHandler | null;
  routeRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => Promise<void>;
  routeUpgrade?: (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    pathname: string,
  ) => Promise<boolean>;
};

export type TelegramMcpHttpServiceInstance = HttpServiceCarrier;

const TelegramMcpHttpService: ServiceSchema = {
  name: TELEGRAM_MCP_HTTP_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
  ],

  created(this: HttpServiceCarrier) {
    this.httpHandler = null;
  },

  methods: {
    async routeRequest(
      this: HttpServiceCarrier,
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ): Promise<void> {
      if (!this.httpHandler) {
        throw new Error("telegram_mcp HTTP handler is not initialized yet");
      }

      this.logger.debug("telegram_mcp HTTP routeRequest received", {
        method: req.method,
        pathname,
      });

      await this.httpHandler.handleRequest(req, res, pathname);
    },
    async routeUpgrade(
      this: HttpServiceCarrier,
      req: IncomingMessage,
      socket: Socket,
      head: Buffer,
      pathname: string,
    ): Promise<boolean> {
      if (!this.httpHandler) {
        throw new Error("telegram_mcp HTTP handler is not initialized yet");
      }

      return await this.httpHandler.handleUpgrade(req, socket, head, pathname);
    },
  },

  actions: {
    async route(ctx) {
      const req = ctx.meta?.$request as IncomingMessage | undefined;
      const res = ctx.meta?.$response as ServerResponse | undefined;

      if (!req || !res) {
        throw new Error("Raw HTTP request/response are not available in context");
      }

      const request = req as IncomingMessage & { originalUrl?: string };
      const requestUrl = new URL(
        request.originalUrl ?? req.url ?? "/",
        "http://gateway.local",
      );

      await (this as HttpServiceCarrier).routeRequest?.(
        req,
        res,
        requestUrl.pathname,
      );

      return null;
    },
  },

  async started(this: HttpServiceCarrier) {
    await this.broker.waitForServices([
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
      TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
    ]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;
    const mcpServerService = this.broker.getLocalService(
      TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
    ) as TelegramMcpMcpServerServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }
    if (!mcpServerService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = await runtimeService.waitUntilReady();
    this.logger.info("Starting telegram_mcp HTTP service");
    this.httpHandler = createMcpHttpHandler(runtime, {
      createMcpServer: () => mcpServerService.createServer(),
      getGatewaySocketService: () =>
        this.broker.getLocalService(
          TELEGRAM_MCP_GATEWAY_SOCKET_SERVICE_NAME,
        ) as TelegramMcpGatewaySocketServiceInstance | null,
    });
    this.logger.info("telegram_mcp HTTP service is ready", {
      path: runtime.config.mcp.httpPath,
      webappBasePath: runtime.config.webapp.basePath,
      bearerAuthEnabled: Boolean(runtime.config.mcp.bearerToken),
    });
  },

  async stopped(this: HttpServiceCarrier) {
    if (!this.httpHandler) {
      return;
    }

    const handle = this.httpHandler;
    this.httpHandler = null;
    this.logger.info("Stopping telegram_mcp HTTP service");
    await handle.close();
  },
};

export default TelegramMcpHttpService;
