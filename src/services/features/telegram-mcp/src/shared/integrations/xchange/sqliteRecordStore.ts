import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  XchangeRecord,
  XchangeRecordCategory,
  XchangeRecordDirection,
  XchangeRecordStatus,
} from "../../../entities/xchange/model/types";
import { ensureXchangeDir } from "../tmux/client";
import type { TmuxRuntimeConfig } from "../tmux/client";

type JsonAttachment = XchangeRecord["attachments"];
type JsonStringArray = string[];

type ListFilter = {
  status?: XchangeRecordStatus | undefined;
  category?: XchangeRecordCategory | undefined;
  direction?: XchangeRecordDirection | undefined;
  limit?: number | undefined;
};

type RowRecord = {
  record_id: string;
  session_id: string;
  category: XchangeRecordCategory;
  direction: XchangeRecordDirection;
  status: XchangeRecordStatus;
  kind: string | null;
  summary: string;
  body_text: string;
  action_desc: string;
  tools_json: string;
  note_path: string | null;
  note_relative_path: string | null;
  source_session_id: string | null;
  source_label: string | null;
  source_client_uuid: string | null;
  source_local_session_id: string | null;
  target_session_id: string | null;
  target_label: string | null;
  target_client_uuid: string | null;
  target_local_session_id: string | null;
  project_uuid: string | null;
  project_name: string | null;
  requires_reply: number | null;
  expected_reply: string | null;
  in_reply_to: string | null;
  attachments_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  read_at: string | null;
};

const DB_FILE_NAME = "xchange.sqlite3";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw?.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: RowRecord): XchangeRecord {
  return {
    record_id: row.record_id,
    session_id: row.session_id,
    category: row.category,
    direction: row.direction,
    status: row.status,
    ...(row.kind ? { kind: row.kind } : {}),
    summary: row.summary,
    body_text: row.body_text,
    action_desc: row.action_desc,
    tools: parseJson<JsonStringArray>(row.tools_json, []),
    ...(row.note_path ? { note_path: row.note_path } : {}),
    ...(row.note_relative_path ? { note_relative_path: row.note_relative_path } : {}),
    ...(row.source_session_id ? { source_session_id: row.source_session_id } : {}),
    ...(row.source_label ? { source_label: row.source_label } : {}),
    ...(row.source_client_uuid ? { source_client_uuid: row.source_client_uuid } : {}),
    ...(row.source_local_session_id
      ? { source_local_session_id: row.source_local_session_id }
      : {}),
    ...(row.target_session_id ? { target_session_id: row.target_session_id } : {}),
    ...(row.target_label ? { target_label: row.target_label } : {}),
    ...(row.target_client_uuid ? { target_client_uuid: row.target_client_uuid } : {}),
    ...(row.target_local_session_id
      ? { target_local_session_id: row.target_local_session_id }
      : {}),
    ...(row.project_uuid ? { project_uuid: row.project_uuid } : {}),
    ...(row.project_name ? { project_name: row.project_name } : {}),
    ...(row.requires_reply !== null
      ? { requires_reply: Boolean(row.requires_reply) }
      : {}),
    ...(row.expected_reply ? { expected_reply: row.expected_reply } : {}),
    ...(row.in_reply_to ? { in_reply_to: row.in_reply_to } : {}),
    attachments: parseJson<JsonAttachment>(row.attachments_json, []),
    tags: parseJson<JsonStringArray>(row.tags_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.read_at ? { read_at: row.read_at } : {}),
  };
}

async function resolveDbPath(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
): Promise<string> {
  const dir = await ensureXchangeDir(config, workspaceDir, exchangeDirName);
  return path.join(dir, DB_FILE_NAME);
}

