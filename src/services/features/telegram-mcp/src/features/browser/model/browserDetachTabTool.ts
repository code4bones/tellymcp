import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserDetachTabInputSchema,
  browserDetachTabOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserDetachTabTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_detach_tab",
      {
        title: "Browser Detach Tab",
        description:
          "Detach the current MCP session from the currently selected attached browser tab.",
        inputSchema: browserDetachTabInputSchema,
        outputSchema: browserDetachTabOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.detachTab(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
