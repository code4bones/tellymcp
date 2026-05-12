import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserDomInputSchema,
  browserDomOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserDomTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_dom",
      {
        title: "Browser DOM",
        description:
          "Inspect a DOM element in the Playwright tab for the current session and return text, HTML, attributes, and visibility.",
        inputSchema: browserDomInputSchema,
        outputSchema: browserDomOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getDom(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
