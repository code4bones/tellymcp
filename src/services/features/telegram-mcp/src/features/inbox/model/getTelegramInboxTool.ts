import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTelegramInboxInputSchema,
  getTelegramInboxOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { InboxService } from "./inboxService";

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
          "Compatibility view for unread human Telegram messages for the console session. These items are now stored as structured telegram_message records in .mcp-xchange. Prefer list_xchange_records and then get_xchange_record when you need full routing metadata, action_desc, attachments, and reply instructions. Pass session_id explicitly; do not rely on implicit defaults unless cwd is also correct for this agent workspace.",
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
