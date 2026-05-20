import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getXchangeRecordInputSchema,
  getXchangeRecordOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { XchangeService } from "./xchangeService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class GetXchangeRecordTool implements ToolModule {
  public constructor(private readonly xchangeService: XchangeService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_xchange_record",
      {
        title: "Get Xchange Record",
        description:
          "Read one structured .mcp-xchange record by record_id. Use this to get the full body_text, action_desc, tools, attachments, routing metadata, and reply requirements for a collaboration or handoff item.",
        inputSchema: getXchangeRecordInputSchema,
        outputSchema: getXchangeRecordOutputSchema,
      },
      async (args) => {
        const output = await this.xchangeService.getRecord(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
