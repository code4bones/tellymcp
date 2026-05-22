export type PartnerNoteKind =
  | "share"
  | "question"
  | "reply"
  | "request"
  | "handoff";

export type PartnerArtifactRef = {
  file_path: string;
  relative_path?: string | undefined;
  original_name?: string | undefined;
  mime_type?: string | undefined;
  size_bytes?: number | undefined;
  storage_ref?: string | undefined;
  content_base64?: string | undefined;
};

export type SendPartnerNoteInput = {
  session_id?: string | undefined;
  target_session_id?: string | undefined;
  target_client_uuid?: string | undefined;
  target_local_session_id?: string | undefined;
  project_uuid?: string | undefined;
  kind: PartnerNoteKind;
  summary: string;
  message: string;
  expected_reply?: string | undefined;
  requires_reply?: boolean | undefined;
  in_reply_to?: string | undefined;
  artifacts?: string[] | undefined;
  artifact_refs?: PartnerArtifactRef[] | undefined;
};

export type SendPartnerFileInput = {
  session_id?: string | undefined;
  target_session_id?: string | undefined;
  target_client_uuid?: string | undefined;
  target_local_session_id?: string | undefined;
  project_uuid?: string | undefined;
  cwd?: string | undefined;
  file_path: string;
  kind?: PartnerNoteKind | undefined;
  summary?: string | undefined;
  message?: string | undefined;
  expected_reply?: string | undefined;
  requires_reply?: boolean | undefined;
  in_reply_to?: string | undefined;
};

export type SendPartnerNoteOutput = {
  session_id: string;
  partner_session_id: string;
  target_client_uuid?: string | undefined;
  target_local_session_id?: string | undefined;
  project_name?: string | undefined;
  target_actor_label?: string | undefined;
  target_session_label?: string | undefined;
  kind: PartnerNoteKind;
  share_id: string;
  delivery_status: "queued" | "delivered";
  note_path: string;
  xchange_record_id: string;
  copied_artifacts: string[];
  inbox_message_id: string;
  requires_reply: boolean;
};

export type ListGatewaySessionsInput = {
  client_uuid?: string | undefined;
  connected_only?: boolean | undefined;
};

export type GatewayKnownSessionRecord = {
  session_id: string;
  client_uuid: string;
  local_session_id: string;
  session_label?: string | null | undefined;
  client_label?: string | null | undefined;
  system_username?: string | null | undefined;
  telegram_username?: string | null | undefined;
  telegram_display_name?: string | null | undefined;
  bot_username?: string | null | undefined;
  node_id?: string | undefined;
  package_version?: string | undefined;
  project_uuids?: string[] | undefined;
  project_names?: string[] | undefined;
  connected: boolean;
  registered: boolean;
};

export type ListGatewaySessionsOutput = {
  total: number;
  sessions: GatewayKnownSessionRecord[];
};
