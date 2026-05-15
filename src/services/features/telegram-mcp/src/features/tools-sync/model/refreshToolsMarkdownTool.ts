import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  refreshToolsMarkdownInputSchema,
  refreshToolsMarkdownOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { RefreshToolsMarkdownService } from "./refreshToolsMarkdownService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class RefreshToolsMarkdownTool implements ToolModule {
  public constructor(
    private readonly refreshToolsMarkdownService: RefreshToolsMarkdownService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "refresh_tools_markdown",
      {
        title: "Refresh TOOLS.md",
        description:
          "Download the latest TOOLS.md from the configured gateway and overwrite the local TOOLS.md. If no gateway is configured, refresh from the local file.",
        inputSchema: refreshToolsMarkdownInputSchema,
        outputSchema: refreshToolsMarkdownOutputSchema,
      },
      async (args) => {
        const output = await this.refreshToolsMarkdownService.refresh(args);

        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
