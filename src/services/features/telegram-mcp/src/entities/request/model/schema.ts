import * as z from "zod/v4";
import { MAX_BODY_SIZE_BYTES } from "../../../shared/lib/bodyLimits";

const bodyStringSchema = z.string().max(MAX_BODY_SIZE_BYTES);

const partnerNoteKindSchema = z.enum([
  "share",
  "question",
  "reply",
  "request",
  "handoff",
]);

export const askUserTelegramInputSchema = z.object({
  question: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  affected_files: z.array(z.string().trim().min(1)).optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  recommended_option: z.string().trim().min(1).optional(),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  timeout_seconds: z.number().int().positive().optional(),
  fallback_if_timeout: z.string().trim().min(1).optional(),
  session_id: z.string().trim().min(1).optional(),
  use_saved_context: z.boolean().optional(),
});

export const askUserTelegramOutputSchema = z.object({
  request_id: z.string(),
  answer: z.string().nullable(),
  timed_out: z.boolean(),
  received_at: z.string().optional(),
  fallback_used: z.string().optional(),
});

export const notifyTelegramInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  use_saved_context: z.boolean().optional(),
});

export const notifyTelegramOutputSchema = z.object({
  sent: z.boolean(),
  message_id: z.number().int().positive().optional(),
});

export const sendFileToTelegramInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  file_path: z.string().trim().min(1),
  caption: z.string().trim().min(1).optional(),
});

export const sendFileToTelegramOutputSchema = z.object({
  session_id: z.string(),
  file_path: z.string(),
  sent: z.boolean(),
  message_id: z.number().int().positive().optional(),
});

export const listGatewaySessionsInputSchema = z.object({
  client_uuid: z.string().trim().min(1).optional(),
  connected_only: z.boolean().optional(),
});

export const listGatewaySessionsOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  sessions: z.array(
    z.object({
      session_id: z.string().trim().min(1),
      client_uuid: z.string().trim().min(1),
      local_session_id: z.string().trim().min(1),
      session_label: z.string().nullable().optional(),
      client_label: z.string().nullable().optional(),
      telegram_username: z.string().nullable().optional(),
      telegram_display_name: z.string().nullable().optional(),
      bot_username: z.string().nullable().optional(),
      node_id: z.string().trim().min(1).optional(),
      package_version: z.string().trim().min(1).optional(),
      project_uuids: z.array(z.string().trim().min(1)).optional(),
      project_names: z.array(z.string().trim().min(1)).optional(),
      connected: z.boolean(),
      registered: z.boolean(),
    }),
  ),
});

export const refreshToolsMarkdownInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  known_hash: z.string().trim().min(1).optional(),
});

export const refreshToolsMarkdownOutputSchema = z.object({
  source: z.enum(["gateway", "local"]),
  session_id: z.string().trim().min(1).optional(),
  current_hash: z.string().trim().min(1),
  changed: z.boolean(),
  content: z.string().optional(),
  bytes: z.number().int().nonnegative(),
});

export const setSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  session_label: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).optional(),
  decisions: z.array(z.string().trim().min(1)).optional(),
  risks: z.array(z.string().trim().min(1)).optional(),
});

export const renameSessionInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
});

export const renameSessionOutputSchema = z.object({
  renamed: z.boolean(),
  session_id: z.string(),
  session_label: z.string(),
  updated_at: z.string(),
});

export const setSessionContextOutputSchema = z.object({
  saved: z.boolean(),
  session_id: z.string(),
  updated_at: z.string(),
  has_binding: z.boolean(),
});

