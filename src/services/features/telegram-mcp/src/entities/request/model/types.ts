import type { RiskLevel } from "../../../shared/types/common";

export type AskUserTelegramInput = {
  question: string;
  task?: string | undefined;
  context?: string | undefined;
  affected_files?: string[] | undefined;
  options?: string[] | undefined;
  recommended_option?: string | undefined;
  risk_level?: RiskLevel | undefined;
  timeout_seconds?: number | undefined;
  fallback_if_timeout?: string | undefined;
  session_id?: string | undefined;
  use_saved_context?: boolean | undefined;
};

export type AskUserTelegramOutput = {
  request_id: string;
  answer: string | null;
  timed_out: boolean;
  received_at?: string | undefined;
  fallback_used?: string | undefined;
};

export type NotifyTelegramInput = {
  session_id?: string | undefined;
  message: string;
  task?: string | undefined;
  context?: string | undefined;
  risk_level?: RiskLevel | undefined;
  use_saved_context?: boolean | undefined;
};

export type NotifyTelegramOutput = {
  sent: boolean;
  message_id?: number | undefined;
};

export type SendFileToTelegramInput = {
  session_id?: string | undefined;
  cwd?: string | undefined;
  file_path: string;
  caption?: string | undefined;
};

export type SendFileToTelegramOutput = {
  session_id: string;
  file_path: string;
  sent: boolean;
  message_id?: number | undefined;
};

export type GetFileInput = {
  session_id?: string | undefined;
  file_path?: string | undefined;
  selector?: "latest_screenshot" | undefined;
  type?: "url" | "image" | "text" | "base64" | undefined;
};

export type GetFileOutput = {
  type: "url" | "image" | "text" | "base64";
  data: string;
  mimetype: string;
  filename: string;
  size_bytes: number;
  expires_at?: string | undefined;
};

export type GetFileListSource =
  | "telegram-upload"
  | "browser-screenshot"
  | "partner-artifact";

export type GetFileListInput = {
  session_id?: string | undefined;
  source?: GetFileListSource | undefined;
  limit?: number | undefined;
};

export type GetFileListOutput = {
  total: number;
  files: Array<{
    file_path: string;
    filename: string;
    mimetype: string;
    source: GetFileListSource;
    size_bytes?: number | undefined;
    created_at: string;
  }>;
};

export type RefreshToolsMarkdownInput = {
  session_id?: string | undefined;
  cwd?: string | undefined;
  known_hash?: string | undefined;
};

export type RefreshToolsMarkdownOutput = {
  source: "gateway" | "local";
  session_id?: string | undefined;
  current_hash: string;
  changed: boolean;
  content?: string | undefined;
  bytes: number;
};

export type SendPartnerFileInput = {
  session_id?: string | undefined;
  target_session_id?: string | undefined;
  project_uuid?: string | undefined;
  cwd?: string | undefined;
  file_path: string;
  kind?: "share" | "question" | "reply" | "request" | "handoff" | undefined;
  summary?: string | undefined;
  message?: string | undefined;
  expected_reply?: string | undefined;
  requires_reply?: boolean | undefined;
  in_reply_to?: string | undefined;
};

export type PendingRequestStatus =
  | "queued"
  | "active"
  | "answered"
  | "timed_out"
  | "failed";

export type PendingRequestRecord = {
  requestId: string;
  sessionId: string;
  sessionLabel?: string | undefined;
  question: string;
  task?: string | undefined;
  context?: string | undefined;
  affectedFiles?: string[] | undefined;
  options?: string[] | undefined;
  recommendedOption?: string | undefined;
  riskLevel?: RiskLevel | undefined;
  timeoutSeconds: number;
  fallbackIfTimeout?: string | undefined;
  telegramChatId: number;
  telegramUserId: number;
  telegramMessageId?: number | undefined;
  queuedAt: string;
  sentAt?: string | undefined;
  receivedAt?: string | undefined;
  answer?: string | undefined;
  status: PendingRequestStatus;
};

export type PendingResolution = {
  status: Exclude<PendingRequestStatus, "queued" | "active">;
  answer?: string | undefined;
  receivedAt?: string | undefined;
  fallbackUsed?: string | undefined;
  errorMessage?: string | undefined;
};
