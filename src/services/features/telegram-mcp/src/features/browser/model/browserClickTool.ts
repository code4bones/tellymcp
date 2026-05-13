import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserClickInputSchema,
  browserClickOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserClickTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_click",
      {
        title: "Browser Click",
        description:
          "Click an element in the session browser page by CSS selector or visible text.",
        inputSchema: browserClickInputSchema,
        outputSchema: browserClickOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.click(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
