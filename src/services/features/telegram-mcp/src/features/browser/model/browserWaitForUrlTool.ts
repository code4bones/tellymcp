import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserWaitForUrlInputSchema,
  browserWaitForUrlOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserWaitForUrlTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_wait_for_url",
      {
        title: "Browser Wait For URL",
        description:
          "Wait for the session browser page to reach an exact URL or contain a URL fragment after navigation.",
        inputSchema: browserWaitForUrlInputSchema,
        outputSchema: browserWaitForUrlOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.waitForUrl(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
