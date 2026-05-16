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
          "Use this to read ordinary unsolicited human Telegram messages stored for the session. Returned items may also include local attachment paths from .mcp-xchange when the human message contained a photo or document. Do not use this first for partner-note wakeups; partner collaboration notes must be read from .mcp-xchange/SHARED_INDEX.md and the referenced note files.",
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
