import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserComputedStyleInputSchema,
  browserComputedStyleOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserComputedStyleTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_computed_style",
      {
        title: "Browser Computed Style",
        description:
          "Read computed CSS properties and box metrics for a DOM element in the Playwright tab for the current session.",
        inputSchema: browserComputedStyleInputSchema,
        outputSchema: browserComputedStyleOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getComputedStyle(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
