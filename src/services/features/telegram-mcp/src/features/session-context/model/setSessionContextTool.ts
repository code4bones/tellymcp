import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  setSessionContextInputSchema,
  setSessionContextOutputSchema,
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

export class SetSessionContextTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "set_session_context",
      {
        title: "Set Session Context",
        description:
          "Save compact reusable context for the session: current task, summary, decisions, files, and risks. Use this to leave a short durable working state for later Telegram-driven continuation.",
        inputSchema: setSessionContextInputSchema,
        outputSchema: setSessionContextOutputSchema,
      },
      async (args) => {
        const output = await this.sessionContextService.setContext(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
