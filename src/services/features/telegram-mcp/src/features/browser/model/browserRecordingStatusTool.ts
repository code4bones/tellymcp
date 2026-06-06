import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserRecordingStatusInputSchema,
  browserRecordingStatusOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserRecordingStatusTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_recording_status",
      {
        title: "Browser Recording Status",
        description:
          "Report whether a structured browser recording is active for the current MCP session, and return the current bundle path and metadata if it exists.",
        inputSchema: browserRecordingStatusInputSchema,
        outputSchema: browserRecordingStatusOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getRecordingStatus(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