export const getSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getSessionContextOutputSchema = z.object({
  session_id: z.string(),
  exists: z.boolean(),
  has_binding: z.boolean(),
  status_message: z.string(),
  context: z
    .object({
      session_label: z.string().optional(),
      cwd: z.string().optional(),
      task: z.string().optional(),
      summary: z.string().optional(),
      files: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      updated_at: z.string().optional(),
    })
    .optional(),
  binding: z
    .object({
      telegram_chat_id: z.number(),
      telegram_user_id: z.number(),
      linked_at: z.string(),
    })
    .optional(),
  terminal: z
    .object({
      configured: z.boolean(),
      terminal_target: z.string().optional(),
      last_nudge_at: z.string().optional(),
    })
    .optional(),
});

export const clearSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const clearSessionContextOutputSchema = z.object({
  cleared: z.boolean(),
  session_id: z.string(),
  cleared_pairing: z.boolean(),
});

export const browserOpenInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1),
  width: z.number().int().positive().max(10000).optional(),
  height: z.number().int().positive().max(10000).optional(),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle", "commit"])
    .optional(),
  reset_context: z.boolean().optional(),
});

export const browserOpenOutputSchema = z.object({
  session_id: z.string(),
  opened: z.boolean(),
  created_context: z.boolean(),
  url: z.string().url(),
  title: z.string().optional(),
  viewport_width: z.number().int().positive().optional(),
  viewport_height: z.number().int().positive().optional(),
});

export const browserListAttachedInstancesInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserListAttachedInstancesOutputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  total: z.number().int().nonnegative(),
  instances: z.array(
    z.object({
      instance_id: z.string().trim().min(1),
      browser: z.enum(["firefox", "chrome"]),
      extension_version: z.string().trim().min(1),
      profile_name: z.string().trim().min(1).optional(),
      connected_at: z.string().trim().min(1),
      last_seen_at: z.string().trim().min(1),
      capabilities: z.array(z.string().trim().min(1)),
      tab_count: z.number().int().nonnegative(),
      active_tab: z
        .object({
          tab_id: z.number().int().nonnegative(),
          window_id: z.number().int().nonnegative().optional(),
          active: z.boolean(),
          title: z.string(),
          url: z.string(),
          status: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

export const browserListTabsInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  instance_id: z.string().trim().min(1).optional(),
});

export const browserListTabsOutputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  instance_id: z.string().trim().min(1),
  total: z.number().int().nonnegative(),
  tabs: z.array(
    z.object({
      tab_id: z.number().int().nonnegative(),
      window_id: z.number().int().nonnegative().optional(),
      active: z.boolean(),
      selected: z.boolean().optional(),
      title: z.string(),
      url: z.string(),
      status: z.string().optional(),
    }),
  ),
});

export const browserAttachActiveTabInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  instance_id: z.string().trim().min(1).optional(),
});

export const browserAttachTabInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  instance_id: z.string().trim().min(1).optional(),
  tab_id: z.number().int().nonnegative(),
});

export const browserAttachTabOutputSchema = z.object({
  session_id: z.string().trim().min(1),
  backend: z.literal("firefox-attached"),
  instance_id: z.string().trim().min(1),
  tab_id: z.number().int().nonnegative(),
  attached_at: z.string().trim().min(1),
  title: z.string().optional(),
  url: z.string().optional(),
});

export const browserDetachTabInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserDetachTabOutputSchema = z.object({
  session_id: z.string().trim().min(1),
  detached: z.boolean(),
});

export const browserRecordingStartInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  instance_id: z.string().trim().min(1).optional(),
});

export const browserRecordingStartOutputSchema = z.object({
  session_id: z.string().trim().min(1),
  backend: z.literal("firefox-attached"),
  started: z.boolean(),
  recording_id: z.string().trim().min(1),
  instance_id: z.string().trim().min(1),
  tab_id: z.number().int().nonnegative(),
  tab_title: z.string().optional(),
  tab_url: z.string().optional(),
  bundle_dir_name: z.string().trim().min(1),
  bundle_relative_path: z.string().trim().min(1),
  bundle_path: z.string().trim().min(1),
  started_at: z.string().trim().min(1),
});

