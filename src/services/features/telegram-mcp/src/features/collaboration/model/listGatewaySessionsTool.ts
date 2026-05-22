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
          "List all known consoles from the configured gateway. Use this before direct cross-console communication outside a single collab project, or when you need to discover a console id once. The result includes live connected consoles and project-registered consoles known to the gateway. The canonical gateway-facing session_id is the composite value client_uuid:local_session_id from this list. Reuse that exact session_id in later gateway-routed tools instead of reconstructing it, stripping it, or re-listing sessions when the current console id is already known. target_client_uuid and target_local_session_id are also returned for direct routing APIs that need them.",
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
