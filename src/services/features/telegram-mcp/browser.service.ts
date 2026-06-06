import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { FirefoxAttachServer } from "./src/features/browser-attach/model/firefoxAttachServer";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import type {
  BrowserClearLogsInput,
  BrowserClickInput,
  BrowserCloseInput,
  BrowserComputedStyleInput,
  BrowserConsoleInput,
  BrowserDomInput,
  BrowserErrorsInput,
  BrowserFillInput,
  BrowserInjectScriptInput,
  BrowserListAttachedInstancesInput,
  BrowserListTabsInput,
  BrowserRecordingStartInput,
  BrowserRecordingStatusInput,
  BrowserRecordingStopInput,
  BrowserNetworkFailuresInput,
  BrowserOpenInput,
  BrowserPressInput,
  BrowserReloadInput,
  BrowserScreenshotInput,
  BrowserWaitForInput,
  BrowserWaitForUrlInput,
} from "./src/entities/browser/model/types";
import { BrowserService } from "./src/features/browser/model/browserService";

export const TELEGRAM_MCP_BROWSER_SERVICE_NAME = "telegramMcp.browser";

export type TelegramMcpBrowserServiceInstance = Service & {
  browserService: BrowserService | null;
  getBrowserService: () => BrowserService;
};

type BrowserServiceCarrier = Service & {
  browserService?: BrowserService | null;
  getBrowserService?: () => BrowserService;
};

const TelegramMcpBrowserService: ServiceSchema = {
  name: TELEGRAM_MCP_BROWSER_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    openRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserOpenInput },
      ) {
        return this.getBrowserService!().open(ctx.params);
      },
    },
    getConsoleRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserConsoleInput },
      ) {
        return this.getBrowserService!().getConsole(ctx.params);
      },
    },
    listAttachedInstancesRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserListAttachedInstancesInput },
      ) {
        return this.getBrowserService!().listAttachedInstances(ctx.params);
      },
    },
    listTabsRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserListTabsInput },
      ) {
        return this.getBrowserService!().listTabs(ctx.params);
      },
    },
    startRecordingRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserRecordingStartInput },
      ) {
        return this.getBrowserService!().startRecording(ctx.params);
      },
    },
    stopRecordingRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserRecordingStopInput },
      ) {
        return this.getBrowserService!().stopRecording(ctx.params);
      },
    },
    getRecordingStatusRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserRecordingStatusInput },
      ) {
        return this.getBrowserService!().getRecordingStatus(ctx.params);
      },
    },
    clickRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserClickInput },
      ) {
        return this.getBrowserService!().click(ctx.params);
      },
    },
    fillRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserFillInput },
      ) {
        return this.getBrowserService!().fill(ctx.params);
      },
    },
    injectScriptRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserInjectScriptInput },
      ) {
        return this.getBrowserService!().injectScript(ctx.params);
      },
    },
    pressRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserPressInput },
      ) {
        return this.getBrowserService!().press(ctx.params);
      },
    },
    reloadRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserReloadInput },
      ) {
        return this.getBrowserService!().reload(ctx.params);
      },
    },
    waitForRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserWaitForInput },
      ) {
        return this.getBrowserService!().waitFor(ctx.params);
      },
    },
    waitForUrlRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserWaitForUrlInput },
      ) {
        return this.getBrowserService!().waitForUrl(ctx.params);
      },
    },
    getErrorsRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserErrorsInput },
      ) {
        return this.getBrowserService!().getErrors(ctx.params);
      },
    },
    getNetworkFailuresRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserNetworkFailuresInput },
      ) {
        return this.getBrowserService!().getNetworkFailures(ctx.params);
      },
    },
    clearLogsRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserClearLogsInput },
      ) {
        return this.getBrowserService!().clearLogs(ctx.params);
      },
    },
    getDomRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserDomInput },
      ) {
        return this.getBrowserService!().getDom(ctx.params);
      },
    },
    getComputedStyleRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserComputedStyleInput },
      ) {
        return this.getBrowserService!().getComputedStyle(ctx.params);
      },
    },
    screenshotRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserScreenshotInput },
      ) {
        return this.getBrowserService!().screenshot(ctx.params);
      },
    },
    closeRemote: {
      params: { $$strict: false },
      async handler(
        this: BrowserServiceCarrier,
        ctx: { params: BrowserCloseInput },
      ) {
        return this.getBrowserService!().close(ctx.params);
      },
    },
  },

  created(this: BrowserServiceCarrier) {
    this.browserService = null;
  },

  methods: {
    getBrowserService(this: BrowserServiceCarrier): BrowserService {
      if (!this.browserService) {
        throw new Error("telegram_mcp browser service is not initialized yet");
      }

      return this.browserService;
    },
  },

  async started(this: BrowserServiceCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = await runtimeService.waitUntilReady();

    this.logger.info("Starting telegram_mcp browser service");
    const firefoxAttachServer = runtime.firefoxAttachServer as FirefoxAttachServer;
    this.browserService = new BrowserService(
      runtime.config,
      runtime.sessionStore,
      runtime.maintenanceStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.objectStore,
      runtime.telegramTransport,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
      firefoxAttachServer,
    );
    this.logger.info("telegram_mcp browser service is ready");
  },

  async stopped(this: BrowserServiceCarrier) {
    if (!this.browserService) {
      return;
    }

    const browserService = this.browserService;
    this.browserService = null;
    this.logger.info("Stopping telegram_mcp browser service");
    await browserService.shutdown();
  },
};

export default TelegramMcpBrowserService;
