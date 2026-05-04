import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createAppRuntime } from "./bootstrap/runtime.js";

async function main(): Promise<void> {
  const runtime = await createAppRuntime();
  const mcpServer = runtime.createServer();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  runtime.logger.info("MCP stdio server connected and ready");

  const shutdown = async (): Promise<void> => {
    runtime.logger.info("STDIO service shutdown requested");
    await mcpServer.close();
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
