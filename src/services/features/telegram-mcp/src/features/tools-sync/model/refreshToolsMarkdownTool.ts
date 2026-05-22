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
          "Use this when the user asks to refresh or update agent instructions, tools documentation, or gateway-side working rules. In gateway mode, always pass explicit session_id equal to the canonical gateway console id client_uuid:local_session_id. If the current console id is already known from prior context, reuse it directly and do not call list_gateway_sessions again. Only call list_gateway_sessions when the console id is unknown, then take session_id from the matching record exactly as returned. Do not use workspace-derived ids or cwd for routing. The tool downloads the canonical TOOLS.md from the configured gateway, overwrites the target console workspace TOOLS.md, then you must re-read that workspace TOOLS.md before continuing. If no gateway is configured, refresh from the installed package copy.",
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
