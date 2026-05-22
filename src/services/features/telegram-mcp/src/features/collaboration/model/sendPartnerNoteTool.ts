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
          "Use this for agent-to-agent collaboration: ask another console to do work, send a reply, or share results. The canonical gateway-facing console id is session_id in the format client_uuid:local_session_id. For direct routing outside a collab project, pass that canonical console id in target_session_id. Only use target_client_uuid plus target_local_session_id when you already have those exact direct fields separately. For project/collab routing, use target_session_id equal to the project session id and, if available, project_uuid. If the result includes an existing local file, prefer send_partner_file; mentioning the filename in message text is not enough. For required replies, the task is not complete until this tool succeeds.",
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
