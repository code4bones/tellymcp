import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  clearSessionContextInputSchema,
  clearSessionContextOutputSchema,
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
          "Use this for full session cleanup/reset. It removes saved context, pairing, and related per-session state for the session.",
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
