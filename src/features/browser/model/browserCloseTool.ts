import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserCloseInputSchema,
  browserCloseOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserCloseTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_close",
      {
        title: "Browser Close",
        description:
          "Close the Playwright browser context attached to the current session.",
        inputSchema: browserCloseInputSchema,
        outputSchema: browserCloseOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.close(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
