import { execFile } from "node:child_process";

import { Menu, MenuRange, type MenuFlavor } from "@grammyjs/menu";
import { Bot, GrammyError, type Context } from "grammy";

import type { AppConfig } from "../../../app/config/env.js";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types.js";
import type {
  SessionStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramMenuPayloadStore,
} from "../../api/storage/contract.js";
import type {
  HumanTransportNotification,
  HumanTransport,
  HumanTransportReply,
  HumanTransportRequest,
} from "../../api/transport/contract.js";
import {
  createInboxMessageId,
  createMenuPayloadKey,
} from "../../lib/ids/ids.js";
import type { Logger } from "../../lib/logger/logger.js";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets.js";
import {
  formatTelegramMessage,
  formatTelegramNotification,
} from "./messageFormat.js";
import { createTelegramFetch } from "./proxyFetch.js";

type WaiterRecord = {
  requestId: string;
  telegramChatId: number;
  telegramUserId: number;
  telegramMessageId: number;
  sentAtMs: number;
  reply?: HumanTransportReply;
  resolve?: (reply: HumanTransportReply | null) => void;
  timeout?: NodeJS.Timeout;
};

type SentChunk = {
  messageId: number;
  textLength: number;
};

type TelegramSendMessageOptions = NonNullable<
  Parameters<Bot<TelegramMenuContext>["api"]["sendMessage"]>[2]
>;

type SendMessageMeta = {
  kind: "request" | "notification" | "pairing" | "menu" | "inbox" | "transport";
  sessionId?: string;
  requestId?: string;
  chunkIndex?: number;
  chunkCount?: number;
};

type TelegramMenuContext = Context & MenuFlavor;

