import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  PartnerNoteKind,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity";
import {
  buildIncomingPartnerActionDesc,
  buildIncomingPartnerTools,
  buildOutgoingPartnerActionDesc,
  buildOutgoingPartnerTools,
} from "../../../shared/lib/xchangeRecordHints";
import type { MinioExchangeStore } from "../../../shared/integrations/object-storage/minioExchangeStore";
import {
  readWorkspaceFile,
  writeXchangeRelativeFile,
} from "../../../shared/integrations/tmux/client";
import { TelegramTransport } from "../../../shared/integrations/telegram/transport";
import { upsertXchangeRecord } from "../../../shared/integrations/xchange/sqliteRecordStore";
import type { CollaborationBackend } from "./backend";

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

const SOURCE_ARTIFACT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".less",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".zsh",
]);

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isReplyRequired(
  kind: PartnerNoteKind,
  input: SendPartnerNoteInput,
): boolean {
  if (typeof input.requires_reply === "boolean") {
    return input.requires_reply;
  }

  return kind === "question" || kind === "request";
}

function isSourceArtifactPath(filePath: string): boolean {
  return SOURCE_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function buildShareId(
  kind: PartnerNoteKind,
  sourceLabel: string,
  summary: string,
  now: Date,
): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return [
    timestamp,
    slugify(sourceLabel) || "session",
    kind,
    slugify(summary) || "note",
  ].join("-");
}

