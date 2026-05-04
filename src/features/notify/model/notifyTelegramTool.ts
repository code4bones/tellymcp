import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  notifyTelegramInputSchema,
  notifyTelegramOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { NotifyService } from "./notifyService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class NotifyTelegramTool implements ToolModule {
  public constructor(private readonly notifyService: NotifyService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "notify_telegram",
      {
        title: "Notify Telegram",
        description:
          "Send a one-way Telegram notification to the user linked to the provided session.",
        inputSchema: notifyTelegramInputSchema,
        outputSchema: notifyTelegramOutputSchema,
      },
      async (args) => {
        const output = await this.notifyService.send(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
