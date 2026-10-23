import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerTools } from "../src/services/features/telegram-mcp/src/shared/api/tool-registry/registry";

describe("tool registry", () => {
  it("declares TellyMCP OAuth scopes in every tool's compatibility metadata", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTools(server, [
      {
        register(mcpServer) {
          mcpServer.registerTool(
            "private_tool",
            { description: "Requires TellyMCP authorization." },
            async () => ({ content: [{ type: "text", text: "ok" }] }),
          );
        },
      },
    ]);
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.listTools();
    await Promise.all([server.close(), client.close()]);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?._meta).toMatchObject({
      securitySchemes: [
        { type: "oauth2", scopes: ["tellymcp:read", "tellymcp:write"] },
      ],
    });
  });
});
