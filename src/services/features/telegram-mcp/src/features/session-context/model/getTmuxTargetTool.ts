import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTmuxTargetInputSchema,
  getTmuxTargetOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { SessionContextService } from "./sessionContextService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class GetTmuxTargetTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_tmux_target",
      {
        title: "Get tmux Target",
        description:
          "Debug/setup tool. Return the stored tmux pane target for a session, including the last time the service nudged that tmux pane. Do not call this in the normal inbox-processing path after a tmux nudge.",
        inputSchema: getTmuxTargetInputSchema,
        outputSchema: getTmuxTargetOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.getTmuxTarget(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
