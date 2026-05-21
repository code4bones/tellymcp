import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  renameSessionInputSchema,
  renameSessionOutputSchema,
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

export class RenameSessionTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "rename_session",
      {
        title: "Rename Session",
        description:
          "Rename only the human-readable session label. Use this when the user wants a clearer console name; it does not change session_id, terminal target, or saved context.",
        inputSchema: renameSessionInputSchema,
        outputSchema: renameSessionOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.renameSession(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
