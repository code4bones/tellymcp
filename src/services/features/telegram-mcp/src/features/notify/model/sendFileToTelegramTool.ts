import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  sendFileToTelegramInputSchema,
  sendFileToTelegramOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { NotifyService } from "./notifyService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class SendFileToTelegramTool implements ToolModule {
  public constructor(private readonly notifyService: NotifyService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "send_file_to_telegram",
      {
        title: "Send File To Telegram",
        description:
          "Send an existing local workspace file to the human linked to the current console in Telegram. Use this when another console returned a real artifact or file and the final human-facing result must be delivered to Telegram. Pass session_id explicitly for gateway-routed consoles.",
        inputSchema: sendFileToTelegramInputSchema,
        outputSchema: sendFileToTelegramOutputSchema,
      },
      async (args) => {
        const output = await this.notifyService.sendDocument(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
