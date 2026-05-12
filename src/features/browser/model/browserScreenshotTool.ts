import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserScreenshotInputSchema,
  browserScreenshotOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserScreenshotTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_screenshot",
      {
        title: "Browser Screenshot",
        description:
          "Capture a screenshot from the Playwright tab for the current session and save it into the session exchange directory.",
        inputSchema: browserScreenshotInputSchema,
        outputSchema: browserScreenshotOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.screenshot(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