export const browserRecordingStopInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserRecordingStopOutputSchema = z.object({
  session_id: z.string().trim().min(1),
  stopped: z.boolean(),
  recording_id: z.string().trim().min(1).optional(),
  bundle_dir_name: z.string().trim().min(1).optional(),
  bundle_relative_path: z.string().trim().min(1).optional(),
  bundle_path: z.string().trim().min(1).optional(),
  stopped_at: z.string().trim().min(1).optional(),
});

export const browserRecordingStatusInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserRecordingStatusOutputSchema = z.object({
  session_id: z.string().trim().min(1),
  active: z.boolean(),
  recording: z
    .object({
      backend: z.literal("firefox-attached"),
      recording_id: z.string().trim().min(1),
      instance_id: z.string().trim().min(1),
      tab_id: z.number().int().nonnegative(),
      tab_title: z.string().optional(),
      tab_url: z.string().optional(),
      bundle_dir_name: z.string().trim().min(1),
      bundle_relative_path: z.string().trim().min(1),
      bundle_path: z.string().trim().min(1),
      started_at: z.string().trim().min(1),
      stopped_at: z.string().trim().min(1).optional(),
      status: z.enum(["recording", "stopped"]),
      event_count: z.number().int().nonnegative(),
      last_event_at: z.string().trim().min(1).optional(),
    })
    .optional(),
});

export const browserReloadInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle", "commit"])
    .optional(),
});

export const browserReloadOutputSchema = z.object({
  session_id: z.string(),
  reloaded: z.boolean(),
  url: z.string(),
  title: z.string().optional(),
});

const browserLocatorInputShape = {
  session_id: z.string().trim().min(1).optional(),
  ai_tag: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  exact: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(120000).optional(),
};

export const browserClickInputSchema = z
  .object(browserLocatorInputShape)
  .refine((input) => Boolean(input.ai_tag || input.selector || input.text), {
    message: "Provide ai_tag, selector, or text.",
    path: ["ai_tag"],
  });

export const browserClickOutputSchema = z.object({
  session_id: z.string(),
  clicked: z.boolean(),
  ai_tag: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  url: z.string(),
  title: z.string().optional(),
});

export const browserFillInputSchema = z
  .object({
    ...browserLocatorInputShape,
    value: z.string(),
  })
  .refine((input) => Boolean(input.ai_tag || input.selector || input.text), {
    message: "Provide ai_tag, selector, or text.",
    path: ["ai_tag"],
  });

export const browserFillOutputSchema = z.object({
  session_id: z.string(),
  filled: z.boolean(),
  ai_tag: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  value_length: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string().optional(),
});

export const browserPressInputSchema = z.object({
  ...browserLocatorInputShape,
  key: z.string().trim().min(1),
});

export const browserPressOutputSchema = z.object({
  session_id: z.string(),
  pressed: z.boolean(),
  key: z.string(),
  ai_tag: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  url: z.string(),
  title: z.string().optional(),
});

export const browserInjectScriptInputSchema = z
  .object({
    session_id: z.string().trim().min(1).optional(),
    source: z.string().optional(),
    file_path: z.string().trim().min(1).optional(),
    namespace: z.string().trim().min(1).optional(),
  })
  .refine((input) => Boolean(input.source?.trim() || input.file_path?.trim()), {
    message: "Provide source or file_path.",
    path: ["source"],
  });

export const browserInjectScriptOutputSchema = z.object({
  session_id: z.string(),
  injected: z.boolean(),
  namespace: z.string(),
  source_type: z.enum(["inline", "file"]),
  bytes: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string().optional(),
});

export const browserWaitForInputSchema = z
  .object({
    ...browserLocatorInputShape,
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
  })
  .refine((input) => Boolean(input.ai_tag || input.selector || input.text), {
    message: "Provide ai_tag, selector, or text.",
    path: ["ai_tag"],
  });

