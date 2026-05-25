import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listXchangeRecordsInputSchema,
  listXchangeRecordsOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { XchangeService } from "./xchangeService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class ListXchangeRecordsTool implements ToolModule {
  public constructor(private readonly xchangeService: XchangeService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "list_xchange_records",
      {
        title: "List Xchange Records",
        description:
          "List structured .mcp-xchange records for the current console from the local sqlite store. Use this first for partner notes, local handoffs, unread collaboration items, human Telegram messages, and follow-up work instead of parsing markdown index files or relying on inbox-style flows.",
        inputSchema: listXchangeRecordsInputSchema,
        outputSchema: listXchangeRecordsOutputSchema,
      },
      async (args) => {
        const output = await this.xchangeService.listRecords(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
