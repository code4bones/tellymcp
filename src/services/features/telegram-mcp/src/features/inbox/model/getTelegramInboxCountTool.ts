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
          "Use this to cheaply check whether ordinary human Telegram messages are waiting for the session. Pass session_id explicitly after pairing; do not rely on implicit defaults unless cwd is also correct for this agent workspace. Do not use it for partner-note or local handoff wakeups; use list_xchange_records instead.",
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
