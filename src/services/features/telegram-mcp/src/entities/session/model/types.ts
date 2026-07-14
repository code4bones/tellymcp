export type SessionContext = {
  sessionId: string;
  label?: string | undefined;
  cwd?: string | undefined;
  activeProjectUuid?: string | undefined;
  activeProjectName?: string | undefined;
  task?: string | undefined;
  summary?: string | undefined;
  files?: string[] | undefined;
  decisions?: string[] | undefined;
  risks?: string[] | undefined;
  terminalTarget?: string | undefined;
  lastTerminalNudgeAt?: string | undefined;
  lastSeenToolsHash?: string | undefined;
  lastNotifiedToolsHash?: string | undefined;
  updatedAt: string;
};

export type SetSessionContextInput = {
  session_id?: string | undefined;
  session_label?: string | undefined;
  task?: string | undefined;
  summary: string;
  files?: string[] | undefined;
  decisions?: string[] | undefined;
  risks?: string[] | undefined;
};

export type SetSessionContextOutput = {
  saved: boolean;
  session_id: string;
  updated_at: string;
  has_binding: boolean;
};

export type RenameSessionInput = {
  session_id?: string | undefined;
  title: string;
};

export type RenameSessionOutput = {
  renamed: boolean;
  session_id: string;
  session_label: string;
  updated_at: string;
};

export type GetSessionContextInput = {
  session_id?: string | undefined;
};

export type GetSessionContextOutput = {
  session_id: string;
  exists: boolean;
  has_binding: boolean;
  status_message: string;
  context?: {
    session_label?: string | undefined;
    cwd?: string | undefined;
    active_project_uuid?: string | undefined;
    active_project_name?: string | undefined;
    task?: string | undefined;
    summary?: string | undefined;
    files?: string[] | undefined;
    decisions?: string[] | undefined;
    risks?: string[] | undefined;
    updated_at?: string | undefined;
  };
  binding?: {
    telegram_chat_id: number;
    telegram_user_id: number;
    telegram_username?: string | undefined;
    linked_at: string;
  };
  terminal?: {
    configured: boolean;
    terminal_target?: string | undefined;
    last_nudge_at?: string | undefined;
  };
};

export type GetRuntimeDiagnosticsInput = {
  session_id?: string | undefined;
};

export type RuntimeDiagnosticCheck = {
  status: "ok" | "warn" | "error";
  message: string;
};

export type GetRuntimeDiagnosticsOutput = {
  status: "ok" | "degraded";
  checked_at: string;
  session_id: string;
  runtime: {
    mode: "client" | "gateway" | "both";
    package_version: string;
    protocol_version: string;
    node_id?: string | undefined;
  };
  checks: {
    configuration: RuntimeDiagnosticCheck;
    redis: RuntimeDiagnosticCheck;
    session_store: RuntimeDiagnosticCheck;
    terminal: RuntimeDiagnosticCheck;
    gateway_configuration: RuntimeDiagnosticCheck;
    relay: RuntimeDiagnosticCheck;
  };
};

export type ClearSessionContextInput = {
  session_id?: string | undefined;
};

export type ClearSessionContextOutput = {
  cleared: boolean;
  session_id: string;
  cleared_pairing: boolean;
};
