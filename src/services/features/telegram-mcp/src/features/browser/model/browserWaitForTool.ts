import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserWaitForInputSchema,
  browserWaitForOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserWaitForTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_wait_for",
      {
        title: "Browser Wait For",
        description:
          "Wait for an element in the session browser page to reach the requested state by CSS selector or visible text.",
        inputSchema: browserWaitForInputSchema,
        outputSchema: browserWaitForOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.waitFor(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
