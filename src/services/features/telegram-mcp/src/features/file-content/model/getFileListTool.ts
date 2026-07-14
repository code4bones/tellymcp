import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getFileListInputSchema,
  getFileListOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { GetFileService } from "./getFileService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class GetFileListTool implements ToolModule {
  public constructor(private readonly getFileService: GetFileService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_file_list",
      {
        title: "Get File List",
        description:
          "List managed files available in the workspace of a selected live console before calling get_file. Returns exact file_path values for Telegram uploads, browser screenshots, and partner artifacts, newest first. In gateway mode, pass session_id exactly as returned by list_gateway_sessions. Optionally filter by source and limit the result count.",
        inputSchema: getFileListInputSchema,
        outputSchema: getFileListOutputSchema,
      },
      async (args) => {
        const output = await this.getFileService.list(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
