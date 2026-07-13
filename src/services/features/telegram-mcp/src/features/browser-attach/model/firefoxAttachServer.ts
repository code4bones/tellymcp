import { randomUUID } from "node:crypto";

import ws from "ws";

import type { AppConfig } from "../../../app/config/env";
import type { BrowserRecordingRecord } from "../../../entities/browser/model/types";
import type {
  MaintenanceStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { formatLocalTimestamp } from "../../../shared/lib/time/localTimestamp";
import {
  BrowserRecordingBundleWriter,
  type ActiveBrowserRecordingState,
} from "./browserRecordingBundle";
import {
  FirefoxAttachRegistry,
  type FirefoxAttachInstanceRecord,
} from "./firefoxAttachRegistry";
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
  on: (
    event: "connection",
    listener: (socket: FirefoxAttachSocket) => void,
  ) => void;
  close: (callback: (error?: unknown) => void) => void;
};

const wsLib = ws as unknown as {
  OPEN: number;
  WebSocketServer: new (options: Record<string, unknown>) => FirefoxAttachWebSocketServer;
};

const WebSocketServer = wsLib.WebSocketServer;
const WS_OPEN = wsLib.OPEN;

type ConnectedSocketState = {
  socket: FirefoxAttachSocket;
  instanceId?: string | undefined;
};

type PendingTabAction = {
  resolve: (value: FirefoxAttachTabActionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingRecordingControl = {
  resolve: (value: FirefoxAttachRecordingControlResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class FirefoxAttachServer {
  private wsServer: FirefoxAttachWebSocketServer | null = null;

  private readonly registry = new FirefoxAttachRegistry();

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

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sessionStore: SessionStore,
    private readonly maintenanceStore: MaintenanceStore,
  ) {
    this.recordingWriter = new BrowserRecordingBundleWriter(config, logger);
  }

  public async start(): Promise<void> {
    if (!this.config.browser.attach.enabled) {
      return;
    }
    if (this.wsServer) {
      return;
    }

    this.wsServer = new WebSocketServer({
      host: this.config.browser.attach.host,
      port: this.config.browser.attach.port,
      path: this.config.browser.attach.path,
    });

    this.wsServer.on("connection", (socket) => {
      const state: ConnectedSocketState = { socket };
      this.sockets.add(state);

      socket.on("message", (payload) => {
        void this.handleMessage(state, payload);
      });

      socket.on("close", () => {
        if (state.instanceId) {
          const current = this.socketsByInstanceId.get(state.instanceId);
          if (current === state) {
            void this.handleInstanceDisconnect(state.instanceId);
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

    for (const state of this.sockets) {
      try {
        state.socket.close(1001, "server shutdown");
      } catch {
        // ignore
      }
    }
    this.sockets.clear();

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
    const state = await this.recordingWriter.create({
      session: resolvedSession,
      sessionId: input.sessionId,
      instanceId: input.instanceId,
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
      await this.maintenanceStore.setBrowserRecording(activeState.record);
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
    const raw =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : String(payload ?? "");
    let message: FirefoxAttachInboundMessage;
    try {
      message = JSON.parse(raw) as FirefoxAttachInboundMessage;
    } catch {
      this.logger.debug("Firefox attach message ignored because it is not valid JSON");
      return;
    }

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
      case "attach_tab_selected":
        if (state.instanceId) {
          this.registry.updateTab(state.instanceId, {
            ...message.tab,
            active: true,
          });
          await this.persistSelectedTab(state.instanceId, message.tab);
        }
        return;
      case "tab_action_result":
        this.resolvePendingTabAction(message);
        return;
      case "recording_control_result":
        this.resolvePendingRecordingControl(message);
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

  private async handleHello(
    state: ConnectedSocketState,
    message: FirefoxAttachInstanceHello,
  ): Promise<void> {
    state.instanceId = message.instance_id;
    this.socketsByInstanceId.set(message.instance_id, state);
    const instance = this.registry.setConnected({
      instanceId: message.instance_id,
      browser: message.browser,
      extensionVersion: message.extension_version,
      ...(message.profile_name ? { profileName: message.profile_name } : {}),
      capabilities: ["tabs", "active_tab", "recording"],
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

    await this.maintenanceStore.setBrowserAttachment({
      sessionId,
      backend: "firefox-attached",
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

  private resolvePendingTabAction(message: FirefoxAttachTabActionResult): void {
    const pending = this.pendingTabActions.get(message.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTabActions.delete(message.request_id);
    pending.resolve(message);
  }

  private resolvePendingRecordingControl(
    message: FirefoxAttachRecordingControlResult,
  ): void {
    const pending = this.pendingRecordingControls.get(message.request_id);
    if (!pending) {
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
    await this.maintenanceStore.setBrowserRecording(state.record);
  }

  private async handleInstanceDisconnect(instanceId: string): Promise<void> {
    const activeStates = Array.from(this.activeRecordingsById.values()).filter(
      (state) => state.record.instanceId === instanceId,
    );
    if (activeStates.length === 0) {
      return;
    }

    for (const state of activeStates) {
      await this.recordingWriter.appendEvent(state, {
        kind: "session_stopped",
        status: "instance_disconnected",
      });
      this.activeRecordingsById.delete(state.record.recordingId);
      await this.maintenanceStore.setBrowserRecording(state.record);
      await this.broadcastRecordingState(state.record);
    }
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
      this.sendJson(state.socket, payload);
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
