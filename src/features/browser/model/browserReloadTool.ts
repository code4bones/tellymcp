import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserReloadInputSchema,
  browserReloadOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserReloadTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_reload",
      {
        title: "Browser Reload",
        description:
          "Reload the current Playwright page for the session and wait for the selected load state.",
        inputSchema: browserReloadInputSchema,
        outputSchema: browserReloadOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.reload(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
