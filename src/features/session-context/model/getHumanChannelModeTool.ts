import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getHumanChannelModeInputSchema,
  getHumanChannelModeOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { SessionContextService } from "./sessionContextService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class GetHumanChannelModeTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_human_channel_mode",
      {
        title: "Get Human Channel Mode",
        description:
          "Return the current direct-vs-telegram interaction mode for a session, together with whether proactive Telegram inbox polling should be enabled.",
        inputSchema: getHumanChannelModeInputSchema,
        outputSchema: getHumanChannelModeOutputSchema,
      },
      async (args) => {
        const output =
          await this.sessionContextService.getHumanChannelMode(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
