import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  deleteTelegramInboxMessageInputSchema,
  deleteTelegramInboxMessageOutputSchema,
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

export class DeleteTelegramInboxMessageTool implements ToolModule {
  public constructor(private readonly inboxService: InboxService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "delete_telegram_inbox_message",
      {
        title: "Delete Telegram Inbox Message",
        description:
          "Delete a processed Telegram inbox message so future polling does not return it again.",
        inputSchema: deleteTelegramInboxMessageInputSchema,
        outputSchema: deleteTelegramInboxMessageOutputSchema,
      },
      async (args) => {
        const output = await this.inboxService.deleteInboxMessage(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
