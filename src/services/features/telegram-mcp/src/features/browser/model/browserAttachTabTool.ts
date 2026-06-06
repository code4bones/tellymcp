import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserAttachTabInputSchema,
  browserAttachTabOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserAttachTabTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_attach_tab",
      {
        title: "Browser Attach Tab",
        description:
          "Attach the current MCP session to a specific tab in a connected attached browser instance by tab_id.",
        inputSchema: browserAttachTabInputSchema,
        outputSchema: browserAttachTabOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.attachTab(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
