import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserRecordingStopInputSchema,
  browserRecordingStopOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserRecordingStopTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_recording_stop",
      {
        title: "Browser Recording Stop",
        description:
          "Stop the active structured browser recording for the current session. The bundle remains in .mcp-xchange/web/... for later analysis by the agent.",
        inputSchema: browserRecordingStopInputSchema,
        outputSchema: browserRecordingStopOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.stopRecording(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
