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
          "Capture a screenshot from the current session browser target. If the session has a selected attached Firefox tab, capture that real browser tab; otherwise use the isolated Playwright page. By default it is saved into .mcp-xchange. If the user wants the screenshot sent back to the human in Telegram, set send_to_telegram=true so the PNG is delivered through the gateway route instead of forcing a separate file-delivery workaround.",
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
