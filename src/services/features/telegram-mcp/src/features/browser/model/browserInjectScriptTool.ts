import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserInjectScriptInputSchema,
  browserInjectScriptOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserInjectScriptTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_inject_script",
      {
        title: "Browser Inject Script",
        description:
          "Inject JavaScript into the current session browser target. If the session has a selected attached browser tab, inject into that real tab; otherwise inject into the isolated Playwright page. The script is wrapped so window[namespace] exists, with namespace defaulting to TELLY.",
        inputSchema: browserInjectScriptInputSchema,
        outputSchema: browserInjectScriptOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.injectScript(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