function parsePairingCode(text: string): string | null {
  const match = text
    .trim()
    .match(/^\/(?:start|link)(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?$/i);
  return match?.[1]?.trim().toUpperCase() ?? null;
}

function isMenuEntryCommand(text: string): boolean {
  return /^\/(?:menu|start)(?:@\w+)?$/i.test(text.trim());
}

function readMenuPayloadKey(ctx: TelegramMenuContext): string | null {
  const payload = (ctx as TelegramMenuContext & { match?: string }).match;
  return typeof payload === "string" && payload.length > 0 ? payload : null;
}

function splitLongTelegramText(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const paragraphs = normalized.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  const appendSegment = (segment: string): void => {
    if (!segment) {
      return;
    }

    if (segment.length <= maxChars) {
      const candidate = current ? `${current}\n\n${segment}` : segment;
      if (candidate.length <= maxChars) {
        current = candidate;
        return;
      }

      flush();
      current = segment;
      return;
    }

    flush();

    const lines = segment.split("\n");
    let lineChunk = "";
    for (const line of lines) {
      if (line.length > maxChars) {
        if (lineChunk) {
          chunks.push(lineChunk.trim());
          lineChunk = "";
        }

        for (let index = 0; index < line.length; index += maxChars) {
          chunks.push(line.slice(index, index + maxChars).trim());
        }
        continue;
      }

      const candidate = lineChunk ? `${lineChunk}\n${line}` : line;
      if (candidate.length <= maxChars) {
        lineChunk = candidate;
      } else {
        chunks.push(lineChunk.trim());
        lineChunk = line;
      }
    }

    if (lineChunk) {
      current = lineChunk;
    }
  };

  for (const paragraph of paragraphs) {
    appendSegment(paragraph);
  }

  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}

function escapeMarkdownV2(text: string): string {
  const specialChars = new Set([
    "_",
    "*",
    "[",
    "]",
    "(",
    ")",
    "~",
    "`",
    ">",
    "#",
    "+",
    "-",
    "=",
    "|",
    "{",
    "}",
    ".",
    "!",
    "\\",
  ]);

  return Array.from(text, (char) =>
    specialChars.has(char) ? `\\${char}` : char,
  ).join("");
}

function escapeMarkdownV2CodeBlock(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function splitTitleAndBody(text: string): { title: string; body: string } {
  const normalized = text.trim();
  const [firstLine = "", ...rest] = normalized.split("\n");
  const title = firstLine.trim() || "Codex";
  const body = rest.join("\n").trim();

  return {
    title,
    body: body || firstLine.trim(),
  };
}

function renderMarkdownChunk(title: string, body: string): string {
  return `*${escapeMarkdownV2(title)}*\n\n\`\`\`\n${escapeMarkdownV2CodeBlock(body)}\n\`\`\``;
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function shouldNudge(
  lastNudgeAt: string | undefined,
  cooldownSeconds: number,
  nowMs: number,
): boolean {
  if (!lastNudgeAt) {
    return true;
  }

  const lastMs = Date.parse(lastNudgeAt);
  if (Number.isNaN(lastMs)) {
    return true;
  }

  return nowMs - lastMs >= cooldownSeconds * 1000;
}

async function sendTmuxLiteralLine(
  target: string,
  text: string,
): Promise<void> {
  const normalized = text.replace(/\r?\n/g, " ").trim();
  const bufferName = `telegram-mcp-${Date.now().toString(36)}`;
  if (normalized.length > 0) {
    try {
      await execFileAsync("tmux", ["set-buffer", "-b", bufferName, normalized]);
      await execFileAsync("tmux", [
        "paste-buffer",
        "-d",
        "-b",
        bufferName,
        "-t",
        target,
      ]);
    } finally {
      await execFileAsync("tmux", ["delete-buffer", "-b", bufferName]).catch(
        () => undefined,
      );
    }
  }
  await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"]);
}

export class TelegramTransport implements HumanTransport {
  private readonly bot: Bot<TelegramMenuContext>;
  private readonly mainMenu: Menu<TelegramMenuContext>;
  private readonly inboxMenu: Menu<TelegramMenuContext>;
  private readonly inboxMessageMenu: Menu<TelegramMenuContext>;
  private readonly waiters = new Map<string, WaiterRecord>();
  private readonly tmuxNudgeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private started = false;
  private pollingTask: Promise<void> | undefined;

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly inboxStore: TelegramInboxStore,
    private readonly menuPayloadStore: TelegramMenuPayloadStore,
    private readonly logger: Logger,
  ) {
    const telegramFetch = createTelegramFetch(
      this.config,
      this.logger,
    ) as unknown as NonNullable<
      NonNullable<
        NonNullable<ConstructorParameters<typeof Bot>[1]>["client"]
      >["fetch"]
    >;

    this.bot = new Bot<TelegramMenuContext>(this.config.telegram.botToken, {
      client: {
        fetch: telegramFetch,
      },
    });
    this.mainMenu = this.createMainMenu();
    this.inboxMenu = this.createInboxMenu();
    this.inboxMessageMenu = this.createInboxMessageMenu();
    this.mainMenu.register([this.inboxMenu, this.inboxMessageMenu]);
    this.bot.use(this.mainMenu);
    this.bot.catch((error) => {
      this.logger.error("Telegram polling error", {
        error:
          error.error instanceof Error
            ? error.error.message
            : String(error.error),
      });
    });
    this.bot.on("message:text", async (ctx) => {
      await this.handleMessage(ctx);
    });
  }

  public async start(): Promise<void> {
    if (this.started) {
      this.logger.debug(
        "Telegram transport start skipped because it is already running",
      );
      return;
    }

    this.logger.info("Telegram transport initialization started", {
      pollingTimeoutSeconds: 30,
      proxyEnabled: Boolean(this.config.telegram.proxy),
      proxyType: this.config.telegram.proxy?.type,
    });

    this.logger.debug("Telegram bot init started");
    await this.bot.init();
    this.logger.info("Telegram bot init completed", {
      botId: this.bot.botInfo.id,
      botUsername: this.bot.botInfo.username,
    });

    this.logger.debug("Telegram polling start scheduled");
    this.pollingTask = this.bot.start({
      timeout: Math.max(
        1,
        Math.floor(this.config.telegram.pollIntervalMs / 1000),
      ),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      onStart: (botInfo) => {
        this.logger.info("Telegram polling entered running state", {
          botId: botInfo.id,
          botUsername: botInfo.username,
          isRunning: this.bot.isRunning(),
          isInited: this.bot.isInited(),
        });
      },
    });
    this.pollingTask.catch((error: unknown) => {
      this.logger.error("Telegram polling task crashed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
    this.started = true;
    this.logger.info("Telegram transport start returned control to app", {
      isRunning: this.bot.isRunning(),
      isInited: this.bot.isInited(),
    });
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      this.logger.debug(
        "Telegram transport stop skipped because it is not running",
      );
      return;
    }

    this.logger.info("Telegram transport stopping");
    this.clearTmuxNudgeDebounceTimers();
    await this.bot.stop();
    this.started = false;
    this.pollingTask = undefined;
    this.logger.info("Telegram transport stopped");
  }

  public async sendRequest(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    const text = formatTelegramMessage(input, {
      maxQuestionChars: this.config.telegram.maxQuestionChars,
      maxContextChars: this.config.telegram.maxContextChars,
      maxMessageChars: this.config.telegram.maxMessageChars,
    });
    const sentChunks = await this.sendTextChunks(
      input.recipient.telegramChatId,
      text,
      {
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: "request",
      },
    );
    const response = sentChunks.at(-1);
    if (!response) {
      throw new Error("Telegram request send produced no message chunks");
    }

    this.waiters.set(input.requestId, {
      requestId: input.requestId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      telegramMessageId: response.messageId,
      sentAtMs: Date.now(),
    });

    return { externalMessageId: response.messageId };
  }

  public async sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }> {
    const text = formatTelegramNotification(input, {
      maxQuestionChars: this.config.telegram.maxQuestionChars,
      maxContextChars: this.config.telegram.maxContextChars,
      maxMessageChars: this.config.telegram.maxMessageChars,
    });
    const sentChunks = await this.sendTextChunks(
      input.recipient.telegramChatId,
      text,
      {
        sessionId: input.sessionId,
        kind: "notification",
      },
    );
    const response = sentChunks.at(-1);
    if (!response) {
      throw new Error("Telegram notification send produced no message chunks");
    }

    this.logger.info("Telegram notification delivered", {
      sessionId: input.sessionId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      messageId: response.messageId,
      chunks: sentChunks.length,
    });

    return { externalMessageId: response.messageId };
  }

  private async sendTextChunks(
    telegramChatId: number,
    text: string,
    meta: {
      kind: "request" | "notification";
      sessionId: string;
      requestId?: string;
    },
  ): Promise<SentChunk[]> {
    const safeLimit = Math.min(this.config.telegram.maxMessageChars, 3900);
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

    this.logger.debug("Telegram message chunking prepared", {
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

        this.logger.debug("Telegram message chunk sent", {
          kind: meta.kind,
          sessionId: meta.sessionId,
          requestId: meta.requestId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          messageId: response.message_id,
          textLength: chunk.length,
        });
      } catch (error) {
        this.logger.error("Telegram message chunk send failed", {
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
        return await this.bot.api.sendMessage(telegramChatId, text, options);
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn("Telegram rate limit hit, cooling down before retry", {
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

  private async replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options: TelegramSendMessageOptions = {},
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.reply(text, options);
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.logger.warn(
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

  public async waitForReply(
    requestId: string,
    timeoutSeconds: number,
  ): Promise<HumanTransportReply | null> {
    const waiter = this.waiters.get(requestId);
    if (!waiter) {
      throw new Error(`Transport waiter not found for request ${requestId}`);
    }

    if (waiter.reply) {
      this.clearWaiter(requestId);
      return waiter.reply;
    }

    return new Promise<HumanTransportReply | null>((resolve) => {
      waiter.resolve = (reply) => {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        this.clearWaiter(requestId);
        resolve(reply);
      };
      waiter.timeout = setTimeout(() => {
        waiter.resolve?.(null);
      }, timeoutSeconds * 1000);
    });
  }

  private clearWaiter(requestId: string): void {
    const waiter = this.waiters.get(requestId);
    if (waiter?.timeout) {
      clearTimeout(waiter.timeout);
    }
    this.waiters.delete(requestId);
  }

  private createMainMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-main-menu", {
      fingerprint: async (ctx) => this.buildMainMenuFingerprint(ctx),
    })
      .text(
        async (ctx) => this.buildInboxButtonLabel(ctx),
        async (ctx) => {
          this.logger.debug("Telegram main menu inbox navigation requested", {
            chatId: ctx.chat?.id,
            userId: ctx.from?.id,
          });
          ctx.menu.nav("telegram-inbox-menu");
        },
      )
      .row()
      .text(
        async (ctx) => this.buildActiveSessionButtonLabel(ctx),
        async (ctx) => {
          const text = await this.buildMainMenuText(ctx);
          await ctx.answerCallbackQuery({
            text,
            show_alert: true,
          });
        },
      )
      .row()
      .text("Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Menu refreshed." });
        ctx.menu.update();
      });
  }

  private createInboxMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-menu", {
      fingerprint: async (ctx) => this.buildInboxFingerprint(ctx),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text("No Telegram identity", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "Telegram user or chat is missing.",
              show_alert: true,
            });
          });
          return range;
        }

        const sessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text("No active session", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No active session is linked yet.",
              show_alert: true,
            });
          });
          return range;
        }

        const inboxMessages = await this.inboxStore.listInboxMessages(
          sessionId,
          10,
        );

        if (inboxMessages.length === 0) {
          range.text("Inbox is empty", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No unsolicited Telegram messages are stored.",
              show_alert: false,
            });
          });
          return range;
        }

        for (const message of inboxMessages) {
          range
            .text(
              {
                text: this.formatInboxPreviewLabel(message),
                payload: async () =>
                  this.createInboxMenuPayload(message.sessionId, message.id),
              },
              async (innerCtx) => {
                await this.handleInboxMessageOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text("Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Inbox refreshed." });
        ctx.menu.update();
      })
      .text("Back", async (ctx) => {
        ctx.menu.nav("telegram-main-menu");
      });
  }

  private createInboxMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
    })
      .text(
        {
          text: "Delete",
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleInboxMessageDelete(ctx);
        },
      )
      .text("Close", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Closed." });
        await ctx.deleteMessage();
      });
  }

  private async handleMessage(ctx: TelegramMenuContext): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }

    this.logger.info("Telegram text message received", {
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
      text: redactSecrets(text),
      activeWaiters: this.waiters.size,
    });

    if (isMenuEntryCommand(text)) {
      await this.showMainMenu(ctx);
      return;
    }

    const pairingCode = parsePairingCode(text);
    if (pairingCode) {
      this.logger.debug("Telegram message identified as pairing command", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        messageId: ctx.message?.message_id,
      });
      await this.handlePairingCommand(ctx, pairingCode);
      return;
    }

    const replyMatched = await this.handleReply(ctx);
    if (replyMatched) {
      return;
    }

    await this.handleInboxCapture(ctx);
  }

  private async handlePairingCommand(
    ctx: TelegramMenuContext,
    code: string,
  ): Promise<void> {
    const pairCode = await this.bindingStore.consumePairCode(code);
    if (!pairCode) {
      this.logger.warn("Invalid or expired pairing code", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        code,
      });
      await this.replyText(ctx, "Pairing code is invalid or expired.", {
        kind: "pairing",
      });
      return;
    }

    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!fromUserId || !chatId) {
      await this.replyText(ctx, "Unable to determine Telegram user or chat.", {
        kind: "transport",
      });
      return;
    }

    await this.bindingStore.setBinding({
      sessionId: pairCode.sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
      linkedAt: new Date().toISOString(),
    });
    await this.bindingStore.setActiveSessionIdForPrincipal(
      {
        telegramChatId: chatId,
        telegramUserId: fromUserId,
      },
      pairCode.sessionId,
    );

    this.logger.info("Session linked to Telegram user", {
      sessionId: pairCode.sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
    });

    const existingSession = await this.sessionStore.getSession(
      pairCode.sessionId,
    );
    await this.sessionStore.setSession({
      sessionId: pairCode.sessionId,
      ...(existingSession?.label || pairCode.sessionLabel
        ? { label: existingSession?.label ?? pairCode.sessionLabel }
        : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions
        ? { decisions: existingSession.decisions }
        : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      updatedAt: new Date().toISOString(),
    });

    await this.replyText(
      ctx,
      pairCode.sessionLabel
        ? `Session linked: ${pairCode.sessionLabel}`
        : `Session linked: ${pairCode.sessionId}`,
      {
        kind: "pairing",
        sessionId: pairCode.sessionId,
      },
    );
    await this.showMainMenu(ctx, "Pairing complete. Main menu is ready.");
  }

  private async handleReply(ctx: TelegramMenuContext): Promise<boolean> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!message?.text || !fromUserId || !chatId) {
      return false;
    }

    const waiters = Array.from(this.waiters.values());
    if (waiters.length === 0) {
      this.logger.debug(
        "Telegram message ignored because there are no active waiters",
        {
          chatId,
          userId: fromUserId,
          messageId: message.message_id,
          text: redactSecrets(message.text.trim()),
        },
      );
      return false;
    }

    const replyToMessageId = message.reply_to_message?.message_id;
    const messageTimestampMs = message.date * 1000;

    const matched =
      waiters.find(
        (waiter) =>
          waiter.telegramChatId === chatId &&
          waiter.telegramUserId === fromUserId &&
          replyToMessageId === waiter.telegramMessageId,
      ) ??
      (waiters.length === 1
        ? waiters.find(
            (waiter) =>
              waiter.telegramChatId === chatId &&
              waiter.telegramUserId === fromUserId &&
              messageTimestampMs >= waiter.sentAtMs,
          )
        : undefined);

    if (!matched) {
      this.logger.debug("Telegram message did not match any active waiter", {
        chatId,
        userId: fromUserId,
        messageId: message.message_id,
        replyToMessageId,
        activeWaiterIds: waiters.map((waiter) => waiter.requestId),
        text: redactSecrets(message.text.trim()),
      });
      return false;
    }

    this.logger.info("Telegram message matched active waiter", {
      requestId: matched.requestId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      replyToMessageId,
      text: redactSecrets(message.text.trim()),
    });

    const reply: HumanTransportReply = {
      requestId: matched.requestId,
      answer: message.text.trim(),
      receivedAt: new Date(message.date * 1000).toISOString(),
    };

    if (matched.resolve) {
      matched.resolve(reply);
      return true;
    }

    matched.reply = reply;
    return true;
  }

  private async handleInboxCapture(ctx: TelegramMenuContext): Promise<void> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!message?.text || !fromUserId || !chatId) {
      return;
    }

    const principal = {
      telegramChatId: chatId,
      telegramUserId: fromUserId,
    };
    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      this.logger.debug(
        "Telegram message ignored because no active session is linked for principal",
        {
          chatId,
          userId: fromUserId,
          messageId: message.message_id,
        },
      );
      await this.replyText(
        ctx,
        "No active session is linked yet. Use a pairing code first, then open the menu.",
        { kind: "transport" },
      );
      return;
    }

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
      text: message.text.trim(),
      receivedAt: new Date(message.date * 1000).toISOString(),
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    this.logger.info("Telegram message stored in inbox", {
      sessionId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      inboxMessageId: inboxMessage.id,
      text: redactSecrets(inboxMessage.text),
    });

    const session = await this.sessionStore.getSession(sessionId);
    try {
      this.scheduleTmuxNudgeForInboxMessage(sessionId, session);
    } catch (error) {
      this.logger.error("tmux nudge failed after inbox capture", {
        sessionId,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }
    await this.replyText(
      ctx,
      session?.label
        ? `Saved to inbox for session: ${session.label}`
        : `Saved to inbox for session: ${sessionId}`,
      {
        kind: "inbox",
        sessionId,
      },
      { reply_markup: this.mainMenu },
    );
  }

  private clearTmuxNudgeDebounceTimers(): void {
    for (const timer of this.tmuxNudgeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.tmuxNudgeDebounceTimers.clear();
  }

  private scheduleTmuxNudgeForInboxMessage(
    sessionId: string,
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): void {
    if (!this.config.tmux.nudgeEnabled) {
      return;
    }

    if (!session?.tmuxTarget || session.humanMode !== "telegram") {
      this.logger.debug("tmux nudge scheduling skipped for inbox message", {
        sessionId,
        reason: !session?.tmuxTarget
          ? "no_tmux_target"
          : "human_mode_not_telegram",
      });
      return;
    }

    const existingTimer = this.tmuxNudgeDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.tmuxNudgeDebounceTimers.delete(sessionId);
      void this.nudgeTmuxForInboxMessage(sessionId);
    }, this.config.tmux.nudgeDebounceSeconds * 1000);
    timer.unref();
    this.tmuxNudgeDebounceTimers.set(sessionId, timer);

    this.logger.info("tmux nudge scheduled for inbox message", {
      sessionId,
      tmuxTarget: session.tmuxTarget,
      debounceSeconds: this.config.tmux.nudgeDebounceSeconds,
    });
  }

  private async nudgeTmuxForInboxMessage(sessionId: string): Promise<void> {
    if (!this.config.tmux.nudgeEnabled) {
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);

    if (!session?.tmuxTarget || session.humanMode !== "telegram") {
      this.logger.debug("tmux nudge skipped for inbox message", {
        sessionId,
        reason: !session?.tmuxTarget
          ? "no_tmux_target"
          : "human_mode_not_telegram",
      });
      return;
    }

    const inboxCount = await this.inboxStore.countInboxMessages(sessionId);
    if (inboxCount === 0) {
      this.logger.debug("tmux nudge skipped because inbox is empty", {
        sessionId,
      });
      return;
    }

    const nowMs = Date.now();
    if (
      !shouldNudge(
        session.lastTmuxNudgeAt,
        this.config.tmux.nudgeCooldownSeconds,
        nowMs,
      )
    ) {
      this.logger.debug("tmux nudge skipped because of cooldown", {
        sessionId,
        tmuxTarget: session.tmuxTarget,
        inboxCount,
        lastTmuxNudgeAt: session.lastTmuxNudgeAt,
      });
      return;
    }

    await sendTmuxLiteralLine(
      session.tmuxTarget,
      this.config.tmux.nudgeMessage,
    );

    const lastTmuxNudgeAt = new Date(nowMs).toISOString();
    await this.sessionStore.setSession({
      ...session,
      lastTmuxNudgeAt,
    });

    this.logger.info("tmux nudge sent for inbox message", {
      sessionId,
      tmuxSessionName: session.tmuxSessionName,
      tmuxTarget: session.tmuxTarget,
      inboxCount,
      lastTmuxNudgeAt,
    });
  }

  private async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildMainMenuText(ctx);
    await this.replyText(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      {
        reply_markup: this.mainMenu,
      },
    );
  }

  private async buildMainMenuText(ctx: TelegramMenuContext): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Telegram identity is unavailable for this chat.";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return "No active session is linked yet. Pair a session via /start <code>.";
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const inboxCount =
      await this.inboxStore.countInboxMessages(activeSessionId);
    return [
      "Telegram control menu",
      "",
      `Active session: ${session?.label ?? activeSessionId}`,
      `Inbox messages: ${inboxCount}`,
      "",
      "Use the buttons below to inspect inbox messages or refresh the current state.",
    ].join("\n");
  }

  private async buildMainMenuFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "no-principal";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "no-active-session";
    }

    const count = await this.inboxStore.countInboxMessages(sessionId);
    return `${sessionId}:${count}`;
  }

  private async buildInboxFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "no-principal";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "no-active-session";
    }

    const messages = await this.inboxStore.listInboxMessages(sessionId, 10);
    return `${sessionId}:${messages.map((message) => message.id).join(",")}`;
  }

  private async buildInboxButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Inbox";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "Inbox";
    }

    const count = await this.inboxStore.countInboxMessages(sessionId);
    return count > 0 ? `Inbox (${count})` : "Inbox";
  }

  private async buildActiveSessionButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "No session";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "No session";
    }

    const session = await this.sessionStore.getSession(sessionId);
    return `Session: ${session?.label ?? sessionId}`;
  }

  private async createInboxMenuPayload(
    sessionId: string,
    messageId: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "inbox-message",
        sessionId,
        messageId,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async handleInboxMessageOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Inbox payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "inbox-message") {
      await ctx.answerCallbackQuery({
        text: "Inbox payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const message = await this.inboxStore.getInboxMessage(
      payload.sessionId,
      payload.messageId,
    );
    if (!message) {
      await ctx.answerCallbackQuery({
        text: "Inbox message no longer exists.",
        show_alert: true,
      });
      return;
    }

    this.logger.info("Telegram inbox message opened from menu", {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await ctx.answerCallbackQuery({ text: "Inbox message opened." });
    await this.replyText(
      ctx,
      this.formatInboxDetail(message),
      {
        kind: "inbox",
        sessionId: payload.sessionId,
      },
      { reply_markup: this.inboxMessageMenu },
    );
  }

  private async handleInboxMessageDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Inbox payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "inbox-message") {
      await ctx.answerCallbackQuery({
        text: "Inbox payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const deleted = await this.inboxStore.deleteInboxMessage(
      payload.sessionId,
      payload.messageId,
    );
    this.logger.info("Telegram inbox message deleted from menu", {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      deleted,
    });

    await ctx.answerCallbackQuery({
      text: deleted
        ? "Inbox message deleted."
        : "Inbox message already absent.",
    });
    await ctx.editMessageText(
      deleted ? "Inbox message deleted." : "Inbox message was already removed.",
    );
  }

  private formatInboxPreviewLabel(message: TelegramInboxMessage): string {
    const compact = message.text.replace(/\s+/g, " ").trim();
    const preview =
      compact.length > 28 ? `${compact.slice(0, 28).trimEnd()}...` : compact;
    return preview.length > 0 ? preview : "(empty message)";
  }

  private formatInboxDetail(message: TelegramInboxMessage): string {
    return [
      "Inbox message",
      "",
      `Session: ${message.sessionId}`,
      `Received: ${message.receivedAt}`,
      `Message ID: ${message.id}`,
      "",
      message.text,
    ].join("\n");
  }

  private getPrincipalFromContext(
    ctx: TelegramMenuContext,
  ): { telegramChatId: number; telegramUserId: number } | null {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
      return null;
    }

    return {
      telegramChatId: chatId,
      telegramUserId: userId,
    };
  }
}
