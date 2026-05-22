import { InlineKeyboard } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../lib/logger/logger";
import { writeLocalTaskXchangeRecord } from "../../lib/telegramXchangeRecords";
import { buildPartnerNotePromptText } from "./collabUi";
import { isExecutorTargetKind } from "./collabSemantics";
import { parsePartnerNoteText } from "./transportFormatting";
import type { PendingPartnerNoteRecord, TelegramMenuContext } from "./transportTypes";
import { buildPrincipalKey } from "./transportUtils";

type Principal = { telegramChatId: number; telegramUserId: number };

function looksLikeBrowserScreenshotTask(input: {
  summary: string;
  message: string;
}): boolean {
  const haystack = [input.summary, input.message].join("\n").toLowerCase();
  return (
    /\b(browser_open|browser_screenshot|playwright)\b/u.test(haystack) ||
    /\b(скриншот|screenshot|скрин)\b/u.test(haystack) ||
    /\bhttps?:\/\/[^\s]+/u.test(haystack)
  );
}

export interface TransportPartnerHost {
  config: AppConfig;
  logger: Logger;
  pendingPartnerNotes: Map<string, PendingPartnerNoteRecord>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<"ru" | "en">;
  t(
    locale: "ru" | "en",
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: { reply_markup?: InlineKeyboard },
  ): Promise<{ message_id: number } | void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  showProjectsMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext, introText?: string): Promise<void>;
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
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
      projectName?: string;
      targetLabel: string;
      targetSessionLabel: string;
    }): Promise<void>;
  };
  ensureProjectSessionRegistered(input: {
    principal: Principal;
    sessionId: string;
    projectUuid: string;
  }): Promise<void>;
  sendPartnerNote(input: {
    session_id: string;
    target_session_id?: string;
    project_uuid?: string;
    kind: PartnerNoteKind;
    summary: string;
    message: string;
    expected_reply?: string;
    requires_reply?: boolean;
  }): Promise<{
    share_id: string;
    inbox_message_id: string;
    kind: string;
    project_name?: string | undefined;
    target_actor_label?: string | undefined;
    target_session_label?: string | undefined;
    delivery_status: "queued" | "delivered";
  }>;
  nudgeSessionInbox(sessionId: string): Promise<void>;
}

export class TransportPartnerActions {
  public constructor(private readonly host: TransportPartnerHost) {}

