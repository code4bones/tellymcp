import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserFillInputSchema,
  browserFillOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserFillTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_fill",
      {
        title: "Browser Fill",
        description:
          "Fill an input or textarea in the session browser page by CSS selector or visible text.",
        inputSchema: browserFillInputSchema,
        outputSchema: browserFillOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.fill(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
