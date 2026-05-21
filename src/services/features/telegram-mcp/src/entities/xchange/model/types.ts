export type XchangeRecordCategory =
  | "partner_note"
  | "local_handoff"
  | "telegram_message";

export type XchangeRecordDirection = "incoming" | "outgoing" | "local";

export type XchangeRecordStatus = "new" | "read" | "archived";

export type XchangeRecordAttachment = {
  file_path: string;
  relative_path?: string | undefined;
  original_name?: string | undefined;
  mime_type?: string | undefined;
  size_bytes?: number | undefined;
  storage_ref?: string | undefined;
};

export type XchangeRecord = {
  record_id: string;
  session_id: string;
  category: XchangeRecordCategory;
  direction: XchangeRecordDirection;
  status: XchangeRecordStatus;
  kind?: string | undefined;
  summary: string;
  body_text: string;
  action_desc: string;
  tools: string[];
  note_path?: string | undefined;
  note_relative_path?: string | undefined;
  source_session_id?: string | undefined;
  source_label?: string | undefined;
  source_client_uuid?: string | undefined;
  source_local_session_id?: string | undefined;
  target_session_id?: string | undefined;
  target_label?: string | undefined;
  target_client_uuid?: string | undefined;
  target_local_session_id?: string | undefined;
  project_uuid?: string | undefined;
  project_name?: string | undefined;
  requires_reply?: boolean | undefined;
  expected_reply?: string | undefined;
  in_reply_to?: string | undefined;
  attachments: XchangeRecordAttachment[];
  tags: string[];
  created_at: string;
  updated_at: string;
  read_at?: string | undefined;
};

export type ListXchangeRecordsInput = {
  session_id?: string | undefined;
  status?: XchangeRecordStatus | undefined;
  category?: XchangeRecordCategory | undefined;
  direction?: XchangeRecordDirection | undefined;
  limit?: number | undefined;
};

export type ListXchangeRecordsOutput = {
  session_id: string;
  total: number;
  records: XchangeRecord[];
};

export type GetXchangeRecordInput = {
  session_id?: string | undefined;
  record_id: string;
};

export type GetXchangeRecordOutput = {
  session_id: string;
  record: XchangeRecord | null;
};

export type MarkXchangeRecordReadInput = {
  session_id?: string | undefined;
  record_id: string;
};

export type MarkXchangeRecordReadOutput = {
  session_id: string;
  record_id: string;
  updated: boolean;
};
