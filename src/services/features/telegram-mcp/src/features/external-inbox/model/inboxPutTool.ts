import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  inboxPutInputSchema,
  inboxPutOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { ExternalInboxToolService } from "./externalInboxToolService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class InboxPutTool implements ToolModule {
  public constructor(private readonly inboxService: ExternalInboxToolService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "inbox_put",
      {
        title: "Inbox Put",
        description:
          "Durably place a generic work-offer message for a TellyMCP-bound recipient, deduplicated by (source.integration, source.messageId). Include a display.title/summary snapshot — TellyMCP does not call back into the source integration to hydrate one. Requires the dedicated inbox integration credential.",
        inputSchema: inboxPutInputSchema,
        outputSchema: inboxPutOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.put(args);
        return { content: createContent(output), structuredContent: output };
      },
    );
  }
}
