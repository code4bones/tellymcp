import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  sendPartnerNoteInputSchema,
  sendPartnerNoteOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { CollaborationService } from "./collaborationService";

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
          "Use this for agent-to-agent collaboration: ask another session to do work, send a reply, or share results. Resolve the target explicitly for project/collab work with target_session_id and, if available, project_uuid. If the result includes an existing local file, prefer send_partner_file; mentioning the filename in message text is not enough. For required replies, the task is not complete until this tool succeeds.",
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
