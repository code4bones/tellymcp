import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getRuntimeDiagnosticsInputSchema,
  getRuntimeDiagnosticsOutputSchema,
} from "../../../entities/request/model/schema";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { SessionContextService } from "./sessionContextService";

export class GetRuntimeDiagnosticsTool implements ToolModule {
  public constructor(
    private readonly sessionContextService: SessionContextService,
  ) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_runtime_diagnostics",
      {
        title: "Get Runtime Diagnostics",
        description:
          "Run safe, read-only health checks for a selected console: environment schema, package/protocol version, runtime state store, PTY state, gateway configuration, and gateway-to-client relay. Redis is probed only for gateway runtimes. Secrets and raw connection strings are never returned. In gateway mode, pass session_id exactly as returned by list_gateway_sessions.",
        inputSchema: getRuntimeDiagnosticsInputSchema,
        outputSchema: getRuntimeDiagnosticsOutputSchema,
      },
      async (args) => {
        const output =
          await this.sessionContextService.getRuntimeDiagnostics(args);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
        };
      },
    );
  }
}
