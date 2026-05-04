import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createSessionPairCodeInputSchema,
  createSessionPairCodeOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { PairSessionService } from "./generatePairCode.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class CreateSessionPairCodeTool implements ToolModule {
  public constructor(private readonly pairSessionService: PairSessionService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "create_session_pair_code",
      {
        title: "Create Session Pair Code",
        description:
          "Create a short-lived Telegram pairing code for a session.",
        inputSchema: createSessionPairCodeInputSchema,
        outputSchema: createSessionPairCodeOutputSchema,
      },
      async (args) => {
        const output = await this.pairSessionService.createPairCode(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
