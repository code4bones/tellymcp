export type SessionContext = {
  sessionId: string;
  label?: string | undefined;
  cwd?: string | undefined;
  task?: string | undefined;
  summary?: string | undefined;
  files?: string[] | undefined;
  decisions?: string[] | undefined;
  risks?: string[] | undefined;
  tmuxSessionName?: string | undefined;
  tmuxWindowName?: string | undefined;
  tmuxWindowIndex?: number | undefined;
  tmuxPaneId?: string | undefined;
  tmuxPaneIndex?: number | undefined;
  tmuxTarget?: string | undefined;
  lastTmuxNudgeAt?: string | undefined;
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
    linked_at: string;
  };
  tmux?: {
    configured: boolean;
    tmux_session_name?: string | undefined;
    tmux_window_name?: string | undefined;
    tmux_window_index?: number | undefined;
    tmux_pane_id?: string | undefined;
    tmux_pane_index?: number | undefined;
    tmux_target?: string | undefined;
    last_nudge_at?: string | undefined;
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

export type SetTmuxTargetInput = {
  session_id?: string | undefined;
  tmux_session_name?: string | undefined;
  tmux_window_name?: string | undefined;
  tmux_window_index?: number | undefined;
  tmux_pane_id?: string | undefined;
  tmux_pane_index?: number | undefined;
  tmux_target: string;
};

export type SetTmuxTargetOutput = {
  session_id: string;
  tmux_target: string;
  tmux_session_name?: string | undefined;
  tmux_window_name?: string | undefined;
  tmux_window_index?: number | undefined;
  tmux_pane_id?: string | undefined;
  tmux_pane_index?: number | undefined;
  status_message: string;
};

export type GetTmuxTargetInput = {
  session_id?: string | undefined;
};

export type GetTmuxTargetOutput = {
  session_id: string;
  configured: boolean;
  tmux_target?: string | undefined;
  tmux_session_name?: string | undefined;
  tmux_window_name?: string | undefined;
  tmux_window_index?: number | undefined;
  tmux_pane_id?: string | undefined;
  tmux_pane_index?: number | undefined;
  last_nudge_at?: string | undefined;
  status_message: string;
};
