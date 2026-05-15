import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  PartnerNoteKind,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramInboxStore,
  TelegramXchangeFileMetaStore,
} from "../../../shared/api/storage/contract";
import { createInboxMessageId } from "../../../shared/lib/ids/ids";
import type { Logger } from "../../../shared/lib/logger/logger";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity";
import type { MinioExchangeStore } from "../../../shared/integrations/object-storage/minioExchangeStore";
import {
  readWorkspaceFile,
  writeXchangeRelativeFile,
} from "../../../shared/integrations/tmux/client";
import { TelegramTransport } from "../../../shared/integrations/telegram/transport";
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

const PARTNER_INDEX_FILE_NAME = "SHARED_INDEX.md";

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

function buildPartnerInboxText(input: {
  kind: PartnerNoteKind;
  fromLabel: string;
  summary: string;
  notePath: string;
  requiresReply: boolean;
  copiedArtifacts: string[];
}): string {
  const kindTitle =
    input.kind === "question"
      ? "Partner question received."
      : input.kind === "reply"
        ? "Partner reply received."
        : input.kind === "request"
          ? "Partner request received."
          : input.kind === "handoff"
            ? "Partner handoff received."
            : "Partner update received.";

  return [
    kindTitle,
    `From: ${input.fromLabel}`,
    `Summary: ${input.summary}`,
    "",
    `Immediate action: read ${PARTNER_INDEX_FILE_NAME} and then open the note below.`,
    `Note: ${input.notePath}`,
    ...(input.copiedArtifacts.length > 0
      ? ["", "Artifacts:", ...input.copiedArtifacts.map((item) => `- ${item}`)]
      : []),
    ...(input.requiresReply
      ? ["", "Reply through send_partner_note when you are ready."]
      : []),
  ].join("\n");
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
  const lines = [
    "---",
    `share_id: ${JSON.stringify(input.shareId)}`,
    `kind: ${JSON.stringify(input.kind)}`,
    `from_session_id: ${JSON.stringify(input.sourceSessionId)}`,
    `from_label: ${JSON.stringify(input.sourceLabel)}`,
    `to_session_id: ${JSON.stringify(input.targetSessionId)}`,
    `to_label: ${JSON.stringify(input.targetLabel)}`,
    `created_at: ${JSON.stringify(input.createdAt)}`,
    `requires_reply: ${input.requiresReply ? "true" : "false"}`,
    `in_reply_to: ${input.inReplyTo ? JSON.stringify(input.inReplyTo) : "null"}`,
    `artifacts:${renderYamlArray(input.copiedArtifacts)}`,
    "---",
    "",
    "# Summary",
    input.summary.trim(),
    "",
    "# Message",
    input.message.trim(),
  ];

  if (input.expectedReply?.trim()) {
    lines.push("", "# Expected Reply", input.expectedReply.trim());
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

function buildShareIndexLine(input: {
  createdAt: string;
  sourceLabel: string;
  targetLabel: string;
  kind: PartnerNoteKind;
  summary: string;
  relativeNotePath: string;
}): string {
  return [
    "-",
    `[${input.createdAt}]`,
    `${input.sourceLabel} → ${input.targetLabel}`,
    `| ${input.kind} |`,
    `${input.summary}`,
    `| \`${input.relativeNotePath}\``,
  ].join(" ");
}

export class LocalCollaborationBackend implements CollaborationBackend {
  private readonly textEncoder = new TextEncoder();

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly inboxStore: TelegramInboxStore,
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
      throw new Error(
        `Session ${resolved.sessionId} was not found. Pair the session before collaborating.`,
      );
    }

    const targetSessionId =
      trimOptional(input.target_session_id) ?? sourceSession.linkedSessionId;

    if (!targetSessionId) {
      throw new Error(
        "This session has no linked partner. Link another session in Telegram first.",
      );
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
      throw new Error(
        `Linked partner session ${targetSession.sessionId} is not paired with Telegram.`,
      );
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
    const shareIndexPath = await writeXchangeRelativeFile(
      this.config.tmux,
      targetWorkspaceDir,
      this.config.exchange.dir,
      PARTNER_INDEX_FILE_NAME,
      this.textEncoder.encode(
        `${buildShareIndexLine({
          createdAt,
          sourceLabel,
          targetLabel,
          kind: input.kind,
          summary: input.summary.trim(),
          relativeNotePath,
        })}\n`,
      ),
      { append: true },
    );

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(now),
      sessionId: targetSession.sessionId,
      telegramChatId: targetBinding.telegramChatId,
      telegramUserId: targetBinding.telegramUserId,
      sourceTelegramMessageId: now.getTime(),
      text: buildPartnerInboxText({
        kind: input.kind,
        fromLabel: sourceLabel,
        summary: input.summary.trim(),
        notePath,
        requiresReply,
        copiedArtifacts,
      }),
      attachments: [notePath, ...copiedArtifacts],
      receivedAt: createdAt,
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    await this.telegramTransport.sendNotification({
      sessionId: targetSession.sessionId,
      ...(targetSession.label ? { sessionLabel: targetSession.label } : {}),
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
        `Кратко: ${input.summary.trim()}`,
        `Note: ${notePath}`,
      ].join("\n"),
    });

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
      share_index_path: shareIndexPath,
      copied_artifacts: copiedArtifacts,
      inbox_message_id: inboxMessage.id,
      requires_reply: requiresReply,
    };
  }

  private resolveWorkspaceDir(session: SessionContext, sessionId: string): string {
    const workspaceDir = session.cwd?.trim();
    if (workspaceDir) {
      return workspaceDir;
    }

    if (this.config.tmux.proxyUrl) {
      throw new Error(
        `Session ${sessionId} does not have cwd configured, so host-side collaboration files cannot be written.`,
      );
    }

    return process.cwd();
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