function renderYamlArray(values: string[]): string {
  if (values.length === 0) {
    return "[]";
  }

  return `\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

function buildNoteContent(input: {
  shareId: string;
  kind: PartnerNoteKind;
  sourceSessionId: string;
  sourceLabel: string;
  targetSessionId: string;
  targetLabel: string;
  createdAt: string;
  requiresReply: boolean;
  inReplyTo?: string | undefined;
  copiedArtifacts: string[];
  summary: string;
  message: string;
  expectedReply?: string | undefined;
}): string {
  const lines = ["---"];
  lines.push(`kind: ${JSON.stringify(input.kind)}`);
  lines.push(`from_session_id: ${JSON.stringify(input.sourceSessionId)}`);
  lines.push(`from_label: ${JSON.stringify(input.sourceLabel)}`);
  lines.push(`to_session_id: ${JSON.stringify(input.targetSessionId)}`);
  lines.push(`to_label: ${JSON.stringify(input.targetLabel)}`);
  lines.push(`created_at: ${JSON.stringify(input.createdAt)}`);
  if (input.requiresReply) {
    lines.push("requires_reply: true");
  }
  if (input.inReplyTo) {
    lines.push(`in_reply_to: ${JSON.stringify(input.inReplyTo)}`);
  }
  if (input.copiedArtifacts.length > 0) {
    lines.push(`artifacts:${renderYamlArray(input.copiedArtifacts)}`);
  }
  lines.push("---", "", "# Summary", input.summary.trim(), "", "# Message", input.message.trim());

  if (input.expectedReply?.trim()) {
    lines.push("", "# Expected Reply", input.expectedReply.trim());
  }

  if (input.requiresReply) {
    lines.push(
      "",
      "# Action Required",
      "You must send a reply via send_partner_note.",
      "Your task is not complete until send_partner_note succeeds.",
      "Do not stop after local analysis or a chat explanation.",
      "Use the current partner route for the reply.",
      "Only after the tool succeeds may you say that the reply was sent.",
      "",
      "# Reply Tool Call Example",
      "send_partner_note(",
      `  session_id=${JSON.stringify(input.targetSessionId)},`,
      `  kind=${JSON.stringify("reply")},`,
      "  summary=\"Короткий итог\",",
      "  message=\"Подробный ответ\"",
      ")",
    );
  }

  if (input.copiedArtifacts.length > 0) {
    lines.push(
      "",
      "# Artifacts",
      ...input.copiedArtifacts.map((artifact) => `- ${artifact}`),
    );
  }

  return `${lines.join("\n")}\n`;
}

export class LocalCollaborationBackend implements CollaborationBackend {
  private readonly textEncoder = new TextEncoder();

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly objectStore: MinioExchangeStore,
    private readonly telegramTransport: TelegramTransport,
    private readonly logger: Logger,
  ) {}

  public async sendPartnerNote(
    input: SendPartnerNoteInput,
    resolved: ResolvedSessionDefaults,
  ): Promise<SendPartnerNoteOutput> {
    const sourceSession = await this.sessionStore.getSession(resolved.sessionId);

    if (!sourceSession) {
      throw new Error(`Session ${resolved.sessionId} was not found.`);
    }

    const targetSessionId = trimOptional(input.target_session_id);

    if (!targetSessionId) {
      throw new Error("target_session_id is required for send_partner_note.");
    }

    const targetSession = await this.sessionStore.getSession(targetSessionId);
    if (!targetSession) {
      throw new Error(
        `Target partner session ${targetSessionId} was not found.`,
      );
    }

    const targetBinding = await this.bindingStore.getBinding(
      targetSession.sessionId,
    );
    if (!targetBinding) {
      throw new Error(`Target session ${targetSession.sessionId} has no active Telegram route.`);
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const sourceLabel = sourceSession.label ?? sourceSession.sessionId;
    const targetLabel = targetSession.label ?? targetSession.sessionId;
    const shareId = buildShareId(input.kind, sourceLabel, input.summary, now);
    const sourceWorkspaceDir = this.resolveWorkspaceDir(
      sourceSession,
      resolved.sessionId,
    );
    const targetWorkspaceDir = this.resolveWorkspaceDir(
      targetSession,
      targetSession.sessionId,
    );
    const relativeNotePath = `shares/${shareId}.md`;
    const requiresReply = isReplyRequired(input.kind, input);

    const copiedArtifacts = await this.copyArtifactsToPartner(
      sourceSession,
      targetSession,
      sourceWorkspaceDir,
      targetWorkspaceDir,
      shareId,
      createdAt,
      input.artifacts ?? [],
    );
    const inReplyTo = trimOptional(input.in_reply_to);
    const expectedReply = trimOptional(input.expected_reply);
    const noteContent = buildNoteContent({
      shareId,
      kind: input.kind,
      sourceSessionId: sourceSession.sessionId,
      sourceLabel,
      targetSessionId: targetSession.sessionId,
      targetLabel,
      createdAt,
      requiresReply,
      ...(inReplyTo ? { inReplyTo } : {}),
      copiedArtifacts,
      summary: input.summary,
      message: input.message,
      ...(expectedReply ? { expectedReply } : {}),
    });

    const notePath = await writeXchangeRelativeFile(
      this.config.tmux,
      targetWorkspaceDir,
      this.config.exchange.dir,
      relativeNotePath,
      this.textEncoder.encode(noteContent),
    );
    await this.xchangeFileMetaStore.setXchangeFileMeta({
      sessionId: targetSession.sessionId,
      filePath: notePath,
      relativePath: relativeNotePath,
      source: "partner-artifact",
      uploadedAt: createdAt,
      mimeType: "text/markdown",
      sizeBytes: this.textEncoder.encode(noteContent).byteLength,
    });
    const targetActionDesc = buildIncomingPartnerActionDesc(
      input.kind,
      requiresReply,
    );
    const targetTools = buildIncomingPartnerTools(input.kind, requiresReply);
    await upsertXchangeRecord(
      this.config.tmux,
      targetWorkspaceDir,
      this.config.exchange.dir,
      {
        record_id: shareId,
        session_id: targetSession.sessionId,
        category: "partner_note",
        direction: "incoming",
        status: "new",
        kind: input.kind,
        summary: input.summary.trim(),
        body_text: noteContent,
        action_desc: targetActionDesc,
        tools: targetTools,
        note_path: notePath,
        note_relative_path: relativeNotePath,
        source_session_id: sourceSession.sessionId,
        source_label: sourceLabel,
        target_session_id: targetSession.sessionId,
        target_label: targetLabel,
        requires_reply: requiresReply,
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        ...(expectedReply ? { expected_reply: expectedReply } : {}),
        attachments: [
          {
            file_path: notePath,
            relative_path: relativeNotePath,
            original_name: path.basename(relativeNotePath),
            mime_type: "text/markdown",
            size_bytes: this.textEncoder.encode(noteContent).byteLength,
          },
          ...copiedArtifacts.map((filePath) => ({
            file_path: filePath,
          })),
        ],
        tags: [
          "partner",
          input.kind,
          ...(requiresReply ? ["requires-reply"] : []),
        ],
        created_at: createdAt,
        updated_at: createdAt,
      },
    );
    await upsertXchangeRecord(
      this.config.tmux,
      sourceWorkspaceDir,
      this.config.exchange.dir,
      {
        record_id: shareId,
        session_id: sourceSession.sessionId,
        category: "partner_note",
        direction: "outgoing",
        status: "read",
        kind: input.kind,
        summary: input.summary.trim(),
        body_text: noteContent,
        action_desc: buildOutgoingPartnerActionDesc(input.kind, requiresReply),
        tools: buildOutgoingPartnerTools(input.kind, requiresReply),
        note_path: notePath,
        note_relative_path: relativeNotePath,
        source_session_id: sourceSession.sessionId,
        source_label: sourceLabel,
        target_session_id: targetSession.sessionId,
        target_label: targetLabel,
        requires_reply: requiresReply,
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        ...(expectedReply ? { expected_reply: expectedReply } : {}),
        attachments: copiedArtifacts.map((filePath) => ({
          file_path: filePath,
        })),
        tags: [
          "partner",
          "outgoing",
          input.kind,
          ...(requiresReply ? ["awaiting-reply"] : []),
        ],
        created_at: createdAt,
        updated_at: createdAt,
        read_at: createdAt,
      },
    );

    await this.telegramTransport.sendNotification({
      sessionId: targetSession.sessionId,
      sessionLabel: sourceLabel,
      recipient: {
        telegramChatId: targetBinding.telegramChatId,
        telegramUserId: targetBinding.telegramUserId,
      },
      message: [
        input.kind === "question"
          ? `Получен вопрос от ${sourceLabel}.`
          : input.kind === "reply"
            ? `Получен ответ от ${sourceLabel}.`
            : input.kind === "request"
              ? `Получен запрос от ${sourceLabel}.`
              : input.kind === "handoff"
                ? copiedArtifacts.length > 0
                  ? `Получен файл от ${sourceLabel}.`
                  : `Получен handoff от ${sourceLabel}.`
                : `Получено обновление от ${sourceLabel}.`,
        `Сессия: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${input.kind}`,
        `Кратко: ${input.summary.trim()}`,
        ...(copiedArtifacts.length > 0
          ? [
              "",
              `Файлы: ${copiedArtifacts.length}`,
              ...copiedArtifacts.map((item) => `- ${path.basename(item)}`),
            ]
          : []),
        "",
        `Note: ${notePath}`,
      ].join("\n"),
    });
    try {
      await this.telegramTransport.nudgeSessionPartnerNote(
        targetSession.sessionId,
      );
    } catch (error) {
      this.logger.warn("tmux nudge failed after local partner delivery", {
        sessionId: targetSession.sessionId,
        partnerSessionId: sourceSession.sessionId,
        shareId,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }

    this.logger.info("Partner note delivered through local backend", {
      sessionId: sourceSession.sessionId,
      partnerSessionId: targetSession.sessionId,
      shareId,
      kind: input.kind,
      notePath,
      copiedArtifacts,
      requiresReply,
      sessionIdDerived: resolved.sessionIdDerived,
    });

    return {
      session_id: sourceSession.sessionId,
      partner_session_id: targetSession.sessionId,
      kind: input.kind,
      share_id: shareId,
      delivery_status: "delivered",
      note_path: notePath,
      xchange_record_id: shareId,
      copied_artifacts: copiedArtifacts,
      inbox_message_id: shareId,
      requires_reply: requiresReply,
    };
  }

  private resolveWorkspaceDir(session: SessionContext, _sessionId: string): string {
    const workspaceDir = session.cwd?.trim();
    if (workspaceDir) {
      return workspaceDir;
    }
    throw new Error(
      `Workspace cwd is not registered for console '${session.sessionId}'.`,
    );
  }

  private async copyArtifactsToPartner(
    sourceSession: SessionContext,
    targetSession: SessionContext,
    sourceWorkspaceDir: string,
    targetWorkspaceDir: string,
    shareId: string,
    uploadedAt: string,
    artifacts: string[],
  ): Promise<string[]> {
    const copied: string[] = [];
    const usedArtifactNames = new Set<string>();

    for (const artifactPath of artifacts) {
      if (isSourceArtifactPath(artifactPath)) {
        throw new Error(
          `Source file artifacts are not allowed for partner exchange: ${artifactPath}. Share summaries, API specs, logs, screenshots, or other derived artifacts instead.`,
        );
      }

      const sourceMeta = await this.xchangeFileMetaStore.getXchangeFileMeta(
        sourceSession.sessionId,
        artifactPath,
      );
      const preferredArtifactName =
        sourceMeta?.originalName ||
        (sourceMeta?.relativePath
          ? path.basename(sourceMeta.relativePath)
          : undefined) ||
        path.basename(artifactPath) ||
        "artifact.bin";
      const artifactName = this.allocatePartnerArtifactName(
        preferredArtifactName,
        usedArtifactNames,
      );
      const relativeArtifactPath = [
        "shares",
        "files",
        shareId,
        artifactName,
      ].join("/");
      const ensuredArtifactPath = sourceMeta
        ? await this.objectStore.ensureLocalFile({
            sessionId: sourceSession.sessionId,
            session: sourceSession,
            filePath: artifactPath,
            relativePath: sourceMeta.relativePath,
            storageRef: sourceMeta.storageRef,
            source: sourceMeta.source,
          })
        : artifactPath;
      const content = await readWorkspaceFile(
        this.config.tmux,
        sourceWorkspaceDir,
        ensuredArtifactPath,
      );
      const materializedArtifactPath = await writeXchangeRelativeFile(
        this.config.tmux,
        targetWorkspaceDir,
        this.config.exchange.dir,
        relativeArtifactPath,
        content,
      );
      await this.xchangeFileMetaStore.setXchangeFileMeta({
        sessionId: targetSession.sessionId,
        filePath: materializedArtifactPath,
        relativePath: relativeArtifactPath,
        source: "partner-artifact",
        uploadedAt,
        ...(sourceMeta?.originalName
          ? { originalName: sourceMeta.originalName }
          : {}),
        ...(sourceMeta?.caption ? { caption: sourceMeta.caption } : {}),
        ...(sourceMeta?.mimeType ? { mimeType: sourceMeta.mimeType } : {}),
        ...(typeof sourceMeta?.sizeBytes === "number"
          ? { sizeBytes: sourceMeta.sizeBytes }
          : {}),
      });
      copied.push(materializedArtifactPath);
    }

    return copied;
  }

  private allocatePartnerArtifactName(
    fileName: string,
    usedArtifactNames: Set<string>,
  ): string {
    const baseName = path.basename(fileName).trim() || "artifact.bin";
    const extension = path.extname(baseName);
    const stem = path.basename(baseName, extension) || "artifact";

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate =
        attempt === 0 ? baseName : `${stem}--${attempt}${extension}`;
      if (usedArtifactNames.has(candidate)) {
        continue;
      }

      usedArtifactNames.add(candidate);
      return candidate;
    }

    throw new Error("Could not allocate a unique partner artifact name.");
  }
}
