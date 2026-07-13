import * as z from "zod/v4";

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_GENERIC_STRING_LENGTH = 8 * 1024 * 1024;
const MAX_GENERIC_ARRAY_ITEMS = 4096;
const MAX_GENERIC_OBJECT_KEYS = 512;
const MAX_GENERIC_DEPTH = 24;
const MAX_TABS = 4096;

const boundedString = z.string().max(MAX_TEXT_LENGTH);
const identifier = z.string().trim().min(1).max(MAX_ID_LENGTH);
const tabId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const validateBoundedJson = (
  value: unknown,
  context: z.core.$RefinementCtx<unknown>,
): void => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      break;
    }
    if (current.depth > MAX_GENERIC_DEPTH) {
      context.addIssue({
        code: "custom",
        message: `JSON nesting exceeds ${MAX_GENERIC_DEPTH} levels`,
      });
      return;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_GENERIC_STRING_LENGTH) {
        context.addIssue({
          code: "too_big",
          origin: "string",
          maximum: MAX_GENERIC_STRING_LENGTH,
          inclusive: true,
          message: `String exceeds ${MAX_GENERIC_STRING_LENGTH} characters`,
        });
        return;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_GENERIC_ARRAY_ITEMS) {
        context.addIssue({
          code: "too_big",
          origin: "array",
          maximum: MAX_GENERIC_ARRAY_ITEMS,
          inclusive: true,
          message: `Array exceeds ${MAX_GENERIC_ARRAY_ITEMS} items`,
        });
        return;
      }
      for (const item of current.value) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length > MAX_GENERIC_OBJECT_KEYS) {
        context.addIssue({
          code: "custom",
          message: `Object exceeds ${MAX_GENERIC_OBJECT_KEYS} keys`,
        });
        return;
      }
      for (const [, item] of entries) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
};

const boundedRecord = z
  .record(z.string().max(MAX_ID_LENGTH), z.unknown())
  .superRefine(validateBoundedJson);

export const firefoxAttachTabRecordSchema = z.strictObject({
  tab_id: tabId,
  window_id: tabId.optional(),
  active: z.boolean(),
  title: boundedString,
  url: boundedString,
  status: z.string().max(64).optional(),
});

const requestId = identifier;

export const firefoxAttachInboundMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    extension_version: z.string().trim().min(1).max(64),
    browser: z.enum(["firefox", "chrome"]),
    instance_id: identifier,
    profile_name: z.string().max(MAX_ID_LENGTH).optional(),
  }),
  z.strictObject({
    type: z.literal("heartbeat"),
    sent_at: z.string().min(1).max(64),
  }),
  z.strictObject({
    type: z.literal("list_tabs_result"),
    request_id: requestId,
    tabs: z.array(firefoxAttachTabRecordSchema).max(MAX_TABS),
  }),
  z.strictObject({
    type: z.literal("get_active_tab_result"),
    request_id: requestId,
    tab: firefoxAttachTabRecordSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("active_tab_changed"),
    tab: firefoxAttachTabRecordSchema,
  }),
  z.strictObject({
    type: z.literal("tab_updated"),
    tab: firefoxAttachTabRecordSchema,
  }),
  z.strictObject({
    type: z.literal("attach_tab_selected"),
    tab: firefoxAttachTabRecordSchema,
  }),
  z.strictObject({
    type: z.literal("tab_action_result"),
    request_id: requestId,
    ok: z.boolean(),
    result: boundedRecord.optional(),
    error: boundedString.optional(),
  }),
  z.strictObject({
    type: z.literal("recording_control_result"),
    request_id: requestId,
    ok: z.boolean(),
    active: z.boolean(),
    error: boundedString.optional(),
  }),
  z.strictObject({
    type: z.literal("recording_event"),
    recording_id: identifier,
    tab_id: tabId,
    event: boundedRecord,
  }),
  z.strictObject({
    type: z.literal("recording_manual_start"),
    request_id: requestId,
    tab: firefoxAttachTabRecordSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("recording_manual_stop"),
    request_id: requestId,
    tab: firefoxAttachTabRecordSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("recording_manual_status"),
    request_id: requestId,
    tab: firefoxAttachTabRecordSchema.optional(),
  }),
]);

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

export type FirefoxAttachInboundMessage = z.infer<
  typeof firefoxAttachInboundMessageSchema
>;

export type FirefoxAttachOutboundMessage =
  | FirefoxAttachHelloAck
  | FirefoxAttachListTabsRequest
  | FirefoxAttachGetActiveTabRequest
  | FirefoxAttachTabActionRequest
  | FirefoxAttachRecordingStartRequest
  | FirefoxAttachRecordingStopRequest
  | FirefoxAttachManualRecordingResult
  | FirefoxAttachRecordingStateEvent;
