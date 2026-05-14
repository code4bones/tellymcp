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
};

export type SendPartnerNoteInput = {
  session_id?: string | undefined;
  target_session_id?: string | undefined;
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

export type SendPartnerNoteOutput = {
  session_id: string;
  partner_session_id: string;
  kind: PartnerNoteKind;
  share_id: string;
  note_path: string;
  share_index_path: string;
  copied_artifacts: string[];
  inbox_message_id: string;
  requires_reply: boolean;
};
