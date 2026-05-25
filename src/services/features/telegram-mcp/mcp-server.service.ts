import type { Service, ServiceSchema } from "moleculer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createMcpServer,
} from "./src/app/providers/mcp/server";
import {
  TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
  type TelegramMcpApprovalServiceInstance,
} from "./approval.service";
import {
  TELEGRAM_MCP_BROWSER_SERVICE_NAME,
  type TelegramMcpBrowserServiceInstance,
} from "./browser.service";
import {
  TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
  type TelegramMcpCollaborationServiceInstance,
} from "./collaboration.service";
import {
  TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
  type TelegramMcpNotifyServiceInstance,
} from "./notify.service";
import {
  TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
  type TelegramMcpSessionContextServiceInstance,
} from "./session-context.service";
import {
  TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME,
  type TelegramMcpToolsSyncServiceInstance,
} from "./tools-sync.service";
import {
  TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
  type TelegramMcpXchangeServiceInstance,
} from "./xchange.service";
import { AskUserTelegramTool } from "./src/features/ask-user/model/askUserTelegram";
import { BrowserClickTool } from "./src/features/browser/model/browserClickTool";
import { BrowserClearLogsTool } from "./src/features/browser/model/browserClearLogsTool";
import { BrowserCloseTool } from "./src/features/browser/model/browserCloseTool";
import { BrowserComputedStyleTool } from "./src/features/browser/model/browserComputedStyleTool";
import { BrowserConsoleTool } from "./src/features/browser/model/browserConsoleTool";
import { BrowserDomTool } from "./src/features/browser/model/browserDomTool";
import { BrowserErrorsTool } from "./src/features/browser/model/browserErrorsTool";
import { BrowserFillTool } from "./src/features/browser/model/browserFillTool";
import { BrowserNetworkFailuresTool } from "./src/features/browser/model/browserNetworkFailuresTool";
import { BrowserOpenTool } from "./src/features/browser/model/browserOpenTool";
import { BrowserPressTool } from "./src/features/browser/model/browserPressTool";
import { BrowserReloadTool } from "./src/features/browser/model/browserReloadTool";
import { BrowserScreenshotTool } from "./src/features/browser/model/browserScreenshotTool";
import { BrowserWaitForTool } from "./src/features/browser/model/browserWaitForTool";
import { BrowserWaitForUrlTool } from "./src/features/browser/model/browserWaitForUrlTool";
import { SendPartnerFileTool } from "./src/features/collaboration/model/sendPartnerFileTool";
import { ListGatewaySessionsTool } from "./src/features/collaboration/model/listGatewaySessionsTool";
import { SendPartnerNoteTool } from "./src/features/collaboration/model/sendPartnerNoteTool";
import { SendFileToTelegramTool } from "./src/features/notify/model/sendFileToTelegramTool";
import { NotifyTelegramTool } from "./src/features/notify/model/notifyTelegramTool";
import { ClearSessionContextTool } from "./src/features/session-context/model/clearSessionContextTool";
import { GetSessionContextTool } from "./src/features/session-context/model/getSessionContextTool";
import { RenameSessionTool } from "./src/features/session-context/model/renameSessionTool";
import { SetSessionContextTool } from "./src/features/session-context/model/setSessionContextTool";
import { RefreshToolsMarkdownTool } from "./src/features/tools-sync/model/refreshToolsMarkdownTool";
import { GetXchangeRecordTool } from "./src/features/xchange/model/getXchangeRecordTool";
import { ListXchangeRecordsTool } from "./src/features/xchange/model/listXchangeRecordsTool";
import { MarkXchangeRecordReadTool } from "./src/features/xchange/model/markXchangeRecordReadTool";
import type { ToolModule } from "./src/shared/api/tool-registry/types";

export const TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME = "telegramMcp.mcpServer";

export type TelegramMcpMcpServerServiceInstance = Service & {
  createServer: () => McpServer;
};

type McpServerCarrier = Service & {
  createServer?: () => McpServer;
};

