import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  sendPartnerNoteInputSchema,
  sendPartnerNoteOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { CollaborationService } from "./collaborationService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class SendPartnerNoteTool implements ToolModule {
  public constructor(
    private readonly collaborationService: CollaborationService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "send_partner_note",
      {
        title: "Send Partner Note",
        description:
          "Write a structured collaboration note to the linked partner session, copy listed artifacts into the partner's .mcp-xchange, append SHARE_INDEX.md, and enqueue an inbox message for the partner agent.",
        inputSchema: sendPartnerNoteInputSchema,
        outputSchema: sendPartnerNoteOutputSchema,
      },
      async (args) => {
        const output = await this.collaborationService.sendPartnerNote(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