  public async beginPartnerNoteMode(
    ctx: TelegramMenuContext,
    kind: PartnerNoteKind,
    target?: {
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (!target) {
      await ctx.answerCallbackQuery({
        text: "Choose a target from Collab project members first.",
        show_alert: true,
      });
      return;
    }

    const targetLabel =
      target?.targetSessionLabel ??
      this.host.t(locale, "menu:partner.screen.default_partner");
    const sourceLabel = session?.label ?? sessionId;
    const prompt = buildPartnerNotePromptText({
      kind,
      sourceLabel,
      targetLabel,
      isProjectTarget: Boolean(target?.projectUuid),
    });

    await ctx.answerCallbackQuery({ text: `${prompt.kindLabel}.` });
    const sent = await this.host.replyText(
      ctx,
      prompt.text,
      { kind: "menu", sessionId },
      {
        reply_markup: new InlineKeyboard().text(
          this.host.t(locale, "menu:handoff.cancel"),
          "partner-note-cancel",
        ),
      },
    );

    this.host.pendingPartnerNotes.set(buildPrincipalKey(principal), {
      sessionId,
      kind,
      initiatedAt: new Date().toISOString(),
      ...(target ? { targetSessionId: target.targetSessionId } : {}),
      ...(target ? { targetSessionLabel: target.targetSessionLabel } : {}),
      ...(target?.projectUuid ? { projectUuid: target.projectUuid } : {}),
      ...(sent && "message_id" in sent ? { promptMessageId: sent.message_id } : {}),
    });
  }

  public async cancelPendingPartnerNote(ctx: TelegramMenuContext): Promise<void> {
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
    const pending = this.host.pendingPartnerNotes.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.host.t(locale, "menu:partner.actions.no_pending_note_input"),
        show_alert: true,
      });
      return;
    }

    this.host.pendingPartnerNotes.delete(principalKey);
    await this.deletePendingPartnerNotePrompt(ctx, pending);
    await ctx.answerCallbackQuery({
      text: this.host.t(locale, "menu:partner.actions.cancel_note_input"),
    });
    if (pending.projectUuid) {
      await this.host.showProjectsMenu(ctx);
      return;
    }
    await this.host.showMainMenu(ctx);
  }

  public async handlePendingPartnerNote(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.host.pendingPartnerNotes.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.host.pendingPartnerNotes.delete(principalKey);
      await this.deletePendingPartnerNotePrompt(ctx, pending);
      return false;
    }

    const parsed = parsePartnerNoteText(text);
    const sourceSession = await this.host.sessionStore.getSession(pending.sessionId);
    const sourceLabel = sourceSession?.label ?? pending.sessionId;
    const targetLabel =
      pending.targetSessionLabel ??
      pending.targetSessionId ??
      this.host.t(locale, "menu:partner.screen.default_partner");

    this.host.pendingPartnerNotes.delete(principalKey);
    await this.deletePendingPartnerNotePrompt(ctx, pending);
    if (isExecutorTargetKind(pending.kind)) {
      if (pending.projectUuid) {
        await this.host.ensureProjectSessionRegistered({
          principal,
          sessionId: pending.sessionId,
          projectUuid: pending.projectUuid,
        });
      }
      const prefersBrowserScreenshot = looksLikeBrowserScreenshotTask({
        summary: parsed.summary,
        message: parsed.message,
      });
      const delegatedMessage = [
        `Пользователь из Telegram просит тебя выполнить задачу для сессии ${sourceLabel}.`,
        `Маршрут результата: ${targetLabel} -> ${sourceLabel}`,
        "",
        "Задача:",
        parsed.message,
        "",
        "Не отправляй результат напрямую в Telegram из этой сессии.",
        `Верни результат только обратно в сессию ${sourceLabel}.`,
        `Исходная сессия ${sourceLabel} сама доставит его человеку в Telegram.`,
      ].join("\n");
      const expectedReply = prefersBrowserScreenshot
        ? [
            `Подготовь скриншот для сессии ${sourceLabel}.`,
            "Для веб-страницы сначала используй browser_open и browser_screenshot в этой консоли.",
            "Если нужен реальный файл-артефакт, верни его обратно в исходную сессию через send_partner_file.",
            "Не отправляй результат напрямую в Telegram из этой сессии.",
            "Задача не завершена, пока send_partner_file не отработал успешно.",
          ].join(" ")
        : [
            `Подготовь результат для сессии ${sourceLabel}.`,
            "Если результатом является реальный файл или артефакт, отправь его обратно через send_partner_file.",
            "Во всех остальных случаях отправь результат обратно через send_partner_note.",
            "Не отправляй результат напрямую в Telegram из этой сессии.",
            "Задача не завершена, пока send_partner_note или send_partner_file не отработал успешно.",
          ].join(" ");
      const output = await this.host.sendPartnerNote({
        session_id: pending.sessionId,
        ...(pending.targetSessionId ? { target_session_id: pending.targetSessionId } : {}),
        ...(pending.projectUuid ? { project_uuid: pending.projectUuid } : {}),
        kind: pending.kind,
        summary: parsed.summary,
        message: delegatedMessage,
        expected_reply: expectedReply,
        requires_reply: true,
      });
      const sent = await this.host.replyText(
        ctx,
        [
          this.host.t(locale, "menu:partner.actions.task_sent"),
          ...(output.project_name ? [`Проект: ${output.project_name}`] : []),
          ...(output.target_actor_label
            ? [this.host.t(locale, "menu:partner.screen.executor", { label: output.target_actor_label })]
            : []),
          this.host.t(locale, "menu:partner.screen.route_result", {
            source: targetLabel,
            target: sourceLabel,
          }),
          this.host.t(locale, "menu:partner.screen.type", { kind: pending.kind }),
          this.host.t(locale, "menu:partner.screen.summary", { summary: parsed.summary }),
          this.host.t(locale, "menu:partner.screen.status", {
            status:
              output.delivery_status === "delivered"
                ? this.host.t(locale, "menu:partner.screen.delivered")
                : this.host.t(locale, "menu:partner.screen.queued"),
          }),
          `Share: ${output.share_id}`,
        ].join("\n"),
        { kind: "menu", sessionId: pending.sessionId },
      );
      if (output.delivery_status === "queued" && sent && "message_id" in sent && ctx.chat) {
        await this.host.maintenanceStore.setOutgoingDeliveryNotice({
          deliveryUuid: output.inbox_message_id,
          sessionId: pending.sessionId,
          telegramChatId: ctx.chat.id,
          telegramMessageId: sent.message_id,
          shareId: output.share_id,
          kind: output.kind,
          summary: parsed.summary,
          ...(output.project_name ? { projectName: output.project_name } : {}),
          ...(output.target_actor_label ? { targetLabel: output.target_actor_label } : { targetLabel }),
          ...(output.target_session_label
            ? { targetSessionLabel: output.target_session_label }
            : { targetSessionLabel: targetLabel }),
        });
      }
      return true;
    }

    await this.enqueuePartnerNoteInstruction({
      principal,
      sessionId: pending.sessionId,
      sourceTelegramMessageId: ctx.message?.message_id ?? 0,
      kind: pending.kind,
      summary: parsed.summary,
      message: parsed.message,
      ...(pending.targetSessionId ? { targetSessionId: pending.targetSessionId } : {}),
      ...(pending.targetSessionLabel ? { targetSessionLabel: pending.targetSessionLabel } : {}),
      ...(pending.projectUuid ? { projectUuid: pending.projectUuid } : {}),
    });
    await this.host.replyText(
      ctx,
      [
        this.host.t(locale, "menu:partner.actions.inbox_queued"),
        this.host.t(locale, "menu:partner.screen.route_send", {
          source: sourceLabel,
          target: targetLabel,
        }),
        this.host.t(locale, "menu:partner.screen.type", { kind: pending.kind }),
        this.host.t(locale, "menu:partner.screen.summary", { summary: parsed.summary }),
        this.host.t(locale, "menu:partner.screen.current_session_handles"),
      ].join("\n"),
      { kind: "menu", sessionId: pending.sessionId },
    );
    return true;
  }

  private async deletePendingPartnerNotePrompt(
    ctx: TelegramMenuContext,
    pending: PendingPartnerNoteRecord,
  ): Promise<void> {
    if (!pending.promptMessageId) {
      return;
    }
    try {
      await this.host.deleteMessage(ctx.chat!.id, pending.promptMessageId);
    } catch (error) {
      this.host.logger.warn("Failed to delete pending partner note prompt", {
        sessionId: pending.sessionId,
        promptMessageId: pending.promptMessageId,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async enqueuePartnerNoteInstruction(input: {
    principal: Principal;
    sessionId: string;
    sourceTelegramMessageId: number;
    kind: PartnerNoteKind;
    summary: string;
    message: string;
    targetSessionId?: string;
    targetSessionLabel?: string;
    projectUuid?: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.sessionId);
    const sourceLabel = session?.label ?? input.sessionId;
    const targetLabel = input.targetSessionLabel ?? input.targetSessionId ?? "напарник";
    await writeLocalTaskXchangeRecord({
      config: this.host.config,
      session,
      sessionId: input.sessionId,
      summary: input.summary,
      kind: input.kind,
      text: [
        "Пользователь просит текущую консоль выполнить работу и отправить результат другой консоли.",
        `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${input.kind}`,
        `Кратко: ${input.summary}`,
        ...(input.projectUuid ? [`Проект UUID: ${input.projectUuid}`] : []),
        ...(input.targetSessionId ? [`Target session ID: ${input.targetSessionId}`] : []),
        "",
        "Содержимое для отправки:",
        input.message,
        "",
        "Не пересылай это как новую задачу в target-консоль.",
        "Сначала выполни работу в текущей консоли сам.",
        "Через send_partner_note или send_partner_file отправляй только результат, а не исходное поручение.",
        "Не останавливайся на проверке xchange records, чтении note, listing файлов или текстовом отчёте.",
        "Передай target_session_id явно в send_partner_note.",
        "После подготовки обязательно используй send_partner_note.",
        "Задача не завершена, пока send_partner_note не отработал успешно.",
        "Только после успешной отправки результата можно делать mark_xchange_record_read.",
        "Если запрос касается существующего локального файла, вызови send_partner_file.",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      actionDesc:
        "Start with get_xchange_record, complete the work in this console, then send the final result to the target console with send_partner_note or send_partner_file. Do not stop at analysis or a summary. The task is not complete until the outbound tool succeeds, and only then may you call mark_xchange_record_read.",
      tools: ["get_xchange_record", "send_partner_note", "send_partner_file", "mark_xchange_record_read"],
      tags: ["telegram", "human", "local", "partner-routing"],
    });
    await this.host.nudgeSessionInbox(input.sessionId);
  }
}
