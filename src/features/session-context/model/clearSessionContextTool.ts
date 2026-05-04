import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  clearSessionContextInputSchema,
  clearSessionContextOutputSchema,
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

export class ClearSessionContextTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "clear_session_context",
      {
        title: "Clear Session Context",
        description:
          "Delete saved context for a session and remove Telegram pairing for the same session.",
        inputSchema: clearSessionContextInputSchema,
        outputSchema: clearSessionContextOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.clearContext(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
