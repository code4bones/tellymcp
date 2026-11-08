import { randomUUID } from "node:crypto";

import * as wsModule from "ws";

import type { AppConfig } from "../../../app/config/env";
import type { BrowserRecordingRecord } from "../../../entities/browser/model/types";
import type {
  MaintenanceStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { formatLocalTimestamp } from "../../../shared/lib/time/localTimestamp";
import { MAX_BODY_SIZE_BYTES } from "../../../shared/lib/bodyLimits";
import {
  BrowserRecordingBundleWriter,
  type ActiveBrowserRecordingState,
} from "./browserRecordingBundle";
import {
  BrowserAttachRegistry,
  type FirefoxAttachInstanceRecord,
} from "./browserAttachRegistry";
import { firefoxAttachInboundMessageSchema } from "./types";
import { BrowserPickerDelivery } from "./browserPickerDelivery";
import { TerminalInputService } from "../../terminal-input/model/terminalInputService";
import type {
  FirefoxAttachGetActiveTabRequest,
  FirefoxAttachInboundMessage,
  FirefoxAttachInstanceHello,
  FirefoxAttachListTabsRequest,
  FirefoxAttachManualRecordingResult,
  FirefoxAttachRecordingStateEvent,
  FirefoxAttachOutboundMessage,
  FirefoxAttachRecordingControlResult,
  FirefoxAttachRecordingStartRequest,
  FirefoxAttachRecordingStopRequest,
  FirefoxAttachTabActionRequest,
  FirefoxAttachTabActionResult,
} from "./types";

type FirefoxAttachSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (
    event: "close" | "message" | "error",
    listener: (payload?: unknown) => void,
  ) => void;
};

type FirefoxAttachWebSocketServer = {
  on(event: "connection", listener: (socket: FirefoxAttachSocket) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  close: (callback: (error?: unknown) => void) => void;
};

type FirefoxAttachVerifyClientInfo = {
  origin?: string | undefined;
};

const wsLib = wsModule as unknown as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (options: Record<string, unknown>) => FirefoxAttachWebSocketServer;
};

const WebSocketServer = wsLib.WebSocketServer;
const WS_OPEN = wsLib.WebSocket.OPEN;

type ConnectedSocketState = {
  socket: FirefoxAttachSocket;
  instanceId?: string | undefined;
  lastSeenAt: number;
  rateWindowStartedAt: number;
  rateWindowMessageCount: number;
  protocolFailed: boolean;
};

