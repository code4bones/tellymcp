import { GrammyError, type Bot } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { Logger } from "../../lib/logger/logger";
import {
  renderMarkdownChunk,
  splitLongTelegramText,
  splitTitleAndBody,
} from "./transportUtils";
import type {
  SendMessageMeta,
  SentChunk,
  TelegramEditMessageOptions,
  TelegramMenuContext,
  TelegramSendMessageOptions,
} from "./transportTypes";

export interface TransportOutputActionsHost {
  config: AppConfig;
  logger: Logger;
  bot: Bot<TelegramMenuContext>;
}

export class TransportOutputActions {
  public constructor(private readonly host: TransportOutputActionsHost) {}

  public async sendTextChunks(
    telegramChatId: number,
    text: string,
    meta: {
      kind: "request" | "notification" | "transport";
      sessionId: string;
      requestId?: string;
    },
  ): Promise<SentChunk[]> {
    const safeLimit = Math.min(this.host.config.telegram.maxMessageChars, 3900);
    const { title, body } = splitTitleAndBody(text);
    const rawChunkLimit = Math.max(256, safeLimit - title.length - 96);
    const rawChunks = splitLongTelegramText(body, rawChunkLimit);
    const bodyChunks = rawChunks.flatMap((chunk) =>
      this.buildSizedBodyChunks(title, chunk, safeLimit),
    );
    const chunkCount = bodyChunks.length;
    const chunks = bodyChunks.map((chunkBody, index) =>
      renderMarkdownChunk(
        chunkCount > 1 ? `${title} (${index + 1}/${chunkCount})` : title,
        chunkBody,
      ),
    );
    const sent: SentChunk[] = [];

    this.host.logger.debug("Telegram message chunking prepared", {
      kind: meta.kind,
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      chunkCount: chunks.length,
      totalLength: text.length,
      safeLimit,
    });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }

      try {
        const response = await this.sendTelegramMessageWithRetry(
          telegramChatId,
          chunk,
          { parse_mode: "MarkdownV2" },
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            chunkIndex: index + 1,
            chunkCount: chunks.length,
            ...(meta.requestId ? { requestId: meta.requestId } : {}),
          },
        );
        sent.push({
          messageId: response.message_id,
          textLength: chunk.length,
        });

        this.host.logger.debug("Telegram message chunk sent", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          messageId: response.message_id,
          textLength: chunk.length,
        });
      } catch (error) {
        this.host.logger.error("Telegram message chunk send failed", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          textLength: chunk.length,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    return sent;
  }

  public async sendChatMessage(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions,
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }> {
    return this.sendTelegramMessageWithRetry(
      telegramChatId,
      text,
      options,
      meta,
    );
  }

  public async replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: SendMessageMeta,
    options: TelegramSendMessageOptions = {},
  ): Promise<{ message_id: number } | void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        return await ctx.reply(text, options);
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.host.logger.warn(
          "Telegram rate limit hit while replying, cooling down",
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            requestId: meta.requestId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  public async editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: SendMessageMeta,
    options: TelegramEditMessageOptions = {},
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.editMessageText(text, options);
        return;
      } catch (error) {
        if (error instanceof GrammyError) {
          if (error.description.includes("message is not modified")) {
            return;
          }

          if (error.error_code === 429) {
            const retryAfterSeconds = Math.max(
              1,
              error.parameters.retry_after ?? 1,
            );
            this.host.logger.warn(
              "Telegram rate limit hit while editing message, cooling down",
              {
                kind: meta.kind,
                sessionId: meta.sessionId,
                requestId: meta.requestId,
                attempt,
                retryAfterSeconds,
                description: error.description,
              },
            );

            await new Promise((resolve) =>
              setTimeout(resolve, retryAfterSeconds * 1000),
            );
            continue;
          }
        }

        throw error;
      }
    }
  }

  private buildSizedBodyChunks(
    title: string,
    rawBody: string,
    safeLimit: number,
  ): string[] {
    const queue = [rawBody];
    const bodyChunks: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      const candidate = renderMarkdownChunk(`${title} (88/88)`, current);
      if (candidate.length <= safeLimit) {
        bodyChunks.push(current);
        continue;
      }

      const midpoint = Math.floor(current.length / 2);
      const splitAtNewline = current.lastIndexOf("\n", midpoint);
      const splitIndex = splitAtNewline > 64 ? splitAtNewline : midpoint;
      const head = current.slice(0, splitIndex).trim();
      const tail = current.slice(splitIndex).trim();

      if (!head || !tail) {
        const hardLimit = Math.max(64, safeLimit - title.length - 96);
        for (let index = 0; index < current.length; index += hardLimit) {
          const slice = current.slice(index, index + hardLimit).trim();
          if (slice) {
            bodyChunks.push(slice);
          }
        }
        continue;
      }

      queue.unshift(tail, head);
    }

    return bodyChunks;
  }

  private async sendTelegramMessageWithRetry(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions = {},
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        return await this.host.bot.api.sendMessage(telegramChatId, text, options);
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.host.logger.warn("Telegram rate limit hit, cooling down before retry", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: meta.chunkIndex,
          chunkCount: meta.chunkCount,
          attempt,
          retryAfterSeconds,
          description: error.description,
        });

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }
}
