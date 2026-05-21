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
          "Compatibility cleanup for a human Telegram message after it has been fully processed. Under the hood this marks the corresponding telegram_message record as no longer unread for inbox-style reads. Pass session_id explicitly for the console session; do not rely on implicit defaults unless cwd is also correct for this agent workspace.",
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