type PendingTabAction = {
  instanceId: string;
  resolve: (value: FirefoxAttachTabActionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingRecordingControl = {
  instanceId: string;
  resolve: (value: FirefoxAttachRecordingControlResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const ATTACH_HEARTBEAT_TIMEOUT_MS = 45_000;
const ATTACH_HEARTBEAT_REAP_INTERVAL_MS = 15_000;
const ATTACH_RATE_WINDOW_MS = 1_000;
const RECORDING_PERSIST_INTERVAL_MS = 1_000;
const ATTACH_RATE_MAX_MESSAGES = 1_000;

class BrowserAttachProtocolError extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
    this.name = "BrowserAttachProtocolError";
  }
}

const isAllowedAttachOrigin = (origin: string | undefined): boolean => {
  if (!origin) {
    return false;
  }
  return /^(?:moz|chrome)-extension:\/\/[a-z0-9-]+\/?$/iu.test(origin);
};

export class BrowserAttachServer {
  private wsServer: FirefoxAttachWebSocketServer | null = null;

  private readonly registry = new BrowserAttachRegistry();

  private readonly recordingWriter: BrowserRecordingBundleWriter;

  private readonly sockets = new Set<ConnectedSocketState>();

  private readonly socketsByInstanceId = new Map<string, ConnectedSocketState>();

  private readonly pendingTabActions = new Map<string, PendingTabAction>();

  private readonly pendingRecordingControls = new Map<
    string,
    PendingRecordingControl
  >();

  private readonly activeRecordingsById = new Map<
    string,
    ActiveBrowserRecordingState
  >();

  private readonly pendingRecordingPersist = new Map<string, NodeJS.Timeout>();

  private readonly lastRecordingPersistAt = new Map<string, number>();

  private heartbeatReaper: NodeJS.Timeout | null = null;
  private readonly pickerDelivery: BrowserPickerDelivery;
  private readonly pickerSubmissions = new Map<string, Promise<void>>();

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sessionStore: SessionStore,
    private readonly maintenanceStore: MaintenanceStore,
    terminalInput?: Pick<TerminalInputService, "submitHumanMessage">,
  ) {
    this.recordingWriter = new BrowserRecordingBundleWriter(config, logger);
    this.pickerDelivery = new BrowserPickerDelivery(config, sessionStore,
      terminalInput ?? new TerminalInputService(config, sessionStore, logger));
  }

  public async start(): Promise<void> {
    if (!this.config.browser.attach.enabled) {
      return;
    }
    if (this.wsServer) {
      return;
    }
    const wsServer = new WebSocketServer({
      host: this.config.browser.attach.host,
      port: this.config.browser.attach.port,
      path: this.config.browser.attach.path,
      maxPayload: MAX_BODY_SIZE_BYTES,
      verifyClient: (
        info: FirefoxAttachVerifyClientInfo,
        done: (result: boolean, code?: number, message?: string) => void,
      ) => {
        if (!isAllowedAttachOrigin(info.origin)) {
          done(false, 403, "Forbidden");
          return;
        }
        done(true);
      },
    });
    this.wsServer = wsServer;

    wsServer.on("error", (error) => {
      this.logger.error("Browser attach WebSocket server error", {
        host: this.config.browser.attach.host,
        port: this.config.browser.attach.port,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      if (this.wsServer === wsServer) {
        this.wsServer = null;
      }
    });

    wsServer.on("connection", (socket) => {
      const now = Date.now();
      const state: ConnectedSocketState = {
        socket,
        lastSeenAt: now,
        rateWindowStartedAt: now,
        rateWindowMessageCount: 0,
        protocolFailed: false,
      };
      this.sockets.add(state);

      socket.on("message", (payload) => {
        void this.handleMessage(state, payload).catch((error) => {
          this.handleProtocolError(state, error);
        });
      });

      socket.on("close", () => {
        if (state.instanceId) {
          const current = this.socketsByInstanceId.get(state.instanceId);
          if (current === state) {
            void this.handleInstanceDisconnect(state.instanceId).catch((error) => {
              this.logger.error("Firefox attach disconnect cleanup failed", {
                instanceId: state.instanceId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            this.registry.remove(state.instanceId);
            this.socketsByInstanceId.delete(state.instanceId);
          }
          this.logger.info("Firefox attach instance disconnected", {
            instanceId: state.instanceId,
          });
        }
        this.sockets.delete(state);
      });

      socket.on("error", (error) => {
        this.logger.debug("Firefox attach socket error", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      });
    });

    this.heartbeatReaper = setInterval(() => {
      this.reapStaleSockets();
    }, ATTACH_HEARTBEAT_REAP_INTERVAL_MS);
    this.heartbeatReaper.unref();

    this.logger.info("Firefox attach WebSocket server started", {
      host: this.config.browser.attach.host,
      port: this.config.browser.attach.port,
      path: this.config.browser.attach.path,
    });
  }

  public async stop(): Promise<void> {
    if (!this.wsServer) {
      return;
    }

    if (this.heartbeatReaper) {
      clearInterval(this.heartbeatReaper);
      this.heartbeatReaper = null;
    }

    for (const state of this.sockets) {
      try {
        state.socket.close(1001, "server shutdown");
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.socketsByInstanceId.clear();

    const wsServer = this.wsServer;
    this.wsServer = null;
    await new Promise<void>((resolve, reject) => {
      wsServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.logger.info("Firefox attach WebSocket server stopped");
  }

  public listInstances(): FirefoxAttachInstanceRecord[] {
    return this.registry.listInstances();
  }

  public async getRecordingStatus(
    sessionId: string,
  ): Promise<BrowserRecordingRecord | null> {
    return this.maintenanceStore.getBrowserRecording(sessionId);
  }

  public async startRecording(input: {
    sessionId: string;
    instanceId: string;
    tabId: number;
    tabTitle: string;
    tabUrl?: string | undefined;
  }): Promise<BrowserRecordingRecord> {
    const existing = await this.maintenanceStore.getBrowserRecording(input.sessionId);
    if (existing?.status === "recording") {
      if (existing.instanceId !== input.instanceId) {
        throw new Error("Recording is already active in another browser instance.");
      }
      if (existing.tabId !== input.tabId) {
        throw new Error(
          `Browser instance '${input.instanceId}' is already recording tab '${existing.tabId}'. Stop it before starting recording for tab '${input.tabId}'.`,
        );
      }
      return existing;
    }

    const session = await this.sessionStore.getSession(input.sessionId);
    const resolvedSession =
      session ||
      ({
        sessionId: input.sessionId,
        label: this.config.project.sessionLabel?.trim() || input.sessionId,
        cwd: process.cwd(),
        updatedAt: formatLocalTimestamp(new Date()),
      } as const);

    if (!resolvedSession.cwd?.trim()) {
      throw new Error("Workspace cwd is not registered for this console.");
    }

    if (!session) {
      await this.sessionStore.setSession({
        sessionId: resolvedSession.sessionId,
        ...(resolvedSession.label ? { label: resolvedSession.label } : {}),
        cwd: resolvedSession.cwd,
        updatedAt: resolvedSession.updatedAt,
      });
      this.logger.info("Firefox attach recording synthesized missing session context", {
        sessionId: input.sessionId,
        cwd: resolvedSession.cwd,
        label: resolvedSession.label,
      });
    }

    const recordingId = randomUUID();
    const instance = this.registry.get(input.instanceId);
    const state = await this.recordingWriter.create({
      session: resolvedSession,
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      browser: instance?.browser ?? "firefox",
      tabId: input.tabId,
      tabTitle: input.tabTitle,
      ...(input.tabUrl ? { tabUrl: input.tabUrl } : {}),
      recordingId,
    });

    this.activeRecordingsById.set(recordingId, state);
    await this.maintenanceStore.setBrowserRecording(state.record);
    await this.broadcastRecordingState(state.record);

    try {
      await this.invokeRecordingControl({
        instanceId: input.instanceId,
        tabId: input.tabId,
        recordingId,
        mode: "start",
      });
    } catch (error) {
      this.activeRecordingsById.delete(recordingId);
      this.cancelRecordingPersist(recordingId);
      await this.maintenanceStore.clearBrowserRecording(input.sessionId);
      await this.broadcastRecordingState(null);
      throw error;
    }

    return state.record;
  }

  public async stopRecording(input: {
    sessionId: string;
  }): Promise<BrowserRecordingRecord | null> {
    const existing = await this.maintenanceStore.getBrowserRecording(input.sessionId);
    if (!existing) {
      return null;
    }

    const socketState = this.socketsByInstanceId.get(existing.instanceId);
    const activeState = this.activeRecordingsById.get(existing.recordingId);
    if (socketState) {
      try {
        await this.invokeRecordingControl({
          instanceId: existing.instanceId,
          tabId: existing.tabId,
          recordingId: existing.recordingId,
          mode: "stop",
        });
      } catch {
        // Local writer or persisted state still finalizes the bundle.
      }
    }

    if (activeState) {
      await this.recordingWriter.appendEvent(activeState, {
        kind: "session_stopped",
        status: "stopped",
      });
      this.activeRecordingsById.delete(existing.recordingId);
      await this.flushRecordingPersist(activeState);
      await this.broadcastRecordingState(activeState.record);
      return activeState.record;
    }

    if (existing.status !== "stopped") {
      const session = await this.sessionStore.getSession(existing.sessionId);
      const stopped: BrowserRecordingRecord =
        session?.cwd?.trim()
          ? await this.recordingWriter.finalizeExisting({
              session,
              record: existing,
            })
          : {
              ...existing,
              status: "stopped",
              stoppedAt: formatLocalTimestamp(new Date()),
            };
      await this.maintenanceStore.setBrowserRecording(stopped);
      await this.broadcastRecordingState(stopped);
      return stopped;
    }

    return existing;
  }

  public async invokeTabAction(input: {
    instanceId: string;
    tabId: number;
    action: FirefoxAttachTabActionRequest["action"];
    payload?: Record<string, unknown> | undefined;
  }): Promise<Record<string, unknown> | undefined> {
    const socketState = this.socketsByInstanceId.get(input.instanceId);
    if (!socketState) {
      throw new Error(
        `Attached browser instance '${input.instanceId}' is not connected.`,
      );
    }

    const requestId = `tab-action-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await new Promise<FirefoxAttachTabActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTabActions.delete(requestId);
        reject(
          new Error(
            `Attached browser action '${input.action}' timed out for instance '${input.instanceId}'.`,
          ),
        );
      }, this.config.browser.timeoutMs);

      this.pendingTabActions.set(requestId, {
        instanceId: input.instanceId,
        resolve,
        reject,
        timer,
      });

      this.sendJson(socketState.socket, {
        type: "tab_action",
        request_id: requestId,
        tab_id: input.tabId,
        action: input.action,
        ...(input.payload ? { payload: input.payload } : {}),
      });
    });

    if (!result.ok) {
      throw new Error(
        result.error ||
          `Attached browser action '${input.action}' failed for instance '${input.instanceId}'.`,
      );
    }

    return result.result;
  }

  private sendJson(
    socket: FirefoxAttachSocket,
    payload: FirefoxAttachOutboundMessage,
  ): void {
    if (socket.readyState !== WS_OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  private async handleMessage(
    state: ConnectedSocketState,
    payload: unknown,
  ): Promise<void> {
    if (state.protocolFailed) {
      return;
    }
    this.enforceRateLimit(state);
    state.lastSeenAt = Date.now();
    const raw =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString("utf8")
            : Array.isArray(payload) && payload.every(Buffer.isBuffer)
              ? Buffer.concat(payload).toString("utf8")
              : String(payload ?? "");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new BrowserAttachProtocolError("invalid_json");
    }

    const parsed = firefoxAttachInboundMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new BrowserAttachProtocolError("invalid_message");
    }
    const message = parsed.data;

    if (!state.instanceId && message.type !== "hello") {
      throw new BrowserAttachProtocolError("hello_required");
    }
    if (state.instanceId && message.type === "hello") {
      throw new BrowserAttachProtocolError("duplicate_hello");
    }
    const connectedInstanceId = state.instanceId;

    switch (message.type) {
      case "hello":
        await this.handleHello(state, message);
        return;
      case "heartbeat":
        if (state.instanceId) {
          this.registry.touch(state.instanceId);
        }
        return;
      case "list_tabs_result":
        if (state.instanceId) {
          this.registry.setTabs(state.instanceId, message.tabs);
        }
        return;
      case "get_active_tab_result":
        if (state.instanceId) {
          this.registry.setActiveTab(state.instanceId, message.tab);
        }
        return;
      case "active_tab_changed":
        if (state.instanceId) {
          this.registry.setActiveTab(state.instanceId, message.tab);
        }
        return;
      case "tab_updated":
        if (state.instanceId) {
          this.registry.updateTab(state.instanceId, message.tab);
        }
        return;
      case "tab_removed":
        if (state.instanceId) {
          this.registry.removeTab(state.instanceId, message.tab_id);
        }
        return;
      case "attach_tab_selected":
        try {
          if (!state.instanceId || this.socketsByInstanceId.get(state.instanceId) !== state)
            throw new Error("Browser connection changed");
          this.registry.updateTab(state.instanceId, {
            ...message.tab,
          });
          await this.persistSelectedTab(state.instanceId, message.tab);
          if (this.socketsByInstanceId.get(state.instanceId) !== state || state.socket.readyState !== WS_OPEN)
            throw new Error("Browser disconnected during attachment");
          if (message.request_id)
            this.sendJson(state.socket, { type: "attach_tab_selected_result", request_id: message.request_id, ok: true });
        } catch (error) {
          if (!message.request_id) throw error;
          this.sendJson(state.socket, { type: "attach_tab_selected_result", request_id: message.request_id,
            ok: false, error: "Could not attach the Picker tab to this console. Retry after reconnecting." });
        }
        return;
      case "tab_action_result":
        if (connectedInstanceId) {
          this.resolvePendingTabAction(connectedInstanceId, message);
        }
        return;
      case "picker_submit":
        await this.handlePickerSubmit(state, message);
        return;
      case "recording_control_result":
        if (connectedInstanceId) {
          this.resolvePendingRecordingControl(connectedInstanceId, message);
        }
        return;
      case "recording_event":
        if (state.instanceId) {
          await this.handleRecordingEvent(
            state.instanceId,
            message.recording_id,
            message.tab_id,
            message.event,
          );
        }
        return;
      case "recording_manual_start":
      case "recording_manual_stop":
      case "recording_manual_status":
        if (state.instanceId) {
          await this.handleManualRecordingRequest(
            state.socket,
            state.instanceId,
            message,
          );
        }
        return;
      default:
        return;
    }
  }

  private async handlePickerSubmit(
    state: ConnectedSocketState,
    message: Extract<FirefoxAttachInboundMessage, { type: "picker_submit" }>,
  ): Promise<void> {
    const key = JSON.stringify([state.instanceId, message.request_id]);
    const pending = this.pickerSubmissions.get(key);
    if (pending) return pending;
    if (this.pickerSubmissions.size >= 8) {
      this.sendJson(state.socket, { type: "picker_submit_result", request_id: message.request_id,
        ok: false, error: "Too many pending Picker requests. Retry after they finish." });
      return;
    }
    const operation = (async () => {
      try {
        const instanceId = state.instanceId!;
        const sessionId = this.config.project.sessionId?.trim();
        if (!sessionId) throw new Error("Missing owner session");
        const assertBound = async () => {
          const attachment = await this.maintenanceStore.getBrowserAttachment(sessionId);
          if (this.socketsByInstanceId.get(instanceId) !== state ||
              state.socket.readyState !== WS_OPEN ||
              attachment?.instanceId !== instanceId || attachment.tabId !== message.tab_id)
            throw new Error("Picker source is not the selected tab of this console");
        };
        await assertBound();
        const result = await this.invokeTabAction({ instanceId, tabId: message.tab_id,
          action: "inspector_get_selection", payload: { session_id: sessionId,
            request_id: message.request_id, selection_id: message.selection_id, include_image: true } });
        const context = result?.context as Record<string, unknown> | undefined;
        if (context?.requestId !== message.request_id || context.selectionId !== message.selection_id)
          throw new Error("Picker selection does not match the submitted request");
        const clientUuid = this.config.distributed?.mode === "client"
          ? await this.maintenanceStore.getGatewayClientUuid() : null;
        if (this.config.distributed?.mode === "client" && !clientUuid)
          throw new Error("Console gateway identity is unavailable");
        const receipt = await this.pickerDelivery.deliver({ sessionId, instanceId,
          ...(clientUuid ? { toolSessionId: `${clientUuid}:${sessionId}` } : {}),
          tabId: message.tab_id, result, assertBound });
        this.sendJson(state.socket, { type: "picker_submit_result", request_id: message.request_id, ...receipt });
      } catch {
        this.logger.warn("Browser Picker delivery failed", { instanceId: state.instanceId, requestId: message.request_id });
        this.sendJson(state.socket, { type: "picker_submit_result", request_id: message.request_id,
          ok: false, error: "Could not deliver selection. Check the attached tab and console, then retry." });
      }
    })();
    this.pickerSubmissions.set(key, operation);
    try { await operation; } finally { this.pickerSubmissions.delete(key); }
  }

  private async handleHello(
    state: ConnectedSocketState,
    message: FirefoxAttachInstanceHello,
  ): Promise<void> {
    const previous = this.socketsByInstanceId.get(message.instance_id);
    state.instanceId = message.instance_id;
    this.socketsByInstanceId.set(message.instance_id, state);
    if (previous && previous !== state) {
      this.logger.warn("Firefox attach instance connection replaced", {
        instanceId: message.instance_id,
      });
      previous.socket.close(4001, "replaced by newer connection");
    }
    const instance = this.registry.setConnected({
      instanceId: message.instance_id,
      browser: message.browser,
      extensionVersion: message.extension_version,
      ...(message.profile_name ? { profileName: message.profile_name } : {}),
      capabilities: ["tabs", "active_tab", "recording", "picker_delivery", "picker_marks", "picker_auto_attach", "picker_optional_reply"],
    });

    this.sendJson(state.socket, {
      type: "hello_ack",
      ok: true,
      instance_id: message.instance_id,
      capabilities: instance.capabilities,
      ...(this.config.project.sessionId
        ? { session_id: this.config.project.sessionId }
        : {}),
      ...(this.config.project.sessionLabel
        ? { session_label: this.config.project.sessionLabel }
        : {}),
    });

    this.logger.info("Firefox attach instance connected", {
      instanceId: message.instance_id,
      extensionVersion: message.extension_version,
      profileName: message.profile_name,
    });

    this.sendJson(state.socket, {
      type: "list_tabs",
      request_id: "bootstrap-list-tabs",
    } satisfies FirefoxAttachListTabsRequest);

    this.sendJson(state.socket, {
      type: "get_active_tab",
      request_id: "bootstrap-active-tab",
    } satisfies FirefoxAttachGetActiveTabRequest);

    await this.sendCurrentRecordingState(state.socket);
  }

  private async persistSelectedTab(
    instanceId: string,
    tab: {
      tab_id: number;
      title: string;
      url: string;
    },
  ): Promise<void> {
    const sessionId = this.config.project.sessionId?.trim();
    if (!sessionId) {
      return;
    }

    const instance = this.registry.get(instanceId);
    await this.maintenanceStore.setBrowserAttachment({
      sessionId,
      backend: instance?.browser === "chrome" ? "chrome-attached" : "firefox-attached",
      instanceId,
      tabId: tab.tab_id,
      attachedAt: formatLocalTimestamp(new Date()),
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.url ? { url: tab.url } : {}),
    });

    this.logger.info("Firefox attached tab selected", {
      sessionId,
      instanceId,
      tabId: tab.tab_id,
      title: tab.title,
      url: tab.url,
    });
  }

  private resolvePendingTabAction(
    instanceId: string,
    message: FirefoxAttachTabActionResult,
  ): void {
    const pending = this.pendingTabActions.get(message.request_id);
    if (!pending || pending.instanceId !== instanceId) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTabActions.delete(message.request_id);
    pending.resolve(message);
  }

  private resolvePendingRecordingControl(
    instanceId: string,
    message: FirefoxAttachRecordingControlResult,
  ): void {
    const pending = this.pendingRecordingControls.get(message.request_id);
    if (!pending || pending.instanceId !== instanceId) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRecordingControls.delete(message.request_id);
    pending.resolve(message);
  }

  private async invokeRecordingControl(input: {
    instanceId: string;
    tabId: number;
    recordingId: string;
    mode: "start" | "stop";
  }): Promise<void> {
    const socketState = this.socketsByInstanceId.get(input.instanceId);
    if (!socketState) {
      throw new Error(
        `Attached browser instance '${input.instanceId}' is not connected.`,
      );
    }

    const requestId = `recording-${input.mode}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await new Promise<FirefoxAttachRecordingControlResult>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRecordingControls.delete(requestId);
          reject(
            new Error(
              `Attached browser recording '${input.mode}' timed out for instance '${input.instanceId}'.`,
            ),
          );
        }, this.config.browser.timeoutMs);

        this.pendingRecordingControls.set(requestId, {
          instanceId: input.instanceId,
          resolve,
          reject,
          timer,
        });

        this.sendJson(
          socketState.socket,
          input.mode === "start"
            ? ({
                type: "recording_start",
                request_id: requestId,
                recording_id: input.recordingId,
                tab_id: input.tabId,
              } satisfies FirefoxAttachRecordingStartRequest)
            : ({
                type: "recording_stop",
                request_id: requestId,
                recording_id: input.recordingId,
                tab_id: input.tabId,
              } satisfies FirefoxAttachRecordingStopRequest),
        );
      },
    );

    if (!result.ok) {
      throw new Error(
        result.error ||
          `Attached browser recording '${input.mode}' failed for instance '${input.instanceId}'.`,
      );
    }
  }

  private async handleRecordingEvent(
    instanceId: string,
    recordingId: string,
    tabId: number,
    event: Record<string, unknown>,
  ): Promise<void> {
    const state = this.activeRecordingsById.get(recordingId);
    if (!state) {
      return;
    }
    if (state.record.instanceId !== instanceId || state.record.tabId !== tabId) {
      return;
    }

    await this.recordingWriter.appendEvent(
      state,
      event as Parameters<BrowserRecordingBundleWriter["appendEvent"]>[1],
    );

    if (event.kind === "session_stopped") {
      await this.flushRecordingPersist(state);
    } else {
      this.scheduleRecordingPersist(state);
    }
  }

  private scheduleRecordingPersist(state: ActiveBrowserRecordingState): void {
    const recordingId = state.record.recordingId;
    if (this.pendingRecordingPersist.has(recordingId)) {
      return;
    }
    const lastFlushAt = this.lastRecordingPersistAt.get(recordingId) ?? 0;
    const delay = Math.max(
      0,
      RECORDING_PERSIST_INTERVAL_MS - (Date.now() - lastFlushAt),
    );
    const timer = setTimeout(() => {
      this.pendingRecordingPersist.delete(recordingId);
      this.lastRecordingPersistAt.set(recordingId, Date.now());
      void this.maintenanceStore.setBrowserRecording(state.record).catch((error) => {
        this.logger.warn("Failed to persist throttled browser recording state", {
          recordingId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    this.pendingRecordingPersist.set(recordingId, timer);
  }

  private async flushRecordingPersist(
    state: ActiveBrowserRecordingState,
  ): Promise<void> {
    const recordingId = state.record.recordingId;
    const pending = this.pendingRecordingPersist.get(recordingId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRecordingPersist.delete(recordingId);
    }
    this.lastRecordingPersistAt.set(recordingId, Date.now());
    await this.maintenanceStore.setBrowserRecording(state.record);
  }

  private cancelRecordingPersist(recordingId: string): void {
    const pending = this.pendingRecordingPersist.get(recordingId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRecordingPersist.delete(recordingId);
    }
    this.lastRecordingPersistAt.delete(recordingId);
    this.recordingWriter.cancelPendingSessionJsonFlush(recordingId);
  }

  private async handleInstanceDisconnect(instanceId: string): Promise<void> {
    const activeStates = Array.from(this.activeRecordingsById.values()).filter(
      (state) => state.record.instanceId === instanceId,
    );
    if (activeStates.length === 0) {
      return;
    }

    await Promise.all(
      activeStates.map(async (state) => {
        await this.recordingWriter.appendEvent(state, {
          kind: "session_stopped",
          status: "instance_disconnected",
        });
        this.activeRecordingsById.delete(state.record.recordingId);
        await this.flushRecordingPersist(state);
        await this.broadcastRecordingState(state.record);
      }),
    );
  }

  private buildRecordingStateMessage(
    record: BrowserRecordingRecord | null,
  ): FirefoxAttachRecordingStateEvent {
    return {
      type: "recording_state",
      active: record?.status === "recording",
      ...(record ? { recording: this.mapManualRecordingResult(record) } : {}),
    };
  }

  private async sendCurrentRecordingState(
    socket: FirefoxAttachSocket,
  ): Promise<void> {
    const sessionId = this.config.project.sessionId?.trim();
    const record = sessionId
      ? await this.maintenanceStore.getBrowserRecording(sessionId)
      : null;
    this.sendJson(socket, this.buildRecordingStateMessage(record));
  }

  private async broadcastRecordingState(
    record: BrowserRecordingRecord | null,
  ): Promise<void> {
    const payload = this.buildRecordingStateMessage(record);
    for (const state of this.sockets) {
      if (state.instanceId) {
        this.sendJson(state.socket, payload);
      }
    }
  }

  private enforceRateLimit(state: ConnectedSocketState): void {
    const now = Date.now();
    if (now - state.rateWindowStartedAt >= ATTACH_RATE_WINDOW_MS) {
      state.rateWindowStartedAt = now;
      state.rateWindowMessageCount = 0;
    }
    state.rateWindowMessageCount += 1;
    if (state.rateWindowMessageCount > ATTACH_RATE_MAX_MESSAGES) {
      throw new BrowserAttachProtocolError("rate_limit_exceeded");
    }
  }

  private handleProtocolError(
    state: ConnectedSocketState,
    error: unknown,
  ): void {
    if (state.protocolFailed) {
      return;
    }
    state.protocolFailed = true;
    const reason =
      error instanceof BrowserAttachProtocolError
        ? error.reason
        : "message_handler_failed";
    this.logger.warn("Firefox attach protocol error", {
      ...(state.instanceId ? { instanceId: state.instanceId } : {}),
      reason,
    });
    try {
      state.socket.close(1008, reason);
    } catch {
      // The socket may already have closed while the handler was awaiting I/O.
    }
  }

  private reapStaleSockets(): void {
    const staleBefore = Date.now() - ATTACH_HEARTBEAT_TIMEOUT_MS;
    for (const state of this.sockets) {
      if (state.lastSeenAt >= staleBefore) {
        continue;
      }
      this.logger.warn("Firefox attach socket heartbeat expired", {
        ...(state.instanceId ? { instanceId: state.instanceId } : {}),
      });
      state.socket.close(4002, "heartbeat timeout");
    }
  }

  private mapManualRecordingResult(
    record: BrowserRecordingRecord | null,
  ): FirefoxAttachManualRecordingResult["recording"] | undefined {
    if (!record) {
      return undefined;
    }
    return {
      recording_id: record.recordingId,
      instance_id: record.instanceId,
      tab_id: record.tabId,
      ...(record.tabTitle ? { tab_title: record.tabTitle } : {}),
      ...(record.tabUrl ? { tab_url: record.tabUrl } : {}),
      bundle_dir_name: record.bundleDirName,
      bundle_relative_path: record.bundleRelativePath,
      bundle_path: record.bundlePath,
      started_at: record.startedAt,
      ...(record.stoppedAt ? { stopped_at: record.stoppedAt } : {}),
      status: record.status,
      event_count: record.eventCount,
      ...(record.lastEventAt ? { last_event_at: record.lastEventAt } : {}),
    };
  }

  private async handleManualRecordingRequest(
    socket: FirefoxAttachSocket,
    instanceId: string,
    message: Extract<
      FirefoxAttachInboundMessage,
      { type: "recording_manual_start" | "recording_manual_stop" | "recording_manual_status" }
    >,
  ): Promise<void> {
    const sessionId = this.config.project.sessionId?.trim();
    if (!sessionId) {
      this.sendJson(socket, {
        type: "recording_manual_result",
        request_id: message.request_id,
        ok: false,
        active: false,
        error: "Session id is not configured for this attach server.",
      });
      return;
    }

    try {
      if (message.type === "recording_manual_status") {
        const record = await this.getRecordingStatus(sessionId);
        this.sendJson(socket, {
          type: "recording_manual_result",
          request_id: message.request_id,
          ok: true,
          active: record?.status === "recording",
          ...(record ? { recording: this.mapManualRecordingResult(record) } : {}),
        });
        return;
      }

      if (message.type === "recording_manual_stop") {
        const record = await this.stopRecording({ sessionId });
        this.sendJson(socket, {
          type: "recording_manual_result",
          request_id: message.request_id,
          ok: true,
          active: record?.status === "recording",
          ...(record ? { recording: this.mapManualRecordingResult(record) } : {}),
        });
        return;
      }

      const tab = message.tab;
      if (!tab) {
        throw new Error("Selected tab metadata is required to start recording.");
      }
      const record = await this.startRecording({
        sessionId,
        instanceId,
        tabId: tab.tab_id,
        tabTitle: tab.title || "attached-tab",
        ...(tab.url ? { tabUrl: tab.url } : {}),
      });
      this.sendJson(socket, {
        type: "recording_manual_result",
        request_id: message.request_id,
        ok: true,
        active: true,
        recording: this.mapManualRecordingResult(record),
      });
    } catch (error) {
      this.sendJson(socket, {
        type: "recording_manual_result",
        request_id: message.request_id,
        ok: false,
        active: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
