import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getSessionContextInputSchema,
  getSessionContextOutputSchema,
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

export class GetSessionContextTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_session_context",
      {
        title: "Get Session Context",
        description:
          "Debug/setup tool. Read the saved context and routing status for the current console. Use this when you need to inspect stored task summary, files, risks, or gateway-facing route state. Do not call it in the normal xchange-processing path unless you are diagnosing state.",
        inputSchema: getSessionContextInputSchema,
        outputSchema: getSessionContextOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.getContext(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
