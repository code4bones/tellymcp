import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTelegramInboxCountInputSchema,
  getTelegramInboxCountOutputSchema,
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

export class GetTelegramInboxCountTool implements ToolModule {
  public constructor(private readonly inboxService: InboxService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_telegram_inbox_count",
      {
        title: "Get Telegram Inbox Count",
        description:
          "Return only the number of pending Telegram inbox messages for a session.",
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
