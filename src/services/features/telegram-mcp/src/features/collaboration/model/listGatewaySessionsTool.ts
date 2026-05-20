import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listGatewaySessionsInputSchema,
  listGatewaySessionsOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { GatewaySessionsService } from "./gatewaySessionsService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class ListGatewaySessionsTool implements ToolModule {
  public constructor(
    private readonly gatewaySessionsService: GatewaySessionsService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "list_gateway_sessions",
      {
        title: "List Gateway Sessions",
        description:
          "List all known sessions from the configured gateway. Use this before direct cross-session communication outside a single collab project. The result includes connected sessions from gateway WS and registered project sessions from the gateway database. For direct messaging, use target_client_uuid and target_local_session_id from this list.",
        inputSchema: listGatewaySessionsInputSchema,
        outputSchema: listGatewaySessionsOutputSchema,
      },
      async (args) => {
        const output = await this.gatewaySessionsService.listKnownSessions(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
