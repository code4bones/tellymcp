import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserPressInputSchema,
  browserPressOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserPressTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_press",
      {
        title: "Browser Press",
        description:
          "Send a key press to the session browser page or to a targeted element.",
        inputSchema: browserPressInputSchema,
        outputSchema: browserPressOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.press(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
