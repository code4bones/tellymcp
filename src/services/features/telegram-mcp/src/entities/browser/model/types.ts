export type BrowserOpenInput = {
  session_id?: string | undefined;
  url: string;
  width?: number | undefined;
  height?: number | undefined;
  wait_until?:
    | "load"
    | "domcontentloaded"
    | "networkidle"
    | "commit"
    | undefined;
  reset_context?: boolean | undefined;
};

export type BrowserOpenOutput = {
  session_id: string;
  opened: boolean;
  created_context: boolean;
  url: string;
  title?: string | undefined;
  viewport_width?: number | undefined;
  viewport_height?: number | undefined;
};

export type BrowserListAttachedInstancesInput = {
  session_id?: string | undefined;
};

export type BrowserListAttachedInstancesOutput = {
  session_id?: string | undefined;
  total: number;
  instances: Array<{
    instance_id: string;
    browser: "firefox";
    extension_version: string;
    profile_name?: string | undefined;
    connected_at: string;
    last_seen_at: string;
    capabilities: string[];
    tab_count: number;
    active_tab?: {
      tab_id: number;
      window_id?: number | undefined;
      active: boolean;
      title: string;
      url: string;
      status?: string | undefined;
    } | undefined;
  }>;
};

export type BrowserListTabsInput = {
  session_id?: string | undefined;
  instance_id?: string | undefined;
};

export type BrowserListTabsOutput = {
  session_id?: string | undefined;
  instance_id: string;
  total: number;
  tabs: Array<{
    tab_id: number;
    window_id?: number | undefined;
    active: boolean;
    selected?: boolean | undefined;
    title: string;
    url: string;
    status?: string | undefined;
  }>;
};

export type BrowserAttachActiveTabInput = {
  session_id?: string | undefined;
  instance_id?: string | undefined;
};

export type BrowserAttachTabInput = {
  session_id?: string | undefined;
  instance_id?: string | undefined;
  tab_id: number;
};

export type BrowserAttachTabOutput = {
  session_id: string;
  backend: "firefox-attached";
  instance_id: string;
  tab_id: number;
  attached_at: string;
  title?: string | undefined;
  url?: string | undefined;
};

export type BrowserDetachTabInput = {
  session_id?: string | undefined;
};

export type BrowserDetachTabOutput = {
  session_id: string;
  detached: boolean;
};

export type BrowserAttachmentRecord = {
  sessionId: string;
  backend: "firefox-attached";
  instanceId: string;
  tabId: number;
  attachedAt: string;
  title?: string | undefined;
  url?: string | undefined;
};

export type BrowserRecordingRecord = {
  sessionId: string;
  backend: "firefox-attached";
  recordingId: string;
  instanceId: string;
  tabId: number;
  tabTitle?: string | undefined;
  tabUrl?: string | undefined;
  bundleDirName: string;
  bundleRelativePath: string;
  bundlePath: string;
  startedAt: string;
  stoppedAt?: string | undefined;
  status: "recording" | "stopped";
  eventCount: number;
  lastEventAt?: string | undefined;
};

export type BrowserRecordingStartInput = {
  session_id?: string | undefined;
  instance_id?: string | undefined;
};

export type BrowserRecordingStartOutput = {
  session_id: string;
  backend: "firefox-attached";
  started: boolean;
  recording_id: string;
  instance_id: string;
  tab_id: number;
  tab_title?: string | undefined;
  tab_url?: string | undefined;
  bundle_dir_name: string;
  bundle_relative_path: string;
  bundle_path: string;
  started_at: string;
};

export type BrowserRecordingStopInput = {
  session_id?: string | undefined;
};

export type BrowserRecordingStopOutput = {
  session_id: string;
  stopped: boolean;
  recording_id?: string | undefined;
  bundle_dir_name?: string | undefined;
  bundle_relative_path?: string | undefined;
  bundle_path?: string | undefined;
  stopped_at?: string | undefined;
};

export type BrowserRecordingStatusInput = {
  session_id?: string | undefined;
};

