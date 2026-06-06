export type FirefoxAttachInstanceHello = {
  type: "hello";
  extension_version: string;
  browser: "firefox" | "chrome";
  instance_id: string;
  profile_name?: string | undefined;
};

export type FirefoxAttachHelloAck = {
  type: "hello_ack";
  ok: boolean;
  instance_id: string;
  capabilities: string[];
  session_id?: string | undefined;
  session_label?: string | undefined;
};

export type FirefoxAttachHeartbeat = {
  type: "heartbeat";
  sent_at: string;
};

export type FirefoxAttachTabRecord = {
  tab_id: number;
  window_id?: number | undefined;
  active: boolean;
  title: string;
  url: string;
  status?: string | undefined;
};

export type FirefoxAttachListTabsRequest = {
  type: "list_tabs";
  request_id: string;
};

export type FirefoxAttachTabActionRequest = {
  type: "tab_action";
  request_id: string;
  tab_id: number;
  action:
    | "attach"
    | "detach"
    | "dom"
    | "click"
    | "fill"
    | "press"
    | "reload"
    | "close"
    | "wait_for"
    | "wait_for_url"
    | "computed_style"
    | "screenshot"
    | "inject_script"
    | "get_logs"
    | "clear_logs";
  payload?: Record<string, unknown> | undefined;
};

export type FirefoxAttachRecordingStartRequest = {
  type: "recording_start";
  request_id: string;
  recording_id: string;
  tab_id: number;
};

export type FirefoxAttachRecordingStopRequest = {
  type: "recording_stop";
  request_id: string;
  recording_id: string;
  tab_id: number;
};

export type FirefoxAttachListTabsResult = {
  type: "list_tabs_result";
  request_id: string;
  tabs: FirefoxAttachTabRecord[];
};

export type FirefoxAttachGetActiveTabRequest = {
  type: "get_active_tab";
  request_id: string;
};

export type FirefoxAttachGetActiveTabResult = {
  type: "get_active_tab_result";
  request_id: string;
  tab: FirefoxAttachTabRecord | null;
};

export type FirefoxAttachActiveTabChangedEvent = {
  type: "active_tab_changed";
  tab: FirefoxAttachTabRecord;
};

export type FirefoxAttachTabUpdatedEvent = {
  type: "tab_updated";
  tab: FirefoxAttachTabRecord;
};

export type FirefoxAttachTabSelectedEvent = {
  type: "attach_tab_selected";
  tab: FirefoxAttachTabRecord;
};

export type FirefoxAttachTabActionResult = {
  type: "tab_action_result";
  request_id: string;
  ok: boolean;
  result?: Record<string, unknown> | undefined;
  error?: string | undefined;
};

export type FirefoxAttachRecordingControlResult = {
  type: "recording_control_result";
  request_id: string;
  ok: boolean;
  active: boolean;
  error?: string | undefined;
};

export type FirefoxAttachRecordingEvent = {
  type: "recording_event";
  recording_id: string;
  tab_id: number;
  event: Record<string, unknown>;
};

export type FirefoxAttachManualRecordingRequest = {
  type: "recording_manual_start" | "recording_manual_stop" | "recording_manual_status";
  request_id: string;
  tab?: FirefoxAttachTabRecord | undefined;
};

export type FirefoxAttachManualRecordingResult = {
  type: "recording_manual_result";
  request_id: string;
  ok: boolean;
  active: boolean;
  error?: string | undefined;
  recording?: {
    recording_id: string;
    instance_id: string;
    tab_id: number;
    tab_title?: string | undefined;
    tab_url?: string | undefined;
    bundle_dir_name: string;
    bundle_relative_path: string;
    bundle_path: string;
    started_at: string;
    stopped_at?: string | undefined;
    status: "recording" | "stopped";
    event_count: number;
    last_event_at?: string | undefined;
  } | undefined;
};

export type FirefoxAttachRecordingStateEvent = {
  type: "recording_state";
  active: boolean;
  recording?: FirefoxAttachManualRecordingResult["recording"] | undefined;
};

export type FirefoxAttachInboundMessage =
  | FirefoxAttachInstanceHello
  | FirefoxAttachHeartbeat
  | FirefoxAttachListTabsResult
  | FirefoxAttachGetActiveTabResult
  | FirefoxAttachActiveTabChangedEvent
  | FirefoxAttachTabUpdatedEvent
  | FirefoxAttachTabSelectedEvent
  | FirefoxAttachTabActionResult
  | FirefoxAttachRecordingControlResult
  | FirefoxAttachRecordingEvent
  | FirefoxAttachManualRecordingRequest;

export type FirefoxAttachOutboundMessage =
  | FirefoxAttachHelloAck
  | FirefoxAttachListTabsRequest
  | FirefoxAttachGetActiveTabRequest
  | FirefoxAttachTabActionRequest
  | FirefoxAttachRecordingStartRequest
  | FirefoxAttachRecordingStopRequest
  | FirefoxAttachManualRecordingResult
  | FirefoxAttachRecordingStateEvent;
