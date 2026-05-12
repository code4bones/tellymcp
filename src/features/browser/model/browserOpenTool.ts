import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserOpenInputSchema,
  browserOpenOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class BrowserOpenTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_open",
      {
        title: "Browser Open",
        description:
          "Open a URL in the isolated Playwright browser context for the current session. Reuse the existing tab unless reset_context=true.",
        inputSchema: browserOpenInputSchema,
        outputSchema: browserOpenOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.open(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
