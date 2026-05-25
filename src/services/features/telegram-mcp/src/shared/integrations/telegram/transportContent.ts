import path from "node:path";

import type {
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type {
  TelegramAttachmentDescriptor,
  TelegramMenuContext,
} from "./transportTypes";
import { formatFilePreviewLabel } from "./transportFormatting";

export function formatStorageDetail(
  sessionId: string,
  filePath: string,
  meta?: TelegramXchangeFileMeta | null,
): string {
  return [
    "📦 Storage entry",
    "",
    `Session: ${sessionId}`,
    `File: ${formatFilePreviewLabel(filePath, meta)}`,
    ...(meta?.source ? [`Source: ${meta.source}`] : []),
    ...(meta?.uploadedAt ? [`Saved: ${meta.uploadedAt}`] : []),
    ...(meta?.relativePath ? [`Relative: ${meta.relativePath}`] : []),
    ...(meta?.mimeType ? [`MIME: ${meta.mimeType}`] : []),
    ...(typeof meta?.sizeBytes === "number"
      ? [`Size: ${meta.sizeBytes} bytes`]
      : []),
    `Path: ${filePath}`,
    ...(meta?.caption ? ["", "Caption:", meta.caption] : []),
  ].join("\n");
}

export function formatFileDetail(
  sessionId: string,
  filePath: string,
  meta?: {
    originalName?: string | undefined;
    relativePath?: string | undefined;
    caption?: string | undefined;
    uploadedAt?: string | undefined;
  } | null,
): string {
  const displayName =
    meta?.originalName ||
    (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
    path.basename(filePath);

  return [
    "Session file",
    "",
    `Session: ${sessionId}`,
    `File: ${displayName}`,
    ...(meta?.uploadedAt ? [`Uploaded: ${meta.uploadedAt}`] : []),
    `Path: ${filePath}`,
    ...(meta?.caption ? ["", "Description:", meta.caption] : []),
  ].join("\n");
}

export function formatScreenshotDetail(
  sessionId: string,
  filePath: string,
  meta?: {
    caption?: string | undefined;
    uploadedAt?: string | undefined;
  } | null,
): string {
  return [
    "Browser screenshot",
    "",
    `Session: ${sessionId}`,
    `File: ${path.basename(filePath)}`,
    ...(meta?.uploadedAt ? [`Created: ${meta.uploadedAt}`] : []),
    `Path: ${filePath}`,
    ...(meta?.caption ? ["", "Caption:", meta.caption] : []),
  ].join("\n");
}

export function extractIncomingText(
  message: TelegramMenuContext["message"] | undefined,
): string | null {
  const text = message?.text?.trim() || message?.caption?.trim();
  return text && text.length > 0 ? text : null;
}

export function collectIncomingAttachments(
  message: TelegramMenuContext["message"] | undefined,
): TelegramAttachmentDescriptor[] {
  if (!message) {
    return [];
  }

  const attachments: TelegramAttachmentDescriptor[] = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largestPhoto = [...message.photo].sort(
      (left, right) => right.width * right.height - left.width * left.height,
    )[0];

    if (largestPhoto?.file_id) {
      attachments.push({
        fileId: largestPhoto.file_id,
        preferredName: `photo-${message.message_id}.jpg`,
        mimeType: "image/jpeg",
      });
    }
  }

  if (message.document?.file_id) {
    attachments.push({
      fileId: message.document.file_id,
      preferredName:
        message.document.file_name || `document-${message.message_id}.bin`,
      ...(message.document.mime_type
        ? { mimeType: message.document.mime_type }
        : {}),
    });
  }

  return attachments;
}
