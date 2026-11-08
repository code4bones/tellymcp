import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserDomInputSchema,
  browserDomOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

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
          "Inspect DOM in the session's browser target. By default return the first matching element; all=true returns up to limit matches (max50) with a shared max_chars budget, total and truncated flags. Use a Picker group's exact attribute selector to read marked elements live. Optional instance_id/tab_id require that exact attached target and reject a changed binding. Inspect the selected attached tab when present; otherwise use the isolated Playwright page.",
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
