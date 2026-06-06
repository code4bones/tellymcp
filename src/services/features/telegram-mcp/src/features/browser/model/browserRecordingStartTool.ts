import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserRecordingStartInputSchema,
  browserRecordingStartOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserRecordingStartTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_recording_start",
      {
        title: "Browser Recording Start",
        description:
          "Start a structured browser recording bundle for the Firefox tab selected for this MCP session through the local browser-attach extension. The recording is written under .mcp-xchange/web/{tab-title-slug}-{timestamp}/ with session.json, timeline.ndjson, pages/, network/, and console/ artifacts.",
        inputSchema: browserRecordingStartInputSchema,
        outputSchema: browserRecordingStartOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.startRecording(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
