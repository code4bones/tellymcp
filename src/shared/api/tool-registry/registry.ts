import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolModule } from "./types.js";

export function registerTools(server: McpServer, tools: ToolModule[]): void {
  for (const tool of tools) {
    tool.register(server);
  }
}
