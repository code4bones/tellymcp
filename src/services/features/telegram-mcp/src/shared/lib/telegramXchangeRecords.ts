import type { AppConfig } from "../../app/config/env";
import type { SessionContext } from "../../entities/session/model/types";
import type { XchangeRecordAttachment } from "../../entities/xchange/model/types";
import {
  detectIncomingTelegramBrowserScreenshotRequest,
  buildIncomingTelegramMessageActionDesc,
  buildIncomingTelegramMessageTools,
} from "./xchangeRecordHints";
import { createInboxMessageId } from "./ids/ids";
import { upsertXchangeRecord } from "../integrations/xchange/sqliteRecordStore";

function resolveWorkspaceDir(
  session: SessionContext | null,
  sessionId: string,
): string {
  const workspaceDir = session?.cwd?.trim();
  if (!workspaceDir) {
    throw new Error(`Workspace cwd is not registered for console '${sessionId}'.`);
  }
  return workspaceDir;
}

export function deriveXchangeSummary(
  text: string,
  fallback: string,
): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const summary = firstLine || fallback;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

export async function writeTelegramMessageXchangeRecord(input: {
  config: AppConfig;
  session: SessionContext | null;
  sessionId: string;
  text: string;
  createdAt: string;
  attachments?: XchangeRecordAttachment[];
  summary?: string;
  kind?: "question" | "request" | "share" | "reply" | "handoff";
  tags?: string[];
}): Promise<string> {
  const recordId = createInboxMessageId(new Date(input.createdAt));
  const workspaceDir = resolveWorkspaceDir(input.session, input.sessionId);
  const kind = input.kind ?? "request";
  const prefersBrowserScreenshot =
    detectIncomingTelegramBrowserScreenshotRequest({
      kind,
      text: input.text,
      ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    });

  await upsertXchangeRecord(
    input.config.terminal,
    workspaceDir,
    input.config.exchange.dir,
    {
      record_id: recordId,
      session_id: input.sessionId,
      category: "telegram_message",
      direction: "incoming",
      status: "new",
      kind,
      summary:
        input.summary?.trim() ||
        deriveXchangeSummary(input.text, "Telegram message"),
      body_text: input.text,
      action_desc: buildIncomingTelegramMessageActionDesc(
        kind,
        prefersBrowserScreenshot,
      ),
      tools: buildIncomingTelegramMessageTools(kind, prefersBrowserScreenshot),
      attachments: input.attachments ?? [],
      tags: input.tags ?? ["telegram", "human"],
      created_at: input.createdAt,
      updated_at: input.createdAt,
    },
  );

  return recordId;
}

export async function writeLocalTaskXchangeRecord(input: {
  config: AppConfig;
  session: SessionContext | null;
  sessionId: string;
  category?: "local_handoff" | "telegram_message";
  direction?: "local" | "incoming";
  text: string;
  createdAt: string;
  summary: string;
  kind?: string;
  actionDesc: string;
  tools: string[];
  attachments?: XchangeRecordAttachment[];
  tags?: string[];
}): Promise<string> {
  const recordId = createInboxMessageId(new Date(input.createdAt));
  const workspaceDir = resolveWorkspaceDir(input.session, input.sessionId);

  await upsertXchangeRecord(
    input.config.terminal,
    workspaceDir,
    input.config.exchange.dir,
    {
      record_id: recordId,
      session_id: input.sessionId,
      category: input.category ?? "local_handoff",
      direction: input.direction ?? "local",
      status: "new",
      ...(input.kind ? { kind: input.kind } : {}),
      summary: input.summary.trim(),
      body_text: input.text,
      action_desc: input.actionDesc,
      tools: input.tools,
      attachments: input.attachments ?? [],
      tags: input.tags ?? ["local", "task"],
      created_at: input.createdAt,
      updated_at: input.createdAt,
    },
  );

  return recordId;
}
