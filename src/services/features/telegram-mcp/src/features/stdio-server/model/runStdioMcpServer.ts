import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
  type TelegramMcpMcpServerServiceInstance,
} from "../../../../mcp-server.service";
import { createEmbeddedRuntimeBroker } from "../../embedded-runtime/model/embeddedRuntimeBroker";

type RunStdioMcpServerInput = {
  envPath: string;
  packageRoot: string;
};

export async function runStdioMcpServer(
  input: RunStdioMcpServerInput,
): Promise<void> {
  process.env.LOG_LEVEL = "silent";
  process.env.ENABLE_LOGFEED = "0";
  process.env.TELLYMCP_STANDALONE_HTTP = "false";

  const handle = await createEmbeddedRuntimeBroker({
    envPath: input.envPath,
    packageRoot: input.packageRoot,
    standaloneHttp: false,
  });
  const mcpServerService = handle.broker.getLocalService(
    TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
  ) as TelegramMcpMcpServerServiceInstance | null;

  if (!mcpServerService?.createServer) {
    await handle.broker.stop().catch(() => undefined);
    throw new Error("telegram_mcp MCP stdio service is unavailable");
  }

  const server = mcpServerService.createServer();
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.close().catch(() => undefined);
    await handle.broker.stop().catch(() => undefined);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(143);
  });
  process.stdin.on("close", () => {
    void shutdown(0);
  });
  process.stdin.on("end", () => {
    void shutdown(0);
  });

  await server.connect(transport);
  await new Promise<void>(() => undefined);
}
