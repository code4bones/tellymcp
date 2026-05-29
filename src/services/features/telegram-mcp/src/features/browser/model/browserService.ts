import path from "node:path";

import type {
  Browser,
  BrowserContextOptions,
  BrowserContext,
  ConsoleMessage,
  Locator,
  Page,
  Response,
  Request,
} from "playwright";

import type { AppConfig } from "../../../app/config/env";
import type {
  BrowserCloseInput,
  BrowserCloseOutput,
  BrowserComputedStyleInput,
  BrowserComputedStyleOutput,
  BrowserClickInput,
  BrowserClickOutput,
  BrowserConsoleInput,
  BrowserConsoleOutput,
  BrowserDomInput,
  BrowserDomOutput,
  BrowserErrorsInput,
  BrowserErrorsOutput,
  BrowserFillInput,
  BrowserFillOutput,
  BrowserLocatorInput,
  BrowserNetworkFailuresInput,
  BrowserNetworkFailuresOutput,
  BrowserOpenInput,
  BrowserOpenOutput,
  BrowserPressInput,
  BrowserPressOutput,
  BrowserWaitForInput,
  BrowserWaitForOutput,
  BrowserWaitForUrlInput,
  BrowserWaitForUrlOutput,
  BrowserClearLogsInput,
  BrowserClearLogsOutput,
  BrowserReloadInput,
  BrowserReloadOutput,
  BrowserScreenshotInput,
  BrowserScreenshotOutput,
} from "../../../entities/browser/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  MaintenanceStore,
  SessionBindingStore,
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import { MinioExchangeStore } from "../../../shared/integrations/object-storage/minioExchangeStore";
import { TelegramTransport } from "../../../shared/integrations/telegram/transport";
import {
  callGatewayJson,
  ensureGatewayClientUuid,
} from "../../distributed-client/model/gatewayClientAccess";

type WaitUntilState = "load" | "domcontentloaded" | "networkidle" | "commit";

type BrowserConsoleRecord = {
  type: string;
  text: string;
  location?: string | undefined;
  timestamp: string;
};

type BrowserPageErrorRecord = {
  message: string;
  stack?: string | undefined;
  timestamp: string;
};

type BrowserNetworkFailureRecord = {
  url: string;
  method: string;
  status?: number | undefined;
  errorText?: string | undefined;
  resourceType?: string | undefined;
  timestamp: string;
};

type BrowserSessionState = {
  context: BrowserContext;
  page: Page;
  currentUrl?: string | undefined;
  title?: string | undefined;
  createdAt: string;
  lastUsedAt: string;
  consoleMessages: BrowserConsoleRecord[];
  pageErrors: BrowserPageErrorRecord[];
  networkFailures: BrowserNetworkFailureRecord[];
};

type PlaywrightModule = typeof import("playwright");

type BrowserDomSnapshot = {
  found: boolean;
  outerHtml?: string | undefined;
  textContent?: string | undefined;
  visible?: boolean | undefined;
  attributes?: Record<string, string> | undefined;
};

type BrowserStyleSnapshot = {
  found: boolean;
  visible?: boolean | undefined;
  styles?: Record<string, string> | undefined;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

function pushBounded<T>(list: T[], entry: T, max: number): void {
  list.push(entry);
  if (list.length > max) {
    list.splice(0, list.length - max);
  }
}

function trimList<T>(list: T[], limit?: number): T[] {
  if (!limit || limit <= 0 || limit >= list.length) {
    return [...list];
  }

  return list.slice(-limit);
}

function sanitizeScreenshotName(fileName?: string): string {
  const trimmed = fileName?.trim();
  if (!trimmed) {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    return `browser-screenshot-${timestamp}.png`;
  }

  const parsed = path.parse(trimmed);
  const base = parsed.name.trim() || "browser-screenshot";
  const extension = parsed.ext.toLowerCase() === ".png" ? ".png" : ".png";
  return `${base}${extension}`;
}

function buildDatedRelativePath(fileName: string, date = new Date()): string {
  const dateSegment = date.toISOString().slice(0, 10);
  const timeSegment = date.toTimeString().slice(0, 8).replace(/:/gu, "-");
  return `${dateSegment}/${timeSegment}/${fileName}`;
}

function isAbsoluteBrowserUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value) || value.startsWith("data:");
}

