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
          "Use this to read unsolicited Telegram inbox messages stored for the console session. Pass session_id explicitly; do not rely on implicit defaults unless cwd is also correct for this agent workspace. Each item now includes message_kind: human or system. Treat system messages as operational instructions from the service, not as normal user prompts. Returned items may also include local attachment paths from .mcp-xchange when the human message contained a photo or document. Do not use this first for partner-note wakeups; for collaboration and local handoff wakeups, use list_xchange_records and then get_xchange_record.",
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
