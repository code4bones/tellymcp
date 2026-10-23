import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolModule } from "./types";

// `_meta.securitySchemes` is the MCP compatibility mirror used by ChatGPT
// while the SDK catches up with the top-level `securitySchemes` field. Every
// TellyMCP tool requires the same OAuth scopes; the HTTP layer still verifies
// the bearer token and scopes on every request.
const oauthSecuritySchemes = [
  {
    type: "oauth2",
    scopes: ["tellymcp:read", "tellymcp:write"],
  },
] as const;

export function registerTools(server: McpServer, tools: ToolModule[]): void {
  const oauthAwareServer = new Proxy(server, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (
          name: string,
          config: Record<string, unknown>,
          callback: unknown,
        ) =>
          target.registerTool(
            name,
            {
              ...config,
              _meta: {
                ...(config._meta as Record<string, unknown> | undefined),
                securitySchemes: oauthSecuritySchemes,
              },
            },
            callback as never,
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;

  for (const tool of tools) {
    tool.register(oauthAwareServer);
  }
}