export const browserWaitForOutputSchema = z.object({
  session_id: z.string(),
  waited: z.boolean(),
  state: z.enum(["attached", "detached", "visible", "hidden"]),
  ai_tag: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  url: z.string(),
  title: z.string().optional(),
});

export const browserWaitForUrlInputSchema = z
  .object({
    session_id: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    url_contains: z.string().trim().min(1).optional(),
    timeout_ms: z.number().int().positive().max(120000).optional(),
  })
  .refine((input) => Boolean(input.url || input.url_contains), {
    message: "Provide url or url_contains.",
    path: ["url"],
  });

export const browserWaitForUrlOutputSchema = z.object({
  session_id: z.string(),
  waited: z.boolean(),
  matched: z.enum(["url", "url_contains"]),
  url: z.string().optional(),
  url_contains: z.string().optional(),
  current_url: z.string(),
  title: z.string().optional(),
});

export const browserConsoleInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const browserConsoleOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      type: z.string(),
      text: z.string(),
      location: z.string().optional(),
      timestamp: z.string(),
    }),
  ),
});

export const browserErrorsInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const browserErrorsOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      message: z.string(),
      stack: z.string().optional(),
      timestamp: z.string(),
    }),
  ),
});

export const browserNetworkFailuresInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const browserNetworkFailuresOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
  failures: z.array(
    z.object({
      url: z.string(),
      method: z.string(),
      status: z.number().int().optional(),
      error_text: z.string().optional(),
      resource_type: z.string().optional(),
      timestamp: z.string(),
    }),
  ),
});

export const browserClearLogsInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserClearLogsOutputSchema = z.object({
  session_id: z.string(),
  cleared: z.boolean(),
  console_messages_cleared: z.number().int().nonnegative(),
  page_errors_cleared: z.number().int().nonnegative(),
  network_failures_cleared: z.number().int().nonnegative(),
});

export const browserDomInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  include_html: z.boolean().optional(),
  include_text: z.boolean().optional(),
});

export const browserDomOutputSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
  found: z.boolean(),
  url: z.string().url().optional(),
  title: z.string().optional(),
  outer_html: z.string().optional(),
  text_content: z.string().optional(),
  visible: z.boolean().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});

export const browserComputedStyleInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1),
  properties: z.array(z.string().trim().min(1)).optional(),
});

export const browserComputedStyleOutputSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
  found: z.boolean(),
  url: z.string().url().optional(),
  title: z.string().optional(),
  visible: z.boolean().optional(),
  styles: z.record(z.string(), z.string()).optional(),
  box: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export const browserScreenshotInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  full_page: z.boolean().optional(),
  file_name: z.string().trim().min(1).optional(),
  send_to_telegram: z.boolean().optional(),
  caption: z.string().trim().min(1).optional(),
});

export const browserScreenshotOutputSchema = z.object({
  session_id: z.string(),
  file_path: z.string(),
  workspace_dir: z.string(),
  exchange_dir: z.string(),
  telegram_message_id: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  title: z.string().optional(),
});

export const browserCloseInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const browserCloseOutputSchema = z.object({
  session_id: z.string(),
  closed: z.boolean(),
});

export const sendPartnerNoteInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  target_session_id: z.string().trim().min(1).optional(),
  target_client_uuid: z.string().trim().min(1).optional(),
  target_local_session_id: z.string().trim().min(1).optional(),
  project_uuid: z.string().trim().min(1).optional(),
  kind: partnerNoteKindSchema,
  summary: bodyStringSchema.trim().min(1),
  message: bodyStringSchema.trim().min(1),
  expected_reply: bodyStringSchema.trim().min(1).optional(),
  requires_reply: z.boolean().optional(),
  in_reply_to: z.string().trim().min(1).optional(),
  artifacts: z.array(z.string().trim().min(1)).optional(),
  artifact_refs: z
    .array(
      z.object({
        file_path: z.string().trim().min(1),
        relative_path: z.string().trim().min(1).optional(),
        original_name: z.string().trim().min(1).optional(),
        mime_type: z.string().trim().min(1).optional(),
        size_bytes: z.number().int().nonnegative().optional(),
        storage_ref: z.string().trim().min(1).optional(),
        content_base64: bodyStringSchema.trim().min(1).optional(),
      }),
    )
    .optional(),
});

