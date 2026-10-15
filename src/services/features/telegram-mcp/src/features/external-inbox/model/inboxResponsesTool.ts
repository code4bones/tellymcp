import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  inboxResponsesInputSchema,
  inboxResponsesOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { ExternalInboxToolService } from "./externalInboxToolService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class InboxResponsesTool implements ToolModule {
  public constructor(private readonly inboxService: ExternalInboxToolService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "inbox_responses",
      {
        title: "Inbox Responses",
        description:
          "Cursor-based read of outcomes (pending/offered/accepted/rejected/no_live_session/delivered/failed) for inbox messages previously placed with inbox_put for one integration. Pass the next_cursor from the previous call as since to continue.",
        inputSchema: inboxResponsesInputSchema,
        outputSchema: inboxResponsesOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.responses(args);
        return { content: createContent(output), structuredContent: output };
      },
    );
  }
}
