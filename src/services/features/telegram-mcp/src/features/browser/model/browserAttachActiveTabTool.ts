import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserAttachActiveTabInputSchema,
  browserAttachTabOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserAttachActiveTabTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_attach_active_tab",
      {
        title: "Browser Attach Active Tab",
        description:
          "Attach the current MCP session to the active tab of a connected attached browser instance. If only one instance is connected, instance_id can be omitted.",
        inputSchema: browserAttachActiveTabInputSchema,
        outputSchema: browserAttachTabOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.attachActiveTab(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
