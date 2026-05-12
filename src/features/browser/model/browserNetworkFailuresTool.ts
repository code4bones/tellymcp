import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserNetworkFailuresInputSchema,
  browserNetworkFailuresOutputSchema,
} from "../../../entities/request/model/schema.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { BrowserService } from "./browserService.js";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

export class BrowserNetworkFailuresTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_network_failures",
      {
        title: "Browser Network Failures",
        description:
          "Read recent failed or HTTP-error network requests captured from the Playwright tab for the current session.",
        inputSchema: browserNetworkFailuresInputSchema,
        outputSchema: browserNetworkFailuresOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.getNetworkFailures(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
