import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTelegramInboxInputSchema,
  getTelegramInboxOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { InboxService } from "./inboxService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class GetTelegramInboxTool implements ToolModule {
  public constructor(private readonly inboxService: InboxService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_telegram_inbox",
      {
        title: "Get Telegram Inbox",
        description:
          "Read unsolicited Telegram messages that were stored in the inbox for a session. Returned items may also include local attachment paths from .mcp-xchange when the Telegram message contained a photo or document.",
        inputSchema: getTelegramInboxInputSchema,
        outputSchema: getTelegramInboxOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.getInbox(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
