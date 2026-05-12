import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserErrorsInputSchema,
  browserErrorsOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserErrorsTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_errors",
      {
        title: "Browser Errors",
        description:
          "Read recent page-level runtime exceptions captured from the Playwright tab for the current session.",
        inputSchema: browserErrorsInputSchema,
        outputSchema: browserErrorsOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getErrors(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