function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS xchange_records (
      record_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT,
      summary TEXT NOT NULL,
      body_text TEXT NOT NULL,
      action_desc TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      note_path TEXT,
      note_relative_path TEXT,
      source_session_id TEXT,
      source_label TEXT,
      source_client_uuid TEXT,
      source_local_session_id TEXT,
      target_session_id TEXT,
      target_label TEXT,
      target_client_uuid TEXT,
      target_local_session_id TEXT,
      project_uuid TEXT,
      project_name TEXT,
      requires_reply INTEGER,
      expected_reply TEXT,
      in_reply_to TEXT,
      attachments_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      read_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_xchange_records_session_created
      ON xchange_records(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xchange_records_session_status
      ON xchange_records(session_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xchange_records_session_category
      ON xchange_records(session_id, category, created_at DESC);
  `);
}

async function withDatabase<T>(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  callback: (db: DatabaseSync) => T,
): Promise<T> {
  const dbPath = await resolveDbPath(config, workspaceDir, exchangeDirName);
  const db = new DatabaseSync(dbPath);

  try {
    applySchema(db);
    return callback(db);
  } finally {
    db.close();
  }
}

export async function upsertXchangeRecord(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  record: XchangeRecord,
): Promise<void> {
  await withDatabase(config, workspaceDir, exchangeDirName, (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO xchange_records (
        record_id, session_id, category, direction, status, kind, summary, body_text, action_desc,
        tools_json, note_path, note_relative_path, source_session_id, source_label,
        source_client_uuid, source_local_session_id, target_session_id, target_label,
        target_client_uuid, target_local_session_id, project_uuid, project_name, requires_reply,
        expected_reply, in_reply_to, attachments_json, tags_json, created_at, updated_at, read_at
      ) VALUES (
        @record_id, @session_id, @category, @direction, @status, @kind, @summary, @body_text, @action_desc,
        @tools_json, @note_path, @note_relative_path, @source_session_id, @source_label,
        @source_client_uuid, @source_local_session_id, @target_session_id, @target_label,
        @target_client_uuid, @target_local_session_id, @project_uuid, @project_name, @requires_reply,
        @expected_reply, @in_reply_to, @attachments_json, @tags_json, @created_at, @updated_at, @read_at
      )
    `).run({
      record_id: record.record_id,
      session_id: record.session_id,
      category: record.category,
      direction: record.direction,
      status: record.status,
      kind: record.kind ?? null,
      summary: record.summary,
      body_text: record.body_text,
      action_desc: record.action_desc,
      tools_json: JSON.stringify(record.tools),
      note_path: record.note_path ?? null,
      note_relative_path: record.note_relative_path ?? null,
      source_session_id: record.source_session_id ?? null,
      source_label: record.source_label ?? null,
      source_client_uuid: record.source_client_uuid ?? null,
      source_local_session_id: record.source_local_session_id ?? null,
      target_session_id: record.target_session_id ?? null,
      target_label: record.target_label ?? null,
      target_client_uuid: record.target_client_uuid ?? null,
      target_local_session_id: record.target_local_session_id ?? null,
      project_uuid: record.project_uuid ?? null,
      project_name: record.project_name ?? null,
      requires_reply:
        typeof record.requires_reply === "boolean"
          ? Number(record.requires_reply)
          : null,
      expected_reply: record.expected_reply ?? null,
      in_reply_to: record.in_reply_to ?? null,
      attachments_json: JSON.stringify(record.attachments),
      tags_json: JSON.stringify(record.tags),
      created_at: record.created_at,
      updated_at: record.updated_at,
      read_at: record.read_at ?? null,
    });
  });
}

export async function listXchangeRecords(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  sessionId: string,
  filter: ListFilter = {},
): Promise<XchangeRecord[]> {
  return withDatabase(config, workspaceDir, exchangeDirName, (db) => {
    const conditions = ["session_id = ?"];
    const values: Array<string | number> = [sessionId];

    if (filter.status) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter.category) {
      conditions.push("category = ?");
      values.push(filter.category);
    }
    if (filter.direction) {
      conditions.push("direction = ?");
      values.push(filter.direction);
    }

    let sql = `
      SELECT * FROM xchange_records
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
    `;
    if (typeof filter.limit === "number" && Number.isFinite(filter.limit)) {
      sql += " LIMIT ?";
      values.push(Math.max(1, Math.trunc(filter.limit)));
    }

    const rows = db.prepare(sql).all(...values) as RowRecord[];
    return rows.map(toRecord);
  });
}

export async function getXchangeRecord(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  sessionId: string,
  recordId: string,
): Promise<XchangeRecord | null> {
  return withDatabase(config, workspaceDir, exchangeDirName, (db) => {
    const row = db.prepare(`
      SELECT * FROM xchange_records
      WHERE session_id = ? AND record_id = ?
      LIMIT 1
    `).get(sessionId, recordId) as RowRecord | undefined;

    return row ? toRecord(row) : null;
  });
}

export async function markXchangeRecordRead(
  config: TmuxRuntimeConfig,
  workspaceDir: string,
  exchangeDirName: string,
  sessionId: string,
  recordId: string,
  readAt: string = new Date().toISOString(),
): Promise<boolean> {
  return withDatabase(config, workspaceDir, exchangeDirName, (db) => {
    const result = db.prepare(`
      UPDATE xchange_records
      SET status = 'read', updated_at = ?, read_at = COALESCE(read_at, ?)
      WHERE session_id = ? AND record_id = ?
    `).run(readAt, readAt, sessionId, recordId);

    return (result.changes ?? 0) > 0;
  });
}
