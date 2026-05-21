import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTelegramInboxCountInputSchema,
  getTelegramInboxCountOutputSchema,
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

export class GetTelegramInboxCountTool implements ToolModule {
  public constructor(private readonly inboxService: InboxService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_telegram_inbox_count",
      {
        title: "Get Telegram Inbox Count",
        description:
          "Compatibility count for unread human Telegram messages for the console session. Human Telegram input is now stored as telegram_message records in .mcp-xchange. Prefer list_xchange_records when you are ready to inspect actual work items. Pass session_id explicitly; do not rely on implicit defaults unless cwd is also correct for this agent workspace.",
        inputSchema: getTelegramInboxCountInputSchema,
        outputSchema: getTelegramInboxCountOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.getInboxCount(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
