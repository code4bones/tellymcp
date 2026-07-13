import { Buffer } from "node:buffer";
import path from "node:path";

import { InlineKeyboard } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { SendPartnerNoteOutput } from "../../../entities/collaboration/model/types";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../lib/logger/logger";
import { buildLocalHandoffActionDesc, buildLocalHandoffTools } from "../../lib/xchangeRecordHints";
import { upsertXchangeRecord } from "../xchange/sqliteRecordStore";
import { readWorkspaceFile, writeXchangeRelativeFile } from "../terminal/client";
import type { ExchangeFileSource } from "../object-storage/minioExchangeStore";
import type { PendingFileHandoffRecord, TelegramMenuContext } from "./transportTypes";
import { buildPrincipalKey, buildLocalHandoffId, buildLocalNoteContent } from "./transportUtils";
import {
  assertSerializedBodySize,
  MAX_BASE64_SOURCE_SIZE_BYTES,
} from "../../lib/bodyLimits";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportFileHandoffHost {
  logger: Logger;
  config: AppConfig;
  pendingFileHandoffs: Map<string, PendingFileHandoffRecord>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<"ru" | "en">;
  t(locale: "ru" | "en", key: string, vars?: Record<string, string | number>): string;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: { reply_markup?: InlineKeyboard },
  ): Promise<{ message_id: number } | void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  showProjectsMenu(ctx: TelegramMenuContext): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext): Promise<void>;
  showProjectMemberDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken?: string | undefined;
      targetSessionId: string;
      targetSessionLabel: string;
    },
  ): Promise<void>;
  getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken?: string;
  } | null>;
  ensureProjectSessionRegistered(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
  }): Promise<void>;
  sendPartnerNote(input: {
    session_id: string;
    target_session_id?: string;
    project_uuid?: string;
    kind: "handoff";
    summary: string;
    message: string;
    artifacts: string[];
    artifact_refs: Array<{
      file_path: string;
      relative_path?: string;
      original_name: string;
      mime_type?: string;
      size_bytes?: number;
      content_base64: string;
    }>;
  }): Promise<SendPartnerNoteOutput>;
  xchangeFileMetaStore: {
    getXchangeFileMeta(
      sessionId: string,
      filePath: string,
    ): Promise<TelegramXchangeFileMeta | null>;
  };
  sessionStore: {
    getSession(sessionId: string): Promise<SessionContext | null>;
  };
  maintenanceStore: {
    setOutgoingDeliveryNotice(input: {
      deliveryUuid: string;
      sessionId: string;
      telegramChatId: number;
      telegramMessageId: number;
      shareId: string;
      kind: string;
      summary: string;
      projectName?: string | undefined;
      targetLabel?: string | undefined;
      targetSessionLabel?: string | undefined;
    }): Promise<void>;
  };
  objectStore: {
    ensureLocalFile(input: {
      sessionId: string;
      session: SessionContext | null;
      filePath: string;
      relativePath?: string | undefined;
      storageRef?: string | undefined;
      source: ExchangeFileSource;
    }): Promise<string>;
    resolveWorkspaceDir(session: SessionContext | null): string;
  };
  nudgeSessionInbox(sessionId: string): Promise<void>;
}

export class TransportFileHandoffActions {
  public constructor(private readonly host: TransportFileHandoffHost) {}

