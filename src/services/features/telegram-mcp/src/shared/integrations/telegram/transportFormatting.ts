import path from "node:path";

import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import type { AdminClientSessionViewRecord } from "./transportTypes";

export function buildAdminClientSessionButtonLabel(
  session: Pick<
    AdminClientSessionViewRecord,
    "label" | "local_session_id" | "project_name"
  >,
): string {
  const sessionName = (session.label?.trim() || session.local_session_id).trim();
  const projectName = session.project_name?.trim() || null;
  return projectName
    ? `${sessionName} · ${projectName}`.slice(0, 56)
    : sessionName.slice(0, 56);
}

export function buildAdminClientSessionViewButtonLabel(
  session: AdminClientSessionViewRecord,
): string {
  const markers = [
    session.is_connected ? "🟢" : null,
    session.is_collab ? "👥" : null,
  ]
    .filter(Boolean)
    .join("");
  const prefix = markers ? `${markers} ` : "";
  return `${prefix}${buildAdminClientSessionButtonLabel(session)}`.slice(0, 56);
}

export function formatFilePreviewLabel(
  filePath: string,
  meta?: {
    originalName?: string | undefined;
    relativePath?: string | undefined;
  } | null,
): string {
  return (
    meta?.originalName ||
    (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
    path.basename(filePath)
  );
}

export function formatStoragePreviewLabel(
  filePath: string,
  meta?: TelegramXchangeFileMeta | null,
): string {
  const base = formatFilePreviewLabel(filePath, meta);
  const prefix =
    meta?.source === "browser-screenshot"
      ? "📸 "
      : meta?.source === "partner-artifact"
        ? "🤝 "
        : "📄 ";
  return `${prefix}${base}`.slice(0, 56);
}

export function formatSessionMenuLabel(input: {
  sessionId: string;
  sessionLabel?: string;
  active: boolean;
}): string {
  const base = input.sessionLabel ?? input.sessionId;
  const activePrefix = input.active ? "✅ " : "📁 ";
  return `${activePrefix}${base}`;
}

export function buildInboxText(
  text: string | null,
  attachments: string[],
): string {
  const lines: string[] = [];

  if (text) {
    lines.push(text);
  }

  if (attachments.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Files saved in .mcp-xchange:");
    lines.push(...attachments.map((attachment) => `- ${attachment}`));
  }

  if (lines.length === 0) {
    return "Files uploaded from Telegram.";
  }

  return lines.join("\n");
}

export function parsePartnerNoteText(text: string): {
  summary: string;
  message: string;
} {
  const normalized = text.trim();
  const lines = normalized.split("\n");
  const summary = lines[0]?.trim() || normalized;
  const body = lines.slice(1).join("\n").replace(/^\s*\n/u, "").trim();

  return {
    summary,
    message: body || normalized,
  };
}
