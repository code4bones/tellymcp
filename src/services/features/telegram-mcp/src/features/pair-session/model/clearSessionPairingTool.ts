import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  clearSessionPairingInputSchema,
  clearSessionPairingOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { PairSessionService } from "./generatePairCode";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class ClearSessionPairingTool implements ToolModule {
  public constructor(private readonly pairSessionService: PairSessionService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "clear_session_pairing",
      {
        title: "Clear Session Pairing",
        description:
          "Use this when the user asks to unpair, unlink, detach, or reset Telegram binding for the current session. Remove Telegram binding for a session so it can be paired again.",
        inputSchema: clearSessionPairingInputSchema,
        outputSchema: clearSessionPairingOutputSchema,
      },
      async (args) => {
        const output = await this.pairSessionService.clearPairing(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
