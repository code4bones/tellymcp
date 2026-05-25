import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AskUserTelegramTool } from "../../../features/ask-user/model/askUserTelegram";
import { NotifyTelegramTool } from "../../../features/notify/model/notifyTelegramTool";
import { SendFileToTelegramTool } from "../../../features/notify/model/sendFileToTelegramTool";
import { ClearSessionContextTool } from "../../../features/session-context/model/clearSessionContextTool";
import { GetSessionContextTool } from "../../../features/session-context/model/getSessionContextTool";
import { RenameSessionTool } from "../../../features/session-context/model/renameSessionTool";
import { SetSessionContextTool } from "../../../features/session-context/model/setSessionContextTool";
import { BrowserOpenTool } from "../../../features/browser/model/browserOpenTool";
import { BrowserReloadTool } from "../../../features/browser/model/browserReloadTool";
import { BrowserClickTool } from "../../../features/browser/model/browserClickTool";
import { BrowserFillTool } from "../../../features/browser/model/browserFillTool";
import { BrowserPressTool } from "../../../features/browser/model/browserPressTool";
import { BrowserWaitForTool } from "../../../features/browser/model/browserWaitForTool";
import { BrowserWaitForUrlTool } from "../../../features/browser/model/browserWaitForUrlTool";
import { BrowserConsoleTool } from "../../../features/browser/model/browserConsoleTool";
import { BrowserErrorsTool } from "../../../features/browser/model/browserErrorsTool";
import { BrowserNetworkFailuresTool } from "../../../features/browser/model/browserNetworkFailuresTool";
import { BrowserClearLogsTool } from "../../../features/browser/model/browserClearLogsTool";
import { BrowserDomTool } from "../../../features/browser/model/browserDomTool";
import { BrowserComputedStyleTool } from "../../../features/browser/model/browserComputedStyleTool";
import { BrowserScreenshotTool } from "../../../features/browser/model/browserScreenshotTool";
import { BrowserCloseTool } from "../../../features/browser/model/browserCloseTool";
import { SendPartnerFileTool } from "../../../features/collaboration/model/sendPartnerFileTool";
import { ListGatewaySessionsTool } from "../../../features/collaboration/model/listGatewaySessionsTool";
import { SendPartnerNoteTool } from "../../../features/collaboration/model/sendPartnerNoteTool";
import { RefreshToolsMarkdownTool } from "../../../features/tools-sync/model/refreshToolsMarkdownTool";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { registerTools } from "../../../shared/api/tool-registry/registry";
import { getTellyMcpPackageVersion } from "../../../shared/lib/version/versionHandshake";

export function createMcpServer(tools: ToolModule[]): McpServer {
  const server = new McpServer({
    name: "tellymcp",
    version: getTellyMcpPackageVersion(__dirname),
  });

  registerTools(server, tools);
  return server;
}

export type AppToolModules = {
  askUserTelegramTool: AskUserTelegramTool;
  notifyTelegramTool: NotifyTelegramTool;
  sendFileToTelegramTool: SendFileToTelegramTool;
  setSessionContextTool: SetSessionContextTool;
  renameSessionTool: RenameSessionTool;
  getSessionContextTool: GetSessionContextTool;
  clearSessionContextTool: ClearSessionContextTool;
  browserOpenTool: BrowserOpenTool;
  browserReloadTool: BrowserReloadTool;
  browserClickTool: BrowserClickTool;
  browserFillTool: BrowserFillTool;
  browserPressTool: BrowserPressTool;
  browserWaitForTool: BrowserWaitForTool;
  browserWaitForUrlTool: BrowserWaitForUrlTool;
  browserConsoleTool: BrowserConsoleTool;
  browserErrorsTool: BrowserErrorsTool;
  browserNetworkFailuresTool: BrowserNetworkFailuresTool;
  browserClearLogsTool: BrowserClearLogsTool;
  browserDomTool: BrowserDomTool;
  browserComputedStyleTool: BrowserComputedStyleTool;
  browserScreenshotTool: BrowserScreenshotTool;
  browserCloseTool: BrowserCloseTool;
  sendPartnerFileTool: SendPartnerFileTool;
  listGatewaySessionsTool: ListGatewaySessionsTool;
  sendPartnerNoteTool: SendPartnerNoteTool;
  refreshToolsMarkdownTool: RefreshToolsMarkdownTool;
};