export type BrowserRecordingStatusOutput = {
  session_id: string;
  active: boolean;
  recording?: {
    backend: "firefox-attached";
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

export type BrowserConsoleInput = {
  session_id?: string | undefined;
  limit?: number | undefined;
};

export type BrowserReloadInput = {
  session_id?: string | undefined;
  wait_until?:
    | "load"
    | "domcontentloaded"
    | "networkidle"
    | "commit"
    | undefined;
};

export type BrowserReloadOutput = {
  session_id: string;
  reloaded: boolean;
  url: string;
  title?: string | undefined;
};

export type BrowserLocatorInput = {
  session_id?: string | undefined;
  ai_tag?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  exact?: boolean | undefined;
  timeout_ms?: number | undefined;
};

export type BrowserClickInput = BrowserLocatorInput;

export type BrowserClickOutput = {
  session_id: string;
  clicked: boolean;
  ai_tag?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  url: string;
  title?: string | undefined;
};

export type BrowserFillInput = BrowserLocatorInput & {
  value: string;
};

export type BrowserFillOutput = {
  session_id: string;
  filled: boolean;
  ai_tag?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  value_length: number;
  url: string;
  title?: string | undefined;
};

export type BrowserPressInput = BrowserLocatorInput & {
  key: string;
};

export type BrowserPressOutput = {
  session_id: string;
  pressed: boolean;
  key: string;
  ai_tag?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  url: string;
  title?: string | undefined;
};

export type BrowserInjectScriptInput = {
  session_id?: string | undefined;
  source?: string | undefined;
  file_path?: string | undefined;
  namespace?: string | undefined;
};

export type BrowserInjectScriptOutput = {
  session_id: string;
  injected: boolean;
  namespace: string;
  source_type: "inline" | "file";
  bytes: number;
  url: string;
  title?: string | undefined;
};

export type BrowserWaitForInput = BrowserLocatorInput & {
  state?: "attached" | "detached" | "visible" | "hidden" | undefined;
};

export type BrowserWaitForOutput = {
  session_id: string;
  waited: boolean;
  state: "attached" | "detached" | "visible" | "hidden";
  ai_tag?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  url: string;
  title?: string | undefined;
};

export type BrowserWaitForUrlInput = {
  session_id?: string | undefined;
  url?: string | undefined;
  url_contains?: string | undefined;
  timeout_ms?: number | undefined;
};

export type BrowserWaitForUrlOutput = {
  session_id: string;
  waited: boolean;
  matched: "url" | "url_contains";
  url?: string | undefined;
  url_contains?: string | undefined;
  current_url: string;
  title?: string | undefined;
};

export type BrowserConsoleOutput = {
  session_id: string;
  total: number;
  messages: Array<{
    type: string;
    text: string;
    location?: string | undefined;
    timestamp: string;
  }>;
};

export type BrowserErrorsInput = {
  session_id?: string | undefined;
  limit?: number | undefined;
};

export type BrowserErrorsOutput = {
  session_id: string;
  total: number;
  errors: Array<{
    message: string;
    stack?: string | undefined;
    timestamp: string;
  }>;
};

export type BrowserNetworkFailuresInput = {
  session_id?: string | undefined;
  limit?: number | undefined;
};

export type BrowserNetworkFailuresOutput = {
  session_id: string;
  total: number;
  failures: Array<{
    url: string;
    method: string;
    status?: number | undefined;
    error_text?: string | undefined;
    resource_type?: string | undefined;
    timestamp: string;
  }>;
};

export type BrowserClearLogsInput = {
  session_id?: string | undefined;
};

export type BrowserClearLogsOutput = {
  session_id: string;
  cleared: boolean;
  console_messages_cleared: number;
  page_errors_cleared: number;
  network_failures_cleared: number;
};

export type BrowserDomInput = {
  session_id?: string | undefined;
  selector?: string | undefined;
  include_html?: boolean | undefined;
  include_text?: boolean | undefined;
};

export type BrowserDomOutput = {
  session_id: string;
  selector: string;
  found: boolean;
  url?: string | undefined;
  title?: string | undefined;
  outer_html?: string | undefined;
  text_content?: string | undefined;
  visible?: boolean | undefined;
  attributes?: Record<string, string> | undefined;
};

export type BrowserComputedStyleInput = {
  session_id?: string | undefined;
  selector: string;
  properties?: string[] | undefined;
};

export type BrowserComputedStyleOutput = {
  session_id: string;
  selector: string;
  found: boolean;
  url?: string | undefined;
  title?: string | undefined;
  visible?: boolean | undefined;
  styles?: Record<string, string> | undefined;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type BrowserScreenshotInput = {
  session_id?: string | undefined;
  selector?: string | undefined;
  full_page?: boolean | undefined;
  file_name?: string | undefined;
  send_to_telegram?: boolean | undefined;
  caption?: string | undefined;
};

export type BrowserScreenshotOutput = {
  session_id: string;
  file_path: string;
  workspace_dir: string;
  exchange_dir: string;
  telegram_message_id?: number | undefined;
  url?: string | undefined;
  title?: string | undefined;
};

export type BrowserCloseInput = {
  session_id?: string | undefined;
};

export type BrowserCloseOutput = {
  session_id: string;
  closed: boolean;
};
