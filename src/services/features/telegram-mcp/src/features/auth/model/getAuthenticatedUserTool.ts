import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types";

const outputSchema = z.object({
  authenticated: z.boolean(),
  subject: z.string().optional(),
  telegram_user_id: z.string().optional(),
  telegram_username: z.string().optional(),
  expires_at: z.number().int().optional(),
});

/**
 * A profile-shaped read-only tool lets MCP hosts display the connected human
 * account. It intentionally returns identity metadata only; OAuth credentials
 * and the OAuth client identifier never leave the request context.
 */
export class GetAuthenticatedUserTool implements ToolModule {
  public register(server: McpServer): void {
    server.registerTool(
      "get_authenticated_user",
      {
        title: "Get authenticated user",
        description:
          "Use this to identify the Telegram account currently authorized for this TellyMCP connection. It never returns OAuth tokens.",
        inputSchema: {},
        outputSchema,
        annotations: { readOnlyHint: true },
        _meta: { "openai/profile": true },
      },
      async (_args, extra) => {
        const authInfo = extra.authInfo;
        const telegramId = authInfo?.extra?.telegramId;
        const telegramUsername = authInfo?.extra?.telegramUsername;
        const output = {
          authenticated: Boolean(authInfo),
          ...(authInfo ? { subject: authInfo.clientId } : {}),
          ...(typeof telegramId === "string"
            ? { telegram_user_id: telegramId }
            : {}),
          ...(typeof telegramUsername === "string"
            ? { telegram_username: telegramUsername }
            : {}),
          ...(typeof authInfo?.expiresAt === "number"
            ? { expires_at: authInfo.expiresAt }
            : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );
  }
}
