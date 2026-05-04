import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  setTmuxTargetInputSchema,
  setTmuxTargetOutputSchema,
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

export class SetTmuxTargetTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "set_tmux_target",
      {
        title: "Set tmux Target",
        description:
          "Store the tmux pane target for a session so the long-running MCP service can nudge the agent to check Telegram inbox when new ordinary Telegram messages arrive.",
        inputSchema: setTmuxTargetInputSchema,
        outputSchema: setTmuxTargetOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.setTmuxTarget(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
