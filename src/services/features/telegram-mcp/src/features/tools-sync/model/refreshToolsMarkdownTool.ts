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
          "Use this when the user asks to refresh or update agent instructions, tools documentation, or gateway-side working rules. Download the canonical TOOLS.md from the configured gateway, overwrite the local workspace TOOLS.md, then re-read that local TOOLS.md before continuing. If no gateway is configured, refresh from the local file.",
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
