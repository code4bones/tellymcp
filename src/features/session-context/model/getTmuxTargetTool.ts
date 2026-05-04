import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getTmuxTargetInputSchema,
  getTmuxTargetOutputSchema,
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
          "Return the stored tmux pane target for a session, including the last time the service nudged that tmux pane.",
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