const TelegramMcpMcpServerService: ServiceSchema = {
  name: TELEGRAM_MCP_MCP_SERVER_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
    TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
    TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
    TELEGRAM_MCP_BROWSER_SERVICE_NAME,
    TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
    TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME,
    TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
  ],

  methods: {
    createServer(this: McpServerCarrier): McpServer {
      const sessionContextService = this.broker.getLocalService(
        TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
      ) as TelegramMcpSessionContextServiceInstance | null;
      const notifyService = this.broker.getLocalService(
        TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
      ) as TelegramMcpNotifyServiceInstance | null;
      const approvalService = this.broker.getLocalService(
        TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
      ) as TelegramMcpApprovalServiceInstance | null;
      const browserService = this.broker.getLocalService(
        TELEGRAM_MCP_BROWSER_SERVICE_NAME,
      ) as TelegramMcpBrowserServiceInstance | null;
      const collaborationService = this.broker.getLocalService(
        TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
      ) as TelegramMcpCollaborationServiceInstance | null;
      const toolsSyncService = this.broker.getLocalService(
        TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME,
      ) as TelegramMcpToolsSyncServiceInstance | null;
      const xchangeService = this.broker.getLocalService(
        TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
      ) as TelegramMcpXchangeServiceInstance | null;

      if (
        !sessionContextService ||
        !notifyService ||
        !approvalService ||
        !browserService ||
        !collaborationService ||
        !toolsSyncService ||
        !xchangeService
      ) {
        throw new Error("telegram_mcp MCP server dependencies are not ready");
      }

      const tools: ToolModule[] = [
        new SetSessionContextTool(
          sessionContextService.getSessionContextService(),
        ),
        new RenameSessionTool(sessionContextService.getSessionContextService()),
        new GetSessionContextTool(
          sessionContextService.getSessionContextService(),
        ),
        new ClearSessionContextTool(
          sessionContextService.getSessionContextService(),
        ),
        new NotifyTelegramTool(notifyService.getNotifyService()),
        new SendFileToTelegramTool(notifyService.getNotifyService()),
        new AskUserTelegramTool(approvalService.getApprovalOrchestrator()),
        new BrowserOpenTool(browserService.getBrowserService()),
        new BrowserReloadTool(browserService.getBrowserService()),
        new BrowserClickTool(browserService.getBrowserService()),
        new BrowserFillTool(browserService.getBrowserService()),
        new BrowserPressTool(browserService.getBrowserService()),
        new BrowserWaitForTool(browserService.getBrowserService()),
        new BrowserWaitForUrlTool(browserService.getBrowserService()),
        new BrowserConsoleTool(browserService.getBrowserService()),
        new BrowserErrorsTool(browserService.getBrowserService()),
        new BrowserNetworkFailuresTool(browserService.getBrowserService()),
        new BrowserClearLogsTool(browserService.getBrowserService()),
        new BrowserDomTool(browserService.getBrowserService()),
        new BrowserComputedStyleTool(browserService.getBrowserService()),
        new BrowserScreenshotTool(browserService.getBrowserService()),
        new BrowserCloseTool(browserService.getBrowserService()),
        new SendPartnerNoteTool(
          collaborationService.getCollaborationService(),
        ),
        new ListGatewaySessionsTool(
          collaborationService.getGatewaySessionsService(),
        ),
        new SendPartnerFileTool(
          collaborationService.getSendPartnerFileService(),
        ),
        new ListXchangeRecordsTool(xchangeService.getXchangeService()),
        new GetXchangeRecordTool(xchangeService.getXchangeService()),
        new MarkXchangeRecordReadTool(xchangeService.getXchangeService()),
        new RefreshToolsMarkdownTool(
          toolsSyncService.getRefreshToolsMarkdownService(),
        ),
      ];

      return createMcpServer(tools);
    },
  },

  async started(this: McpServerCarrier) {
    await this.broker.waitForServices([
      TELEGRAM_MCP_SESSION_CONTEXT_SERVICE_NAME,
      TELEGRAM_MCP_NOTIFY_SERVICE_NAME,
      TELEGRAM_MCP_APPROVAL_SERVICE_NAME,
      TELEGRAM_MCP_BROWSER_SERVICE_NAME,
      TELEGRAM_MCP_COLLABORATION_SERVICE_NAME,
      TELEGRAM_MCP_TOOLS_SYNC_SERVICE_NAME,
      TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
    ]);

    this.logger.info("telegram_mcp MCP server service is ready");
  },
};

export default TelegramMcpMcpServerService;
