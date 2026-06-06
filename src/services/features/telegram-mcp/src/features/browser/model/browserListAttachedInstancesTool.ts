import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browserListAttachedInstancesInputSchema,
  browserListAttachedInstancesOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { BrowserService } from "./browserService";

function createContent(output: unknown): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text",
      text: JSON.stringify(output, null, 2),
    },
  ];
}

export class BrowserListAttachedInstancesTool implements ToolModule {
  public constructor(private readonly browserService: BrowserService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "browser_list_attached_instances",
      {
        title: "Browser List Attached Instances",
        description:
          "List Firefox browser instances currently attached through the local browser-attach extension bridge for the current console.",
        inputSchema: browserListAttachedInstancesInputSchema,
        outputSchema: browserListAttachedInstancesOutputSchema,
      },
      async (args) => {
        const output = await this.browserService.listAttachedInstances(args);
        return {
          content: createContent(output),
          structuredContent: output,
        };
      },
    );
  }
}
