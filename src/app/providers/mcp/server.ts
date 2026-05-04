import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AskUserTelegramTool } from "../../../features/ask-user/model/askUserTelegram.js";
import { DeleteTelegramInboxMessageTool } from "../../../features/inbox/model/deleteTelegramInboxMessageTool.js";
import { GetTelegramInboxCountTool } from "../../../features/inbox/model/getTelegramInboxCountTool.js";
import { GetTelegramInboxTool } from "../../../features/inbox/model/getTelegramInboxTool.js";
import { NotifyTelegramTool } from "../../../features/notify/model/notifyTelegramTool.js";
import { ClearSessionPairingTool } from "../../../features/pair-session/model/clearSessionPairingTool.js";
import { CreateSessionPairCodeTool } from "../../../features/pair-session/model/createSessionPairCodeTool.js";
import { ClearSessionContextTool } from "../../../features/session-context/model/clearSessionContextTool.js";
import { GetSessionContextTool } from "../../../features/session-context/model/getSessionContextTool.js";
import { GetTmuxTargetTool } from "../../../features/session-context/model/getTmuxTargetTool.js";
import { RenameSessionTool } from "../../../features/session-context/model/renameSessionTool.js";
import { SetSessionContextTool } from "../../../features/session-context/model/setSessionContextTool.js";
import { SetTmuxTargetTool } from "../../../features/session-context/model/setTmuxTargetTool.js";
import type { ToolModule } from "../../../shared/api/tool-registry/types.js";
import { registerTools } from "../../../shared/api/tool-registry/registry.js";

export function createMcpServer(tools: ToolModule[]): McpServer {
  const server = new McpServer({
    name: "telegram-human-mcp",
    version: "1.0.0",
  });

  registerTools(server, tools);
  return server;
}

export type AppToolModules = {
  askUserTelegramTool: AskUserTelegramTool;
  notifyTelegramTool: NotifyTelegramTool;
  getTelegramInboxCountTool: GetTelegramInboxCountTool;
  getTelegramInboxTool: GetTelegramInboxTool;
  deleteTelegramInboxMessageTool: DeleteTelegramInboxMessageTool;
  createSessionPairCodeTool: CreateSessionPairCodeTool;
  clearSessionPairingTool: ClearSessionPairingTool;
  setSessionContextTool: SetSessionContextTool;
  renameSessionTool: RenameSessionTool;
  setTmuxTargetTool: SetTmuxTargetTool;
  getTmuxTargetTool: GetTmuxTargetTool;
  getSessionContextTool: GetSessionContextTool;
  clearSessionContextTool: ClearSessionContextTool;
};
