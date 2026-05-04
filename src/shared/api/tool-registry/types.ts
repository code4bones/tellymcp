import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolModule {
  register(server: McpServer): void;
}
