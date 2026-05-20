import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  markXchangeRecordReadInputSchema,
  markXchangeRecordReadOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { XchangeService } from "./xchangeService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class MarkXchangeRecordReadTool implements ToolModule {
  public constructor(private readonly xchangeService: XchangeService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "mark_xchange_record_read",
      {
        title: "Mark Xchange Record Read",
        description:
          "Mark a structured .mcp-xchange record as read after you have consumed its body_text, attachments, and next-step instructions.",
        inputSchema: markXchangeRecordReadInputSchema,
        outputSchema: markXchangeRecordReadOutputSchema,
      },
      async (args) => {
        const output = await this.xchangeService.markRead(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
