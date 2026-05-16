import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserScreenshotInputSchema,
  browserScreenshotOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

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
          "Capture a screenshot from the Playwright tab for the current session and save it into .mcp-xchange. Use this when the user wants a visual artifact that can later be shared through Local or Collab flows.",
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
