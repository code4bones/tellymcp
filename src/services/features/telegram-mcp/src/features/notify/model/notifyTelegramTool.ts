import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  notifyTelegramInputSchema,
  notifyTelegramOutputSchema,
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

export class NotifyTelegramTool implements ToolModule {
  public constructor(private readonly notifyService: NotifyService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "notify_telegram",
      {
        title: "Notify Telegram",
        description:
          "Use this for one-way status or progress notifications to the human linked to the current console. Pass session_id explicitly; do not rely on implicit defaults unless cwd is also correct for this agent workspace. This does not wait for a reply and does not create a new work item for the agent.",
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
