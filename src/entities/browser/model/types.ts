export type BrowserOpenInput = {
  session_id?: string | undefined;
  url: string;
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
  selector?: string | undefined;
  text?: string | undefined;
  exact?: boolean | undefined;
  timeout_ms?: number | undefined;
};

export type BrowserClickInput = BrowserLocatorInput;

export type BrowserClickOutput = {
  session_id: string;
  clicked: boolean;
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
  selector?: string | undefined;
  text?: string | undefined;
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
  selector?: string | undefined;
  text?: string | undefined;
  url: string;
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