export const sendPartnerFileInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  target_session_id: z.string().trim().min(1).optional(),
  target_client_uuid: z.string().trim().min(1).optional(),
  target_local_session_id: z.string().trim().min(1).optional(),
  project_uuid: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  file_path: z.string().trim().min(1),
  kind: partnerNoteKindSchema.optional(),
  summary: bodyStringSchema.trim().min(1).optional(),
  message: bodyStringSchema.trim().min(1).optional(),
  expected_reply: bodyStringSchema.trim().min(1).optional(),
  requires_reply: z.boolean().optional(),
  in_reply_to: z.string().trim().min(1).optional(),
});

export const sendPartnerNoteOutputSchema = z.object({
  session_id: z.string(),
  partner_session_id: z.string(),
  target_client_uuid: z.string().optional(),
  target_local_session_id: z.string().optional(),
  project_name: z.string().optional(),
  target_actor_label: z.string().optional(),
  target_session_label: z.string().optional(),
  kind: partnerNoteKindSchema,
  share_id: z.string(),
  delivery_status: z.enum(["queued", "delivered"]),
  note_path: z.string(),
  xchange_record_id: z.string(),
  copied_artifacts: z.array(z.string()),
  inbox_message_id: z.string(),
  requires_reply: z.boolean(),
});

const xchangeRecordAttachmentSchema = z.object({
  file_path: z.string(),
  relative_path: z.string().optional(),
  original_name: z.string().optional(),
  mime_type: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  storage_ref: z.string().optional(),
});

const xchangeRecordSchema = z.object({
  record_id: z.string(),
  session_id: z.string(),
  category: z.enum(["partner_note", "local_handoff", "telegram_message"]),
  direction: z.enum(["incoming", "outgoing", "local"]),
  status: z.enum(["new", "read", "archived"]),
  kind: z.string().optional(),
  summary: z.string(),
  body_text: z.string(),
  action_desc: z.string(),
  tools: z.array(z.string()),
  note_path: z.string().optional(),
  note_relative_path: z.string().optional(),
  source_session_id: z.string().optional(),
  source_label: z.string().optional(),
  source_client_uuid: z.string().optional(),
  source_local_session_id: z.string().optional(),
  target_session_id: z.string().optional(),
  target_label: z.string().optional(),
  target_client_uuid: z.string().optional(),
  target_local_session_id: z.string().optional(),
  project_uuid: z.string().optional(),
  project_name: z.string().optional(),
  requires_reply: z.boolean().optional(),
  expected_reply: z.string().optional(),
  in_reply_to: z.string().optional(),
  attachments: z.array(xchangeRecordAttachmentSchema),
  tags: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  read_at: z.string().optional(),
});

export const listXchangeRecordsInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  status: z.enum(["new", "read", "archived"]).optional(),
  category: z.enum(["partner_note", "local_handoff", "telegram_message"]).optional(),
  direction: z.enum(["incoming", "outgoing", "local"]).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const listXchangeRecordsOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
  records: z.array(xchangeRecordSchema),
});

export const getXchangeRecordInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  record_id: z.string().trim().min(1),
});

export const getXchangeRecordOutputSchema = z.object({
  session_id: z.string(),
  record: xchangeRecordSchema.nullable(),
});

export const markXchangeRecordReadInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  record_id: z.string().trim().min(1),
});

export const markXchangeRecordReadOutputSchema = z.object({
  session_id: z.string(),
  record_id: z.string(),
  updated: z.boolean(),
});
