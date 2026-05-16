import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  sendPartnerFileInputSchema,
  sendPartnerNoteOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { SendPartnerFileService } from "./sendPartnerFileService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class SendPartnerFileTool implements ToolModule {
  public constructor(
    private readonly sendPartnerFileService: SendPartnerFileService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "send_partner_file",
      {
        title: "Send Partner File",
        description:
          "Use this when the result must include a real local workspace file for another session. Prefer this over send_partner_note when you already have an existing file path such as sample.txt, report.pdf, or screenshot.png. The tool reads the file from the current session workspace, attaches it as an artifact, and sends the partner note in one step.",
        inputSchema: sendPartnerFileInputSchema,
        outputSchema: sendPartnerNoteOutputSchema,
      },
      async (args) => {
        const output = await this.sendPartnerFileService.send(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
