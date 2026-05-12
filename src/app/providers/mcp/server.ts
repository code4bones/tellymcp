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
import { BrowserOpenTool } from "../../../features/browser/model/browserOpenTool.js";
import { BrowserReloadTool } from "../../../features/browser/model/browserReloadTool.js";
import { BrowserClickTool } from "../../../features/browser/model/browserClickTool.js";
import { BrowserFillTool } from "../../../features/browser/model/browserFillTool.js";
import { BrowserPressTool } from "../../../features/browser/model/browserPressTool.js";
import { BrowserWaitForTool } from "../../../features/browser/model/browserWaitForTool.js";
import { BrowserConsoleTool } from "../../../features/browser/model/browserConsoleTool.js";
import { BrowserErrorsTool } from "../../../features/browser/model/browserErrorsTool.js";
import { BrowserNetworkFailuresTool } from "../../../features/browser/model/browserNetworkFailuresTool.js";
import { BrowserDomTool } from "../../../features/browser/model/browserDomTool.js";
import { BrowserComputedStyleTool } from "../../../features/browser/model/browserComputedStyleTool.js";
import { BrowserScreenshotTool } from "../../../features/browser/model/browserScreenshotTool.js";
import { BrowserCloseTool } from "../../../features/browser/model/browserCloseTool.js";
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
  browserOpenTool: BrowserOpenTool;
  browserReloadTool: BrowserReloadTool;
  browserClickTool: BrowserClickTool;
  browserFillTool: BrowserFillTool;
  browserPressTool: BrowserPressTool;
  browserWaitForTool: BrowserWaitForTool;
  browserConsoleTool: BrowserConsoleTool;
  browserErrorsTool: BrowserErrorsTool;
  browserNetworkFailuresTool: BrowserNetworkFailuresTool;
  browserDomTool: BrowserDomTool;
  browserComputedStyleTool: BrowserComputedStyleTool;
  browserScreenshotTool: BrowserScreenshotTool;
  browserCloseTool: BrowserCloseTool;
};