  public async beginModeForTarget(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      filePath: string;
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram user or chat is missing.",
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(input.sessionId);
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const fileName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(input.filePath);
    const principalKey = buildPrincipalKey(principal);
    const locale = await this.host.resolveLocaleForContext(ctx);

    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:handoff.prompt_title"),
    });
    const sent = await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:handoff.prompt_title"),
        "",
        this.host.t(locale, "menu:handoff.route", {
          sourceSessionName: session?.label ?? input.sessionId,
          targetSessionName: input.targetSessionLabel,
        }),
        this.host.t(locale, "menu:handoff.recipient", {
          label: input.targetSessionLabel,
        }),
        this.host.t(locale, "menu:handoff.file", { fileName }),
        "",
        this.host.t(locale, "menu:handoff.prompt_body"),
        this.host.t(locale, "menu:handoff.prompt_hint"),
      ].join("\n"),
      { kind: "menu", sessionId: input.sessionId },
      {
        reply_markup: new InlineKeyboard().text(
          this.host.t(locale, "menu:handoff.cancel"),
          "file-handoff-cancel",
        ),
      },
    );

    this.host.pendingFileHandoffs.set(principalKey, {
      sessionId: input.sessionId,
      filePath: input.filePath,
      target: "partner",
      targetSessionId: input.targetSessionId,
      targetSessionLabel: input.targetSessionLabel,
      ...(input.projectUuid ? { projectUuid: input.projectUuid } : {}),
      initiatedAt: new Date().toISOString(),
      ...(sent && "message_id" in sent ? { promptMessageId: sent.message_id } : {}),
    });
  }

  public async cancelPending(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.host.pendingFileHandoffs.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:handoff.no_pending"),
        show_alert: true,
      });
      return;
    }

    this.host.pendingFileHandoffs.delete(principalKey);
    await this.deletePendingPrompt(ctx, pending);
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:handoff.cancelled"),
    });
    if (pending.projectUuid && pending.targetSessionId && pending.targetSessionLabel) {
      const project = await this.host.getProjectPayloadByUuid(
        pending.sessionId,
        pending.projectUuid,
      );
      if (project) {
        await this.host.showProjectMemberDetail(ctx, {
          sessionId: pending.sessionId,
          projectUuid: pending.projectUuid,
          projectName: project.projectName,
          targetSessionId: pending.targetSessionId,
          targetSessionLabel: pending.targetSessionLabel,
          ...(project.inviteToken ? { inviteToken: project.inviteToken } : {}),
        });
        return;
      }
    }

    if (pending.projectUuid) {
      await this.host.showProjectsMenu(ctx);
      return;
    }

    await this.host.showMainMenu(ctx);
  }

  public async handlePending(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.host.pendingFileHandoffs.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.host.pendingFileHandoffs.delete(principalKey);
      await this.deletePendingPrompt(ctx, pending);
      return false;
    }

    const description = text.trim();
    if (!description) {
      return true;
    }

    if (pending.target === "agent") {
      await this.deliverToAgent({
        principal,
        sessionId: pending.sessionId,
        filePath: pending.filePath,
        sourceTelegramMessageId: ctx.message?.message_id ?? 0,
        description,
      });
      this.host.pendingFileHandoffs.delete(principalKey);
      await this.deletePendingPrompt(ctx, pending);
      await this.host.replyText(
        ctx,
        this.host.t(locale, "menu:handoff.delivered_agent"),
        { kind: "menu", sessionId: pending.sessionId },
      );
      return true;
    }

    if (pending.projectUuid) {
      await this.host.ensureProjectSessionRegistered({
        principal,
        sessionId: pending.sessionId,
        projectUuid: pending.projectUuid,
      });
    }

    const output = await this.deliverToPartner({
      sessionId: pending.sessionId,
      filePath: pending.filePath,
      description,
      ...(pending.targetSessionId ? { targetSessionId: pending.targetSessionId } : {}),
      ...(pending.projectUuid ? { projectUuid: pending.projectUuid } : {}),
    });
    this.host.pendingFileHandoffs.delete(principalKey);
    await this.deletePendingPrompt(ctx, pending);
    const sent = await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:handoff.queued_partner"),
        ...(output.project_name
          ? [this.host.t(locale, "menu:handoff.project", { projectName: output.project_name })]
          : []),
        ...(output.target_actor_label
          ? [this.host.t(locale, "menu:handoff.recipient", { label: output.target_actor_label })]
          : []),
        ...(output.target_session_label
          ? [this.host.t(locale, "menu:handoff.session", { label: output.target_session_label })]
          : []),
        this.host.t(locale, "menu:handoff.status", {
          status:
            output.delivery_status === "delivered"
              ? this.host.t(locale, "menu:handoff.delivered")
              : this.host.t(locale, "menu:handoff.queued"),
        }),
        this.host.t(locale, "menu:handoff.share", { shareId: output.share_id }),
      ].join("\n"),
      { kind: "menu", sessionId: pending.sessionId },
    );
    if (output.delivery_status === "queued" && sent && "message_id" in sent && ctx.chat) {
      const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
        pending.sessionId,
        pending.filePath,
      );
      const fileName =
        meta?.originalName ||
        (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
        path.basename(pending.filePath);
      const handoffSummary =
        description
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find(Boolean) ?? `Передача файла: ${fileName}`;
      await this.host.maintenanceStore.setOutgoingDeliveryNotice({
        deliveryUuid: output.inbox_message_id,
        sessionId: pending.sessionId,
        telegramChatId: ctx.chat.id,
        telegramMessageId: sent.message_id,
        shareId: output.share_id,
        kind: output.kind,
        summary: handoffSummary,
        ...(output.project_name ? { projectName: output.project_name } : {}),
        ...(output.target_actor_label
          ? { targetLabel: output.target_actor_label }
          : pending.targetSessionLabel
            ? { targetLabel: pending.targetSessionLabel }
            : {}),
        ...(output.target_session_label ? { targetSessionLabel: output.target_session_label } : {}),
      });
    }
    return true;
  }

  public async deliverToPartnerPublic(input: {
    sessionId: string;
    filePath: string;
    description: string;
    targetSessionId?: string;
    projectUuid?: string;
  }): Promise<SendPartnerNoteOutput> {
    return this.deliverToPartner(input);
  }

  private async deletePendingPrompt(
    ctx: TelegramMenuContext,
    pending: PendingFileHandoffRecord,
  ): Promise<void> {
    if (!pending.promptMessageId) {
      return;
    }
    try {
      await this.host.deleteMessage(ctx.chat!.id, pending.promptMessageId);
    } catch (error) {
      this.host.logger.warn("Failed to delete pending file handoff prompt", {
        sessionId: pending.sessionId,
        promptMessageId: pending.promptMessageId,
        target: pending.target,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async deliverToAgent(input: {
    principal: Principal;
    sessionId: string;
    filePath: string;
    sourceTelegramMessageId: number;
    description: string;
  }): Promise<void> {
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const session = await this.host.sessionStore.getSession(input.sessionId);
    const fileName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(input.filePath);
    const handoffSummary =
      input.description
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? `Локальная передача файла: ${fileName}`;
    const now = new Date();
    const createdAt = now.toISOString();
    const handoffId = buildLocalHandoffId(fileName, now);
    const relativeArtifactPath = `local/files/${handoffId}/${fileName}`;
    const ensuredFilePath =
      meta?.storageRef
        ? await this.host.objectStore.ensureLocalFile({
            sessionId: input.sessionId,
            session,
            filePath: input.filePath,
            relativePath: relativeArtifactPath,
            storageRef: meta.storageRef,
            source: "partner-artifact",
          })
        : input.filePath;

    const workspaceDir = this.host.objectStore.resolveWorkspaceDir(session);
    const relativeNotePath = `local/${handoffId}.md`;
    const noteContent = buildLocalNoteContent({
      handoffId,
      createdAt,
      sessionId: input.sessionId,
      ...(session?.label ? { sessionLabel: session.label } : {}),
      filePath: ensuredFilePath,
      description: input.description,
    });
    const notePath = await writeXchangeRelativeFile(
      this.host.config.terminal,
      workspaceDir,
      this.host.config.exchange.dir,
      relativeNotePath,
      Buffer.from(noteContent, "utf8"),
    );
    await upsertXchangeRecord(
      this.host.config.terminal,
      workspaceDir,
      this.host.config.exchange.dir,
      {
        record_id: handoffId,
        session_id: input.sessionId,
        category: "local_handoff",
        direction: "local",
        status: "new",
        kind: "local-file",
        summary: handoffSummary,
        body_text: noteContent,
        action_desc: buildLocalHandoffActionDesc(),
        tools: buildLocalHandoffTools(),
        note_path: notePath,
        note_relative_path: relativeNotePath,
        attachments: [
          {
            file_path: notePath,
            relative_path: relativeNotePath,
            original_name: path.basename(relativeNotePath),
            mime_type: "text/markdown",
            size_bytes: Buffer.byteLength(noteContent, "utf8"),
          },
          {
            file_path: ensuredFilePath,
            relative_path: relativeArtifactPath,
            original_name: fileName,
            ...(meta?.mimeType ? { mime_type: meta.mimeType } : {}),
            ...(typeof meta?.sizeBytes === "number" ? { size_bytes: meta.sizeBytes } : {}),
            ...(meta?.storageRef ? { storage_ref: meta.storageRef } : {}),
          },
        ],
        tags: ["local", "handoff", "file"],
        created_at: createdAt,
        updated_at: createdAt,
      },
    );

    try {
      await this.host.nudgeSessionInbox(input.sessionId);
    } catch (error) {
      this.host.logger.warn("terminal nudge failed after local agent handoff", {
        sessionId: input.sessionId,
        handoffId,
        filePath: ensuredFilePath,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async deliverToPartner(input: {
    sessionId: string;
    filePath: string;
    description: string;
    targetSessionId?: string;
    projectUuid?: string;
  }): Promise<SendPartnerNoteOutput> {
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const session = await this.host.sessionStore.getSession(input.sessionId);
    const fileName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(input.filePath);
    const localFilePath = await this.host.objectStore.ensureLocalFile({
      sessionId: input.sessionId,
      session,
      filePath: input.filePath,
      source: meta?.source ?? "telegram-upload",
      ...(meta?.relativePath ? { relativePath: meta.relativePath } : {}),
      ...(meta?.storageRef ? { storageRef: meta.storageRef } : {}),
    });
    const fileContent = await readWorkspaceFile(
      this.host.config.terminal,
      this.host.objectStore.resolveWorkspaceDir(session),
      localFilePath,
      MAX_BASE64_SOURCE_SIZE_BYTES,
    );
    const handoffSummary =
      input.description
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? `Передача файла: ${fileName}`;

    const note = {
      session_id: input.sessionId,
      ...(input.targetSessionId ? { target_session_id: input.targetSessionId } : {}),
      ...(input.projectUuid ? { project_uuid: input.projectUuid } : {}),
      kind: "handoff" as const,
      summary: handoffSummary,
      message: [
        "Partner sent a file for the current task.",
        `File: ${fileName}`,
        "",
        "Description:",
        input.description,
        ...(meta?.caption ? ["", "Caption:", meta.caption] : []),
      ].join("\n"),
      artifacts: [input.filePath],
      artifact_refs: [
        {
          file_path: input.filePath,
          ...(meta?.relativePath ? { relative_path: meta.relativePath } : {}),
          ...(meta?.originalName ? { original_name: meta.originalName } : { original_name: fileName }),
          ...(meta?.mimeType ? { mime_type: meta.mimeType } : {}),
          ...(typeof meta?.sizeBytes === "number" ? { size_bytes: meta.sizeBytes } : {}),
          content_base64: Buffer.from(fileContent).toString("base64"),
        },
      ],
    };
    assertSerializedBodySize(note);
    return this.host.sendPartnerNote(note);
  }
}
