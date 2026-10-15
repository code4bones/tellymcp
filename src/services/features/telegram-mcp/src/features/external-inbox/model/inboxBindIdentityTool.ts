import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  inboxBindIdentityInputSchema,
  inboxBindIdentityOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { ExternalInboxToolService } from "./externalInboxToolService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class InboxBindIdentityTool implements ToolModule {
  public constructor(private readonly inboxService: ExternalInboxToolService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "inbox_bind_identity",
      {
        title: "Inbox Bind Identity",
        description:
          "Map an opaque external principal (namespace, subject) to the TellyMCP user bound to a given telegram_user_id, so future inbox_put messages for that principal resolve to the right Telegram chat.",
        inputSchema: inboxBindIdentityInputSchema,
        outputSchema: inboxBindIdentityOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.bindIdentity(args);
        return { content: createContent(output), structuredContent: output };
      },
    );
  }
}
