import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  inboxBindRouteInputSchema,
  inboxBindRouteOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { ExternalInboxToolService } from "./externalInboxToolService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class InboxBindRouteTool implements ToolModule {
  public constructor(private readonly inboxService: ExternalInboxToolService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "inbox_bind_route",
      {
        title: "Inbox Bind Route",
        description:
          "Map an external route (namespace, route_key) and a telegram_user_id to that user's preferred live console (session_id, a canonical client_uuid:local_session_id — relay links are rejected), so one inbox route never wakes more than one console at a time.",
        inputSchema: inboxBindRouteInputSchema,
        outputSchema: inboxBindRouteOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.bindRoute(args);
        return { content: createContent(output), structuredContent: output };
      },
    );
  }
}
