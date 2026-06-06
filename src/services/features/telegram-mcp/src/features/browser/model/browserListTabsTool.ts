import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserListTabsInputSchema,
  browserListTabsOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class BrowserListTabsTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_list_tabs",
      {
        title: "Browser List Tabs",
        description:
          "List tabs from a Firefox browser instance attached through the local browser-attach extension bridge. If only one instance is connected, instance_id can be omitted. Note: active=true is per Firefox window; for the tab selected for the current MCP session, use selected=true.",
        inputSchema: browserListTabsInputSchema,
        outputSchema: browserListTabsOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.listTabs(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
