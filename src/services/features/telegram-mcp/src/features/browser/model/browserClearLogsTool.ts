import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserClearLogsInputSchema,
  browserClearLogsOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserClearLogsTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_clear_logs",
      {
        title: "Browser Clear Logs",
        description:
          "Clear accumulated console, page error, and network failure buffers for the current session page.",
        inputSchema: browserClearLogsInputSchema,
        outputSchema: browserClearLogsOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.clearLogs(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