function formatConsoleLocation(message: ConsoleMessage): string | undefined {
  const location = message.location();
  if (!location.url && !location.lineNumber && !location.columnNumber) {
    return undefined;
  }

  return `${location.url || "unknown"}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`;
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

const DEFAULT_BROWSER_VIEWPORT_WIDTH = 1720;
const DEFAULT_BROWSER_VIEWPORT_HEIGHT = 980;

export class BrowserService {
  private playwrightModulePromise: Promise<PlaywrightModule> | undefined;

  private browserPromise: Promise<Browser> | undefined;

  private readonly sessionStates = new Map<string, BrowserSessionState>();

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly objectStore: MinioExchangeStore,
    private readonly telegramTransport: TelegramTransport,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async open(input: BrowserOpenInput): Promise<BrowserOpenOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserOpenOutput>(
      normalizedSessionId,
      "telegramMcp.browser.openRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const existingState = this.sessionStates.get(normalizedSessionId);
    const requestedViewport = this.resolveRequestedViewport(input);
    const shouldUpgradeLegacyViewport =
      this.config.browser.headless === false &&
      input.reset_context !== true &&
      !requestedViewport &&
      Boolean(existingState?.page.viewportSize());
    const shouldReset =
      input.reset_context === true || shouldUpgradeLegacyViewport;
    const targetUrl = this.resolveBrowserUrl(input.url);

    if (shouldReset && existingState) {
      await this.closeState(normalizedSessionId, existingState);
    }

    const { state, createdContext } = await this.ensureSessionState(
      normalizedSessionId,
      shouldReset,
      input,
    );
    if (requestedViewport) {
      await state.page.setViewportSize(requestedViewport);
    } else if (this.config.browser.headless !== false) {
      await state.page.setViewportSize({
        width: DEFAULT_BROWSER_VIEWPORT_WIDTH,
        height: DEFAULT_BROWSER_VIEWPORT_HEIGHT,
      });
    }
    const waitUntil = (input.wait_until ??
      this.config.browser.waitUntil) as WaitUntilState;

    await state.page.goto(targetUrl, {
      waitUntil,
      timeout: this.config.browser.timeoutMs,
    });

    state.currentUrl = state.page.url();
    state.title = await state.page.title();
    state.lastUsedAt = new Date().toISOString();

    this.logger.info("Browser page opened", {
      sessionId: resolved.sessionId,
      normalizedSessionId,
      url: state.currentUrl,
      title: state.title,
      createdContext,
      waitUntil,
      headless: this.config.browser.headless,
      viewportWidth:
        state.page.viewportSize()?.width ?? requestedViewport?.width,
      viewportHeight:
        state.page.viewportSize()?.height ?? requestedViewport?.height,
    });

    const viewport = state.page.viewportSize();
    return {
      session_id: normalizedSessionId,
      opened: true,
      created_context: createdContext,
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
      ...(viewport?.width ? { viewport_width: viewport.width } : {}),
      ...(viewport?.height ? { viewport_height: viewport.height } : {}),
    };
  }

  public async getConsole(
    input: BrowserConsoleInput,
  ): Promise<BrowserConsoleOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserConsoleOutput>(
      normalizedSessionId,
      "telegramMcp.browser.getConsoleRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);

    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      total: state.consoleMessages.length,
      messages: trimList(state.consoleMessages, input.limit).map((message) => ({
        type: message.type,
        text: message.text,
        ...(message.location ? { location: message.location } : {}),
        timestamp: message.timestamp,
      })),
    };
  }

  public async click(input: BrowserClickInput): Promise<BrowserClickOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserClickOutput>(
      normalizedSessionId,
      "telegramMcp.browser.clickRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const locator = this.resolveLocator(state.page, input);
    await locator.click({
      timeout: this.resolveTimeoutMs(input.timeout_ms),
    });

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      clicked: true,
      ...(input.ai_tag ? { ai_tag: input.ai_tag } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.text ? { text: input.text } : {}),
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async fill(input: BrowserFillInput): Promise<BrowserFillOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserFillOutput>(
      normalizedSessionId,
      "telegramMcp.browser.fillRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const locator = this.resolveLocator(state.page, input);
    await locator.fill(input.value, {
      timeout: this.resolveTimeoutMs(input.timeout_ms),
    });

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      filled: true,
      ...(input.ai_tag ? { ai_tag: input.ai_tag } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.text ? { text: input.text } : {}),
      value_length: input.value.length,
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async press(input: BrowserPressInput): Promise<BrowserPressOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserPressOutput>(
      normalizedSessionId,
      "telegramMcp.browser.pressRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);

    if (input.selector || input.text) {
      const locator = this.resolveLocator(state.page, input);
      await locator.press(input.key, {
        timeout: this.resolveTimeoutMs(input.timeout_ms),
      });
    } else {
      await state.page.keyboard.press(input.key);
    }

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      pressed: true,
      key: input.key,
      ...(input.ai_tag ? { ai_tag: input.ai_tag } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.text ? { text: input.text } : {}),
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async reload(
    input: BrowserReloadInput,
  ): Promise<BrowserReloadOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserReloadOutput>(
      normalizedSessionId,
      "telegramMcp.browser.reloadRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const waitUntil = (input.wait_until ??
      this.config.browser.waitUntil) as WaitUntilState;

    await state.page.reload({
      waitUntil,
      timeout: this.config.browser.timeoutMs,
    });

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    this.logger.info("Browser page reloaded", {
      sessionId,
      url: state.currentUrl,
      title: state.title,
      waitUntil,
    });

    return {
      session_id: sessionId,
      reloaded: true,
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async waitFor(
    input: BrowserWaitForInput,
  ): Promise<BrowserWaitForOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserWaitForOutput>(
      normalizedSessionId,
      "telegramMcp.browser.waitForRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const locator = this.resolveLocator(state.page, input);
    const waitState = input.state ?? "visible";

    await locator.waitFor({
      state: waitState,
      timeout: this.resolveTimeoutMs(input.timeout_ms),
    });

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      waited: true,
      state: waitState,
      ...(input.ai_tag ? { ai_tag: input.ai_tag } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.text ? { text: input.text } : {}),
      url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async waitForUrl(
    input: BrowserWaitForUrlInput,
  ): Promise<BrowserWaitForUrlOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserWaitForUrlOutput>(
      normalizedSessionId,
      "telegramMcp.browser.waitForUrlRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const timeout = this.resolveTimeoutMs(input.timeout_ms);

    if (input.url?.trim()) {
      await state.page.waitForURL(input.url.trim(), {
        timeout,
      });
    } else if (input.url_contains?.trim()) {
      const expected = input.url_contains.trim();
      await state.page.waitForURL(
        (value) => value.toString().includes(expected),
        {
          timeout,
        },
      );
    } else {
      throw new Error("Browser URL target is missing. Provide url or url_contains.");
    }

    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      waited: true,
      matched: input.url?.trim() ? "url" : "url_contains",
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...(input.url_contains?.trim()
        ? { url_contains: input.url_contains.trim() }
        : {}),
      current_url: state.currentUrl,
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async getErrors(
    input: BrowserErrorsInput,
  ): Promise<BrowserErrorsOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserErrorsOutput>(
      normalizedSessionId,
      "telegramMcp.browser.getErrorsRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);

    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      total: state.pageErrors.length,
      errors: trimList(state.pageErrors, input.limit).map((error) => ({
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        timestamp: error.timestamp,
      })),
    };
  }

  public async getNetworkFailures(
    input: BrowserNetworkFailuresInput,
  ): Promise<BrowserNetworkFailuresOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserNetworkFailuresOutput>(
      normalizedSessionId,
      "telegramMcp.browser.getNetworkFailuresRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);

    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      total: state.networkFailures.length,
      failures: trimList(state.networkFailures, input.limit).map((failure) => ({
        url: failure.url,
        method: failure.method,
        ...(typeof failure.status === "number" ? { status: failure.status } : {}),
        ...(failure.errorText ? { error_text: failure.errorText } : {}),
        ...(failure.resourceType
          ? { resource_type: failure.resourceType }
          : {}),
        timestamp: failure.timestamp,
      })),
    };
  }

  public async clearLogs(
    input: BrowserClearLogsInput,
  ): Promise<BrowserClearLogsOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserClearLogsOutput>(
      normalizedSessionId,
      "telegramMcp.browser.clearLogsRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const consoleMessagesCleared = state.consoleMessages.length;
    const pageErrorsCleared = state.pageErrors.length;
    const networkFailuresCleared = state.networkFailures.length;

    state.consoleMessages = [];
    state.pageErrors = [];
    state.networkFailures = [];
    state.lastUsedAt = new Date().toISOString();

    return {
      session_id: sessionId,
      cleared: true,
      console_messages_cleared: consoleMessagesCleared,
      page_errors_cleared: pageErrorsCleared,
      network_failures_cleared: networkFailuresCleared,
    };
  }

  public async getDom(input: BrowserDomInput): Promise<BrowserDomOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserDomOutput>(
      normalizedSessionId,
      "telegramMcp.browser.getDomRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const selector = input.selector?.trim() || "body";
    const snapshot: BrowserDomSnapshot = await state.page
      .locator(selector)
      .first()
      .evaluate((element, payload) => {
        const htmlRequested = payload.includeHtml;
        const textRequested = payload.includeText;
        const computed = (
          globalThis as unknown as { getComputedStyle: (node: unknown) => any }
        ).getComputedStyle(element);
        const attributes = Object.fromEntries(
          Array.from((element as { attributes: ArrayLike<unknown> }).attributes).map((attribute) => [
            (attribute as { name: string }).name,
            (attribute as { value: string }).value,
          ]),
        );

        return {
          found: true,
          ...(htmlRequested
            ? { outerHtml: (element as { outerHTML: string }).outerHTML }
            : {}),
          ...(textRequested
            ? {
                textContent:
                  (element as { textContent?: string | null }).textContent?.trim() ??
                  "",
              }
            : {}),
          visible:
            computed.display !== "none" &&
            computed.visibility !== "hidden" &&
            computed.opacity !== "0",
          attributes,
        };
      }, {
        includeHtml: input.include_html !== false,
        includeText: input.include_text !== false,
      })
      .catch(() => ({ found: false } as BrowserDomSnapshot));

    state.lastUsedAt = new Date().toISOString();
    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);

    return {
      session_id: sessionId,
      selector,
      found: snapshot.found,
      ...(state.currentUrl ? { url: state.currentUrl } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(snapshot.outerHtml ? { outer_html: snapshot.outerHtml } : {}),
      ...(typeof snapshot.textContent === "string"
        ? { text_content: snapshot.textContent }
        : {}),
      ...(typeof snapshot.visible === "boolean"
        ? { visible: snapshot.visible }
        : {}),
      ...(snapshot.attributes ? { attributes: snapshot.attributes } : {}),
    };
  }

  public async getComputedStyle(
    input: BrowserComputedStyleInput,
  ): Promise<BrowserComputedStyleOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserComputedStyleOutput>(
      normalizedSessionId,
      "telegramMcp.browser.getComputedStyleRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state } = await this.requireSessionState(input);
    const properties = input.properties?.length
      ? input.properties
      : [
          "display",
          "position",
          "visibility",
          "opacity",
          "color",
          "background-color",
          "font-size",
          "z-index",
          "overflow",
        ];

    const snapshot: BrowserStyleSnapshot = await state.page
      .locator(input.selector)
      .first()
      .evaluate((element, requestedProperties) => {
        const computed = (
          globalThis as unknown as { getComputedStyle: (node: unknown) => any }
        ).getComputedStyle(element);
        const rect = (element as { getBoundingClientRect: () => { x: number; y: number; width: number; height: number } }).getBoundingClientRect();
        const styles = Object.fromEntries(
          requestedProperties.map((property) => [
            property,
            computed.getPropertyValue(property),
          ]),
        );

        return {
          found: true,
          visible:
            computed.display !== "none" &&
            computed.visibility !== "hidden" &&
            computed.opacity !== "0",
          styles,
          box: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      }, properties)
      .catch(() => ({ found: false } as BrowserStyleSnapshot));

    state.lastUsedAt = new Date().toISOString();
    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);

    return {
      session_id: sessionId,
      selector: input.selector,
      found: snapshot.found,
      ...(state.currentUrl ? { url: state.currentUrl } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(typeof snapshot.visible === "boolean"
        ? { visible: snapshot.visible }
        : {}),
      ...(snapshot.styles ? { styles: snapshot.styles } : {}),
      ...(snapshot.box ? { box: snapshot.box } : {}),
    };
  }

  public async screenshot(
    input: BrowserScreenshotInput,
  ): Promise<BrowserScreenshotOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserScreenshotOutput>(
      normalizedSessionId,
      "telegramMcp.browser.screenshotRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const { sessionId, state, session } = await this.requireSessionState(input);
    const fileName = sanitizeScreenshotName(input.file_name);
    const pngBuffer = input.selector?.trim()
      ? await state.page
          .locator(input.selector)
          .first()
          .screenshot({
            type: "png",
            timeout: this.config.browser.timeoutMs,
          })
      : await state.page.screenshot({
          type: "png",
          fullPage: input.full_page === true,
          timeout: this.config.browser.timeoutMs,
        });

    const workspaceDir = this.objectStore.resolveWorkspaceDir(session);
    const exchangeDir = path.resolve(workspaceDir, this.config.exchange.dir);
    const storedFile = await this.objectStore.storeFile({
      session,
      sessionId,
      source: "browser-screenshot",
      relativePath: buildDatedRelativePath(fileName),
      content: pngBuffer,
      mimeType: "image/png",
    });
    const filePath = storedFile.filePath;

    state.lastUsedAt = new Date().toISOString();
    state.currentUrl = state.page.url();
    state.title = await state.page.title().catch(() => state.title);

    this.logger.info("Browser screenshot captured", {
      sessionId,
      filePath,
      selector: input.selector,
      fullPage: input.full_page === true,
    });

    await this.xchangeFileMetaStore.setXchangeFileMeta({
      sessionId,
      filePath,
      relativePath: storedFile.relativePath,
      source: "browser-screenshot",
      uploadedAt: new Date().toISOString(),
      storageRef: storedFile.storageRef,
      bucketName: storedFile.bucketName,
      objectName: storedFile.objectName,
      vfsNodeId: storedFile.vfsNodeId,
      vfsPublicUrl: storedFile.vfsPublicUrl,
      vfsParentId: storedFile.vfsParentId,
      mimeType: "image/png",
      sizeBytes: storedFile.sizeBytes,
      ...(input.caption ? { caption: input.caption } : {}),
    });

    let telegramMessageId: number | undefined;
    if (input.send_to_telegram === true) {
      if (this.config.distributed.mode === "client") {
        telegramMessageId = await this.sendScreenshotToGatewayTelegramRoute({
          sessionId,
          fileName,
          pngBuffer,
          ...(input.caption ? { caption: input.caption } : {}),
        });
      } else {
        const binding = await this.bindingStore.getBinding(sessionId);
        if (!binding) {
          throw new Error(
            "Session is not linked to Telegram, so screenshot cannot be sent there.",
          );
        }

        const sent = await this.telegramTransport.sendDocumentToChat(
          binding.telegramChatId,
          filePath,
          input.caption,
        );
        telegramMessageId = sent.messageId;
      }
    }

    return {
      session_id: sessionId,
      file_path: filePath,
      workspace_dir: workspaceDir,
      exchange_dir: exchangeDir,
      ...(typeof telegramMessageId === "number"
        ? { telegram_message_id: telegramMessageId }
        : {}),
      ...(state.currentUrl ? { url: state.currentUrl } : {}),
      ...(state.title ? { title: state.title } : {}),
    };
  }

  public async close(input: BrowserCloseInput): Promise<BrowserCloseOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const normalizedSessionId = await this.normalizeSessionIdForAccess(
      resolved.sessionId,
    );
    const remote = await this.invokeRemote<BrowserCloseOutput>(
      normalizedSessionId,
      "telegramMcp.browser.closeRemote",
      {
        ...input,
        session_id: normalizedSessionId,
      },
    );
    if (remote) {
      return remote;
    }
    this.ensureEnabled();
    const state = this.sessionStates.get(normalizedSessionId);

    if (state) {
      await this.closeState(normalizedSessionId, state);
    }

    return {
      session_id: normalizedSessionId,
      closed: Boolean(state),
    };
  }

  public async shutdown(): Promise<void> {
    for (const [sessionId, state] of this.sessionStates.entries()) {
      await this.closeState(sessionId, state);
    }

    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        await browser.close();
      } catch (error) {
        this.logger.warn("Browser shutdown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.browserPromise = undefined;
      }
    }
  }

  private async ensurePlaywright(): Promise<PlaywrightModule> {
    this.playwrightModulePromise ??= import("playwright");
    return this.playwrightModulePromise;
  }

  private async ensureBrowser(): Promise<Browser> {
    this.browserPromise ??= (async () => {
      const playwright = await this.ensurePlaywright();
      const launchArgs: string[] = [];
      if (this.config.browser.headless === false) {
        launchArgs.push("--start-maximized");
        if (this.config.browser.devtools === true) {
          launchArgs.push("--auto-open-devtools-for-tabs");
        }
      }
      const browser = await playwright.chromium.launch({
        headless: this.config.browser.headless,
        slowMo: this.config.browser.slowMoMs,
        ...(launchArgs.length ? { args: launchArgs } : {}),
        ...(this.config.browser.executablePath
          ? { executablePath: this.config.browser.executablePath }
          : {}),
        ...(this.config.browser.channel
          ? { channel: this.config.browser.channel }
          : {}),
      });

      this.logger.info("Browser runtime launched", {
        headless: this.config.browser.headless,
        devtools:
          this.config.browser.headless === false &&
          this.config.browser.devtools === true,
        slowMoMs: this.config.browser.slowMoMs,
        channel: this.config.browser.channel,
        executablePath: this.config.browser.executablePath,
      });

      return browser;
    })();

    return this.browserPromise;
  }

  private async ensureSessionState(
    sessionId: string,
    forceNewContext: boolean,
    openInput?: BrowserOpenInput,
  ): Promise<{ state: BrowserSessionState; createdContext: boolean }> {
    const existing = this.sessionStates.get(sessionId);
    if (existing && !forceNewContext) {
      return { state: existing, createdContext: false };
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext(
      this.buildContextOptions(openInput),
    );
    const page = await context.newPage();
    const createdAt = new Date().toISOString();
    const state: BrowserSessionState = {
      context,
      page,
      createdAt,
      lastUsedAt: createdAt,
      consoleMessages: [],
      pageErrors: [],
      networkFailures: [],
    };

    page.on("console", (message) => {
      pushBounded(
        state.consoleMessages,
        {
          type: message.type(),
          text: message.text(),
          ...(formatConsoleLocation(message)
            ? { location: formatConsoleLocation(message) }
            : {}),
          timestamp: new Date().toISOString(),
        },
        this.config.browser.maxEvents,
      );
    });

    page.on("pageerror", (error) => {
      pushBounded(
        state.pageErrors,
        {
          message: error.message,
          ...(error.stack ? { stack: error.stack } : {}),
          timestamp: new Date().toISOString(),
        },
        this.config.browser.maxEvents,
      );
    });

    page.on("requestfailed", (request) => {
      this.recordNetworkFailure(state, request, undefined);
    });

    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.recordNetworkFailure(state, response.request(), response);
      }
    });

    this.sessionStates.set(sessionId, state);
    return { state, createdContext: true };
  }

  private resolveRequestedViewport(
    input?: Pick<BrowserOpenInput, "width" | "height">,
  ): { width: number; height: number } | null {
    const width = input?.width;
    const height = input?.height;
    if (!width && !height) {
      return null;
    }
    if (!width || !height) {
      throw new Error(
        "Browser viewport requires both width and height together.",
      );
    }
    return { width, height };
  }

  private buildContextOptions(
    input?: Pick<BrowserOpenInput, "width" | "height">,
  ): BrowserContextOptions {
    const requestedViewport = this.resolveRequestedViewport(input);
    if (requestedViewport) {
      return {
        viewport: requestedViewport,
        screen: requestedViewport,
      };
    }
    if (this.config.browser.headless === false) {
      return {
        viewport: null,
      };
    }
    return {};
  }

  private recordNetworkFailure(
    state: BrowserSessionState,
    request: Request,
    response?: Response,
  ): void {
    const failure = request.failure();
    pushBounded(
      state.networkFailures,
      {
        url: request.url(),
        method: request.method(),
        ...(typeof response?.status() === "number"
          ? { status: response.status() }
          : {}),
        ...(failure?.errorText ? { errorText: failure.errorText } : {}),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      },
      this.config.browser.maxEvents,
    );
  }

  private async requireSessionState(
    input:
      | BrowserReloadInput
      | BrowserConsoleInput
      | BrowserClickInput
      | BrowserClearLogsInput
      | BrowserErrorsInput
      | BrowserFillInput
      | BrowserNetworkFailuresInput
      | BrowserPressInput
      | BrowserDomInput
      | BrowserComputedStyleInput
      | BrowserWaitForInput
      | BrowserWaitForUrlInput
      | BrowserScreenshotInput,
  ): Promise<{
    sessionId: string;
    session: SessionContext | null;
    state: BrowserSessionState;
  }> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForAccess(resolved.sessionId);
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      throw new Error(
        "Browser session is not open. Call browser_open first for this session.",
      );
    }

    const session = await this.sessionStore.getSession(sessionId);
    return {
      sessionId,
      session,
      state,
    };
  }

  private resolveWorkspaceDir(session: SessionContext | null): string {
    const workspaceDir = session?.cwd?.trim();
    if (!workspaceDir) {
      throw new Error("Workspace cwd is not registered for this browser console.");
    }
    return workspaceDir;
  }

  private async invokeRemote<T>(
    sessionId: string,
    actionName: string,
    input: Record<string, unknown>,
  ): Promise<T | undefined> {
    if (this.config.distributed.mode === "client") {
      return undefined;
    }
    return await this.remoteConsoleInvoker?.invokeForRelaySession<T>(
      sessionId,
      actionName,
      input,
    );
  }

  private async normalizeSessionIdForAccess(sessionId: string): Promise<string> {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return trimmed;
    }

    const direct = await this.sessionStore.getSession(trimmed);
    if (direct) {
      return trimmed;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      return trimmed;
    }

    const localClientUuid = await this.maintenanceStore.getGatewayClientUuid();
    const clientUuid = trimmed.slice(0, separatorIndex).trim();
    const localSessionId = trimmed.slice(separatorIndex + 1).trim();
    if (!localClientUuid || clientUuid !== localClientUuid || !localSessionId) {
      return trimmed;
    }

    const localSession = await this.sessionStore.getSession(localSessionId);
    return localSession ? localSessionId : trimmed;
  }

  private async sendScreenshotToGatewayTelegramRoute(input: {
    sessionId: string;
    fileName: string;
    pngBuffer: Buffer;
    caption?: string;
  }): Promise<number | undefined> {
    if (!this.config.distributed.gatewayPublicUrl) {
      throw new Error(
        "send_to_telegram on client nodes requires GATEWAY_PUBLIC_URL.",
      );
    }

    const clientUuid = await ensureGatewayClientUuid({
      maintenanceStore: this.maintenanceStore,
      gatewayPublicUrl: this.config.distributed.gatewayPublicUrl,
      ...(this.config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this.config.distributed.gatewayAuthToken }
        : {}),
      ...(this.config.distributed.gatewayToken
        ? { gatewayToken: this.config.distributed.gatewayToken }
        : {}),
      ...(this.config.project.name
        ? { projectName: this.config.project.name }
        : {}),
      ...(this.config.telegram.botUsername
        ? { botUsername: this.config.telegram.botUsername }
        : {}),
      ...(this.config.distributed.gatewayUserUuid
        ? { gatewayUserUuid: this.config.distributed.gatewayUserUuid }
        : {}),
    });

    const output = await callGatewayJson<{
      sent?: boolean;
      message_id?: number;
    }>({
      gatewayPublicUrl: this.config.distributed.gatewayPublicUrl,
      ...(this.config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this.config.distributed.gatewayAuthToken }
        : {}),
      endpointPath: "/transport/document",
      body: {
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        file_name: input.fileName,
        content_base64: input.pngBuffer.toString("base64"),
        ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
      },
    });

    if (!output.sent) {
      throw new Error(
        "Gateway did not confirm Telegram document delivery for the screenshot.",
      );
    }

    return typeof output.message_id === "number" ? output.message_id : undefined;
  }

  private ensureEnabled(): void {
    if (!this.config.browser.enabled) {
      throw new Error(
        "Browser tools are disabled. Enable them with BROWSER_ENABLED=true.",
      );
    }
  }

  private resolveLocator(
    page: Page,
    input: BrowserLocatorInput,
  ): Locator {
    if (input.ai_tag?.trim()) {
      const aiTag = escapeCssAttributeValue(input.ai_tag.trim());
      return page
        .locator(`[data-drive-tag="${aiTag}"], [ai-tag="${aiTag}"]`)
        .first();
    }

    if (input.selector?.trim()) {
      return page.locator(input.selector.trim()).first();
    }

    if (input.text?.trim()) {
      return page.getByText(input.text.trim(), {
        exact: input.exact === true,
      }).first();
    }

    throw new Error(
      "Browser target is missing. Provide ai_tag, selector, or text.",
    );
  }

  private resolveTimeoutMs(timeoutMs?: number): number {
    return timeoutMs && timeoutMs > 0
      ? timeoutMs
      : this.config.browser.timeoutMs;
  }

  private resolveBrowserUrl(inputUrl: string): string {
    const trimmed = inputUrl.trim();
    if (isAbsoluteBrowserUrl(trimmed)) {
      return trimmed;
    }

    if (!this.config.browser.address) {
      throw new Error(
        "BROWSER_ADDRESS is not configured, so browser_open requires an absolute URL.",
      );
    }

    return new URL(trimmed, this.config.browser.address).toString();
  }

  private async closeState(
    sessionId: string,
    state: BrowserSessionState,
  ): Promise<void> {
    this.sessionStates.delete(sessionId);
    await state.context.close();
    this.logger.info("Browser session context closed", {
      sessionId,
      currentUrl: state.currentUrl,
      title: state.title,
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
    });
  }
}
