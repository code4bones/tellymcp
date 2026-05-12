import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserConsoleInputSchema,
  browserConsoleOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserConsoleTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_console",
      {
        title: "Browser Console",
        description:
          "Read recent console messages captured from the Playwright tab attached to the current session.",
        inputSchema: browserConsoleInputSchema,
        outputSchema: browserConsoleOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getConsole(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
