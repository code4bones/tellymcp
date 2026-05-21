import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  askUserTelegramInputSchema,
  askUserTelegramOutputSchema,
} from "../../../entities/request/model/schema";
import type { HumanApprovalOrchestrator } from "../../../processes/human-approval/model/orchestrator";
import type { ToolModule } from "../../../shared/api/tool-registry/types";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class AskUserTelegramTool implements ToolModule {
  public constructor(
    private readonly orchestrator: HumanApprovalOrchestrator,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "ask_user_telegram",
      {
        title: "Ask User Telegram",
        description:
          "Send a clarification request to the Telegram user for the provided console and wait for a reply. Pass session_id explicitly for the active console; do not rely on implicit defaults unless cwd is also correct for this agent workspace.",
        inputSchema: askUserTelegramInputSchema,
        outputSchema: askUserTelegramOutputSchema,
      },
      async (args) => {
        const output = await this.orchestrator.submit(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
