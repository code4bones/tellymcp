import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  setHumanChannelModeInputSchema,
  setHumanChannelModeOutputSchema,
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

export class SetHumanChannelModeTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "set_human_channel_mode",
      {
        title: "Set Human Channel Mode",
        description:
          "Switch the session between direct mode and Telegram mode. Telegram mode explicitly instructs the agent to poll the Telegram inbox count at checkpoints.",
        inputSchema: setHumanChannelModeInputSchema,
        outputSchema: setHumanChannelModeOutputSchema,
      },
      async (args) => {
        const output =
          await this.sessionContextService.setHumanChannelMode(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
