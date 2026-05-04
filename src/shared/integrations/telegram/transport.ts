import { execFile } from "node:child_process";

import { Menu, MenuRange, type MenuFlavor } from "@grammyjs/menu";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";

import type { AppConfig } from "../../../app/config/env.js";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth.js";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types.js";
import type {
  SessionStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramMenuPayloadStore,
  MaintenanceStore,
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

type PendingRenameRecord = {
  sessionId: string;
};

type PendingBroadcastRecord = {
  initiatedAt: string;
};

type TmuxCaptureScope =
  | { mode: "visible" }
  | { mode: "lines"; lines: number }
  | { mode: "full" };

function parsePairingCode(text: string): string | null {
  const match = text
    .trim()
    .match(/^\/(?:start|link)(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?$/i);
  return match?.[1]?.trim().toUpperCase() ?? null;
}

function isMenuEntryCommand(text: string): boolean {
  return /^\/(?:menu|start)(?:@\w+)?$/i.test(text.trim());
}

function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?$/i.test(text.trim());
}

function readMenuPayloadKey(ctx: TelegramMenuContext): string | null {
  const payload = (ctx as TelegramMenuContext & { match?: string }).match;
  return typeof payload === "string" && payload.length > 0 ? payload : null;
}

function buildPrincipalKey(principal: {
  telegramChatId: number;
  telegramUserId: number;
}): string {
  return `${principal.telegramChatId}:${principal.telegramUserId}`;
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

function execFileOutputAsync(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        stdout,
        stderr,
      });
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

function isTmuxUnavailableError(error: unknown): boolean {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    message.includes("error connecting to /tmp/tmux-") ||
    message.includes("No such file or directory") ||
    message.includes("ENOENT")
  );
}

function slugifyFilenamePart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function formatMenuTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${day}.${month}.${year} ${hours}:${minutes}`;
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
  private readonly sessionsMenu: Menu<TelegramMenuContext>;
  private readonly bufferMenu: Menu<TelegramMenuContext>;
  private readonly developerMenu: Menu<TelegramMenuContext>;
  private readonly unpairConfirmMenu: Menu<TelegramMenuContext>;
  private readonly pruneConfirmMenu: Menu<TelegramMenuContext>;
  private readonly inboxMessageMenu: Menu<TelegramMenuContext>;
  private readonly waiters = new Map<string, WaiterRecord>();
  private readonly tmuxNudgeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingRenames = new Map<string, PendingRenameRecord>();
  private readonly pendingBroadcasts = new Map<string, PendingBroadcastRecord>();
  private started = false;
  private pollingTask: Promise<void> | undefined;

  private createMenuOptions(
    handler: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> } {
    return {
      onMenuOutdated: async (ctx) => {
        this.logger.debug("Telegram menu outdated, refreshing", {
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
          menuId: ctx.callbackQuery?.data ?? "unknown",
        });
        await ctx.answerCallbackQuery({
          text: "Menu refreshed.",
        });
        await handler(ctx);
      },
    };
  }

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly inboxStore: TelegramInboxStore,
    private readonly menuPayloadStore: TelegramMenuPayloadStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly webAppLaunchRegistry: WebAppLaunchRegistry,
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
    this.sessionsMenu = this.createSessionsMenu();
    this.bufferMenu = this.createBufferMenu();
    this.developerMenu = this.createDeveloperMenu();
    this.unpairConfirmMenu = this.createUnpairConfirmMenu();
    this.pruneConfirmMenu = this.createPruneConfirmMenu();
    this.inboxMessageMenu = this.createInboxMessageMenu();
    this.mainMenu.register([
      this.inboxMenu,
      this.sessionsMenu,
      this.bufferMenu,
      this.developerMenu,
      this.unpairConfirmMenu,
      this.pruneConfirmMenu,
      this.inboxMessageMenu,
    ]);
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
    await this.bot.api.setMyCommands([
      { command: "menu", description: "Open session menu" },
      { command: "help", description: "Show help" },
    ]);
    this.logger.info("Telegram bot commands registered", {
      commands: ["/menu", "/help"],
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

  public async recoverPendingInboxNudges(): Promise<void> {
    if (!this.config.tmux.nudgeEnabled) {
      this.logger.debug(
        "Startup inbox nudge recovery skipped because tmux nudging is disabled",
      );
      return;
    }

    const sessions = await this.sessionStore.listSessions();
    let recoveredCount = 0;

    for (const session of sessions) {
      if (!session.tmuxTarget) {
        continue;
      }

      const inboxCount = await this.inboxStore.countInboxMessages(
        session.sessionId,
      );
      if (inboxCount === 0) {
        continue;
      }

      recoveredCount += 1;
      try {
        await this.nudgeTmuxForInboxMessage(session.sessionId);
      } catch (error) {
        const payload = {
          sessionId: session.sessionId,
          tmuxTarget: session.tmuxTarget,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };

        if (isTmuxUnavailableError(error)) {
          this.logger.warn(
            "Startup inbox nudge recovery skipped because tmux is unavailable",
            payload,
          );
          continue;
        }

        this.logger.error("Startup inbox nudge recovery failed", payload);
      }
    }

    this.logger.info("Startup inbox nudge recovery finished", {
      scannedSessions: sessions.length,
      recoveredSessions: recoveredCount,
    });
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

  private async editText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
    options: Parameters<TelegramMenuContext["editMessageText"]>[1] = {},
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
            this.logger.warn(
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
      ...this.createMenuOptions((ctx) => this.showMainMenu(ctx)),
    })
      .text("🖥 Live", async (ctx) => {
        await this.showLiveViewLauncher(ctx);
      })
      .text("📄 Buffer", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Opening buffer menu." });
        await this.showBufferMenu(ctx);
      })
      .text(
        async (ctx) => this.buildInboxButtonLabel(ctx),
        async (ctx) => {
          this.logger.debug("Telegram main menu inbox navigation requested", {
            chatId: ctx.chat?.id,
            userId: ctx.from?.id,
          });
          await ctx.answerCallbackQuery({ text: "Opening inbox." });
          await this.showInboxMenu(ctx);
        },
      )
      .row()
      .text("ℹ Info", async (ctx) => {
        await this.showActiveSessionInfo(ctx);
      })
      .text("✏ Rename", async (ctx) => {
        await this.beginRenameActiveSession(ctx);
      })
      .text("🔄 Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Session menu refreshed." });
        await this.showMainMenu(ctx);
      })
      .row()
      .text("🗑 Unpair", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Confirm unpair." });
        await this.showUnpairConfirmMenu(ctx);
      })
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to sessions." });
        await this.showSessionsMenu(ctx);
      });
  }

  private createBufferMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-buffer-menu",
      this.createMenuOptions((ctx) => this.showBufferMenu(ctx)),
    )
      .text("👁 Visible", async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, { mode: "visible" });
      })
      .row()
      .text("📄 Last 300", async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, {
          mode: "lines",
          lines: 300,
        });
      })
      .text("📄 Last 1000", async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, {
          mode: "lines",
          lines: 1000,
        });
      })
      .row()
      .text("🧾 Full", async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, { mode: "full" });
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createDeveloperMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-developer-menu",
      this.createMenuOptions((ctx) => this.showDeveloperMenu(ctx)),
    )
      .text("📣 Broadcast", async (ctx) => {
        await this.beginBroadcast(ctx);
      })
      .row()
      .text("🧹 Prune all", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Confirm prune." });
        await this.showPruneConfirmMenu(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to sessions." });
        await this.showSessionsMenu(ctx);
      });
  }

  private createUnpairConfirmMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-unpair-confirm-menu",
      this.createMenuOptions((ctx) => this.showUnpairConfirmMenu(ctx)),
    )
      .text("⚠ Confirm unpair", async (ctx) => {
        await this.unpairActiveSession(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createPruneConfirmMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-prune-confirm-menu",
      this.createMenuOptions((ctx) => this.showPruneConfirmMenu(ctx)),
    )
      .text("⚠ Confirm prune", async (ctx) => {
        await this.pruneAllSessions(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to tools." });
        await this.showDeveloperMenu(ctx);
      });
  }

  private createInboxMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-menu", {
      fingerprint: async (ctx) => this.buildInboxFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showInboxMenu(ctx)),
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
          range.text("📭 Inbox is empty", async (innerCtx) => {
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
      .text("🔄 Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Inbox refreshed." });
        await this.showInboxMenu(ctx);
      })
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createSessionsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-sessions-menu", {
      fingerprint: async (ctx) => this.buildSessionsFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showSessionsMenu(ctx)),
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

        const activeSessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        const sessionIds = (
          await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
        ).sort();

        if (sessionIds.length === 0) {
          range.text("🫥 No linked sessions", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No linked sessions found for this Telegram identity.",
              show_alert: true,
            });
          });
          return range;
        }

        let buttonsInRow = 0;
        for (const sessionId of sessionIds) {
          const session = await this.sessionStore.getSession(sessionId);
          const inboxCount = await this.inboxStore.countInboxMessages(sessionId);

          range.text(
            {
              text: this.formatSessionMenuLabel({
                sessionId,
                active: sessionId === activeSessionId,
                inboxCount,
                ...(session?.label ? { sessionLabel: session.label } : {}),
              }),
              payload: async () => this.createSessionMenuPayload(sessionId),
            },
            async (innerCtx) => {
              await this.handleSessionSelection(innerCtx);
            },
          );

          buttonsInRow += 1;
          if (buttonsInRow >= 2) {
            range.row();
            buttonsInRow = 0;
          }
        }

        if (buttonsInRow > 0) {
          range.row();
        }

        return range;
      })
      .text("🔄 Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Sessions refreshed." });
        await this.showSessionsMenu(ctx);
      })
      .text("🛠 Tools", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Opening tools menu." });
        await this.showDeveloperMenu(ctx);
      });
  }

  private createInboxMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-inbox-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.createMenuOptions((ctx) => this.showInboxMenu(ctx)),
    })
      .text(
        {
          text: "🗑 Delete",
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleInboxMessageDelete(ctx);
        },
      )
      .text("✖ Close", async (ctx) => {
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

    if (await this.handlePendingRename(ctx, text)) {
      return;
    }

    if (await this.handlePendingBroadcast(ctx, text)) {
      return;
    }

    if (isMenuEntryCommand(text)) {
      this.clearPendingInteractionsForContext(ctx);
      await this.showSessionsMenu(ctx);
      return;
    }

    if (isHelpCommand(text)) {
      this.clearPendingInteractionsForContext(ctx);
      await this.showHelp(ctx);
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
      ...(existingSession?.tmuxSessionName
        ? { tmuxSessionName: existingSession.tmuxSessionName }
        : {}),
      ...(existingSession?.tmuxWindowName
        ? { tmuxWindowName: existingSession.tmuxWindowName }
        : {}),
      ...(typeof existingSession?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: existingSession.tmuxWindowIndex }
        : {}),
      ...(existingSession?.tmuxPaneId
        ? { tmuxPaneId: existingSession.tmuxPaneId }
        : {}),
      ...(typeof existingSession?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: existingSession.tmuxPaneIndex }
        : {}),
      ...(existingSession?.tmuxTarget
        ? { tmuxTarget: existingSession.tmuxTarget }
        : {}),
      ...(existingSession?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existingSession.lastTmuxNudgeAt }
        : {}),
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
    await this.showSessionsMenu(
      ctx,
      "Pairing complete. Choose the active session from the menu.",
    );
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
      sourceTelegramMessageId: message.message_id,
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

    if (!session?.tmuxTarget) {
      this.logger.debug("tmux nudge scheduling skipped for inbox message", {
        sessionId,
        reason: "no_tmux_target",
      });
      return;
    }

    const existingTimer = this.tmuxNudgeDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.tmuxNudgeDebounceTimers.delete(sessionId);
      void this.nudgeTmuxForInboxMessage(sessionId).catch((error) => {
        const payload = {
          sessionId,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };

        if (isTmuxUnavailableError(error)) {
          this.logger.warn(
            "tmux nudge skipped because tmux is unavailable",
            payload,
          );
          return;
        }

        this.logger.error("tmux nudge failed", payload);
      });
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

    if (!session?.tmuxTarget) {
      this.logger.debug("tmux nudge skipped for inbox message", {
        sessionId,
        reason: "no_tmux_target",
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

    await this.sendTypingForSession(sessionId);
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

  private async sendTypingForSession(sessionId: string): Promise<void> {
    const binding = await this.bindingStore.getBinding(sessionId);
    if (!binding) {
      this.logger.debug("Telegram typing skipped because session is unbound", {
        sessionId,
      });
      return;
    }

    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.bot.api.sendChatAction(binding.telegramChatId, "typing");
        this.logger.debug("Telegram typing action sent", {
          sessionId,
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        });
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
          "Telegram rate limit hit while sending typing action, cooling down",
          {
            sessionId,
            telegramChatId: binding.telegramChatId,
            telegramUserId: binding.telegramUserId,
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

  private async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildMainMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.mainMenu,
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
      "🎛 Session menu",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `📥 Inbox messages: ${inboxCount}`,
      "",
      "Use Inbox to inspect messages, Info to view session details, Buffer to export the tmux pane, Live to open the Mini App viewer, Unpair to detach it from Telegram, Refresh to reload this session, or Back to return to the sessions list.",
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

  private async buildSessionsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "no-principal";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    const sessionIds = (
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
    ).sort();

    return `${activeSessionId ?? "none"}:${sessionIds.join(",")}`;
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
      return "📥 Inbox";
    }

    const count = await this.inboxStore.countInboxMessages(sessionId);
    return count > 0 ? `📥 Inbox (${count})` : "📥 Inbox";
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

  private async createSessionMenuPayload(sessionId: string): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "active-session",
        sessionId,
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
    if (!payload || payload.kind !== "inbox-message" || !payload.messageId) {
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
    if (!payload || payload.kind !== "inbox-message" || !payload.messageId) {
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

  private async handleSessionSelection(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Session payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "active-session") {
      await ctx.answerCallbackQuery({
        text: "Session payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram user or chat is missing.",
        show_alert: true,
      });
      return;
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);
    if (!sessionIds.includes(payload.sessionId)) {
      await ctx.answerCallbackQuery({
        text: "This session is not linked to your Telegram identity.",
        show_alert: true,
      });
      return;
    }

    await this.bindingStore.setActiveSessionIdForPrincipal(
      principal,
      payload.sessionId,
    );
    const session = await this.sessionStore.getSession(payload.sessionId);

    this.logger.info("Telegram active session changed", {
      sessionId: payload.sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await ctx.answerCallbackQuery({
      text: session?.label
        ? `Active session: ${session.label}`
        : `Active session: ${payload.sessionId}`,
    });
    await this.showMainMenu(ctx);
  }

  private formatInboxPreviewLabel(message: TelegramInboxMessage): string {
    const compact = message.text.replace(/\s+/g, " ").trim();
    const preview =
      compact.length > 28 ? `${compact.slice(0, 28).trimEnd()}...` : compact;
    return preview.length > 0 ? preview : "(empty message)";
  }

  private formatSessionMenuLabel(input: {
    sessionId: string;
    sessionLabel?: string;
    active: boolean;
    inboxCount: number;
  }): string {
    const base = input.sessionLabel ?? input.sessionId;
    const activePrefix = input.active ? "✅ " : "📁 ";
    const inboxSuffix = input.inboxCount > 0 ? ` (${input.inboxCount})` : "";
    return `${activePrefix}${base}${inboxSuffix}`;
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

  private async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildSessionsMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.sessionsMenu,
    );
  }

  private async showInboxMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildInboxMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.inboxMenu,
    );
  }

  private async showBufferMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBufferMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.bufferMenu,
    );
  }

  private async showDeveloperMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildDeveloperMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.developerMenu,
    );
  }

  private async showUnpairConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildUnpairConfirmText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.unpairConfirmMenu,
    );
  }

  private async showPruneConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildPruneConfirmText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.pruneConfirmMenu,
    );
  }

  private async renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.editText(ctx, text, meta, {
        reply_markup: menu,
      });
      return;
    }

    await this.replyText(
      ctx,
      text,
      meta,
      {
        reply_markup: menu,
      },
    );
  }

  private async showHelp(ctx: TelegramMenuContext): Promise<void> {
    await this.replyText(
      ctx,
      [
        "❓ Telegram MCP help",
        "",
        "/menu - open the sessions list",
        "/help - show this help",
        "",
        "How it works:",
        "- choose the active session",
        "- ordinary Telegram messages go to that session inbox",
        "- if a tmux target is configured, the service nudges the agent automatically",
        "- the agent then reads the inbox batch through MCP tools",
      ].join("\n"),
      { kind: "menu" },
    );
  }

  private async showLiveViewLauncher(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      await ctx.answerCallbackQuery({
        text: "No active session selected.",
        show_alert: true,
      });
      return;
    }

    if (!this.config.webapp.enabled || !this.config.webapp.publicUrl) {
      await ctx.answerCallbackQuery({
        text: "WebApp is not enabled on the server.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const baseUrl = this.config.webapp.publicUrl.replace(/\/+$/u, "");
    const url = new URL(`${baseUrl}/live/${encodeURIComponent(activeSessionId)}`);
    this.webAppLaunchRegistry.set(
      principal.telegramUserId,
      activeSessionId,
      this.config.webapp.initDataTtlSeconds,
    );

    await ctx.answerCallbackQuery({ text: "Opening live view launcher." });
    await this.replyText(
      ctx,
      [
        "🖥 Live View",
        "",
        `Session: ${session?.label ?? activeSessionId}`,
        "Open the Mini App to view the current visible tmux pane and send Up/Down/Enter.",
      ].join("\n"),
      { kind: "menu", sessionId: activeSessionId },
      {
        reply_markup: new InlineKeyboard().webApp(
          "Open Live View",
          url.toString(),
        ),
      },
    );
  }

  private clearPendingInteractionsForContext(ctx: TelegramMenuContext): void {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return;
    }

    const key = buildPrincipalKey(principal);
    this.pendingRenames.delete(key);
    this.pendingBroadcasts.delete(key);
  }

  private async sendActiveSessionBuffer(
    ctx: TelegramMenuContext,
    scope: TmuxCaptureScope,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "No active session selected.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.tmuxTarget) {
      await ctx.answerCallbackQuery({
        text: "tmux target is not configured for this session.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: `Capturing ${this.describeCaptureScope(scope)}...`,
    });

    try {
      const capture = await this.captureTmuxBuffer(session, scope);
      await this.replyDocumentWithRetry(
        ctx,
        new InputFile(capture.buffer, capture.filename),
        {
          caption: `📄 Buffer: ${session.label ?? sessionId}`,
        },
        {
          kind: "menu",
          sessionId,
        },
      );

      this.logger.info("Telegram tmux buffer sent", {
        sessionId,
        tmuxTarget: session.tmuxTarget,
        filename: capture.filename,
        bytes: capture.buffer.length,
        captureMode: capture.captureMode,
        captureScope: capture.scopeDescription,
      });
    } catch (error) {
      const payload = {
        sessionId,
        tmuxTarget: session.tmuxTarget,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      };

      if (isTmuxUnavailableError(error)) {
        this.logger.warn("tmux buffer capture skipped because tmux is unavailable", payload);
        await this.replyText(
          ctx,
          "Unable to capture tmux buffer because tmux is unavailable.",
          { kind: "menu", sessionId },
        );
        return;
      }

      this.logger.error("tmux buffer capture failed", payload);
      await this.replyText(
        ctx,
        "Failed to capture the tmux buffer for this session.",
        { kind: "menu", sessionId },
      );
    }
  }

  private async buildSessionsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Telegram identity is unavailable for this chat.";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    const sessionIds = (
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
    ).sort();

    if (sessionIds.length === 0) {
      return "No linked sessions found for this Telegram identity.";
    }

    let lastWorkedSession:
      | {
          sessionId: string;
          label?: string | undefined;
          updatedAt?: string | undefined;
        }
      | undefined;

    for (const sessionId of sessionIds) {
      const session = await this.sessionStore.getSession(sessionId);
      const sessionUpdatedAtMs = session?.updatedAt
        ? Date.parse(session.updatedAt)
        : Number.NEGATIVE_INFINITY;
      const lastWorkedUpdatedAtMs = lastWorkedSession?.updatedAt
        ? Date.parse(lastWorkedSession.updatedAt)
        : Number.NEGATIVE_INFINITY;

      if (sessionUpdatedAtMs >= lastWorkedUpdatedAtMs) {
        lastWorkedSession = {
          sessionId,
          label: session?.label,
          updatedAt: session?.updatedAt,
        };
      }
    }

    const lines = ["🗂 Choose active session", ""];
    if (lastWorkedSession) {
      lines.push(
        `🕘 Last worked session: ${lastWorkedSession.label ?? lastWorkedSession.sessionId}`,
      );
      const formattedUpdatedAt = formatMenuTimestamp(
        lastWorkedSession.updatedAt,
      );
      if (formattedUpdatedAt) {
        lines.push(`⏱ Updated: ${formattedUpdatedAt}`);
      }
      lines.push("");
    }

    if (activeSessionId) {
      const activeSession = await this.sessionStore.getSession(activeSessionId);
      lines.push(`📌 Current active: ${activeSession?.label ?? activeSessionId}`);
      lines.push("");
    }

    lines.push("");
    lines.push(
      "The selected session becomes active for ordinary Telegram messages and for inbox processing.",
    );
    return lines.join("\n");
  }

  private async buildInboxMenuText(ctx: TelegramMenuContext): Promise<string> {
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
    const total = await this.inboxStore.countInboxMessages(activeSessionId);

    return [
      "📥 Inbox",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `📨 Stored messages: ${total}`,
      "",
      total > 0
        ? "Choose a message below to inspect or delete it."
        : "No stored unsolicited Telegram messages for this session.",
    ].join("\n");
  }

  private async buildBufferMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
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

    return [
      "📄 Buffer Export",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `🖥 tmux target: ${session?.tmuxTarget ?? "not set"}`,
      "",
      "Choose how much pane history to export as a Markdown file.",
      "Visible is the current pane viewport. Full exports the whole available tmux history.",
    ].join("\n");
  }

  private async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Telegram identity is unavailable for this chat.";
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      "🛠 Tools",
      "",
      `🔗 Linked sessions: ${sessionIds.length}`,
      "",
      "Broadcast writes your next text message into every linked session inbox and nudges all configured tmux targets.",
      "Prune all clears every Redis key under this Telegram MCP namespace.",
    ].join("\n");
  }

  private async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Telegram identity is unavailable for this chat.";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return "No active session selected.";
    }

    const session = await this.sessionStore.getSession(activeSessionId);

    return [
      "⚠ Confirm unpair",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      "",
      "This removes the Telegram binding for the active session.",
      "Session metadata and inbox records stay in Redis until you delete them separately.",
    ].join("\n");
  }

  private async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Telegram identity is unavailable for this chat.";
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      "⚠ Confirm prune",
      "",
      `🔗 Linked sessions visible here: ${sessionIds.length}`,
      "",
      "This clears every Redis key under the telegram-mcp namespace.",
      "Pair codes, bindings, sessions, inbox, menu payloads, and pending requests will all be deleted.",
    ].join("\n");
  }

  private async showActiveSessionInfo(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "No active session selected.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    const binding = await this.bindingStore.getBinding(sessionId);
    const inboxCount = await this.inboxStore.countInboxMessages(sessionId);

    await ctx.answerCallbackQuery({ text: "Session info opened." });
    await this.replyText(
      ctx,
      [
        "ℹ Session info",
        "",
        `📌 Label: ${session?.label ?? sessionId}`,
        `🆔 Session ID: ${sessionId}`,
        `📥 Inbox count: ${inboxCount}`,
        `🔗 Paired: ${binding ? "yes" : "no"}`,
        `🖥 tmux target: ${session?.tmuxTarget ?? "not set"}`,
        ...(session?.tmuxSessionName
          ? [`📺 tmux session: ${session.tmuxSessionName}`]
          : []),
        ...(session?.tmuxWindowName
          ? [`🪟 tmux window: ${session.tmuxWindowName}`]
          : []),
        ...(session?.tmuxPaneId ? [`🔹 tmux pane: ${session.tmuxPaneId}`] : []),
      ].join("\n"),
      { kind: "menu", sessionId },
      { reply_markup: this.mainMenu },
    );
  }

  private async captureTmuxBuffer(session: {
    sessionId: string;
    label?: string | undefined;
    tmuxTarget?: string | undefined;
    tmuxSessionName?: string | undefined;
    tmuxWindowName?: string | undefined;
    tmuxPaneId?: string | undefined;
  },
  scope: TmuxCaptureScope,
  ): Promise<{
    filename: string;
    buffer: Buffer;
    captureMode: TmuxCaptureScope["mode"];
    scopeDescription: string;
  }> {
    const target = session.tmuxTarget;
    if (!target) {
      throw new Error("tmux target is not configured");
    }

    const paneStart = await this.resolveTmuxCaptureStart(target, scope);
    const { stdout } = await execFileOutputAsync("tmux", [
      "capture-pane",
      "-p",
      "-t",
      target,
      "-S",
      paneStart,
    ]);

    const capturedAt = new Date().toISOString();
    const scopeDescription = this.describeCaptureScope(scope);
    const titleBase =
      session.label ?? session.tmuxWindowName ?? session.sessionId;
    const filenameBase = slugifyFilenamePart(titleBase) || "session-buffer";
    const timestamp = capturedAt.replace(/[:.]/g, "-");
    const filename = `${filenameBase}-${timestamp}.md`;
    const content = [
      `# tmux Buffer`,
      "",
      `- Session: ${session.label ?? session.sessionId}`,
      `- Session ID: ${session.sessionId}`,
      `- tmux target: ${target}`,
      ...(session.tmuxSessionName
        ? [`- tmux session: ${session.tmuxSessionName}`]
        : []),
      ...(session.tmuxWindowName
        ? [`- tmux window: ${session.tmuxWindowName}`]
        : []),
      ...(session.tmuxPaneId ? [`- tmux pane: ${session.tmuxPaneId}`] : []),
      `- Capture scope: ${scopeDescription}`,
      `- Captured at: ${capturedAt}`,
      "",
      "```text",
      stdout.replace(/\u0000/g, ""),
      "```",
      "",
    ].join("\n");

    return {
      filename,
      buffer: Buffer.from(content, "utf8"),
      captureMode: scope.mode,
      scopeDescription,
    };
  }

  private async resolveTmuxCaptureStart(
    target: string,
    scope: TmuxCaptureScope,
  ): Promise<string> {
    if (scope.mode === "full") {
      return "-";
    }

    if (scope.mode === "lines") {
      return `-${scope.lines}`;
    }

    const { stdout } = await execFileOutputAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      target,
      "#{window_height}",
    ]);
    const height = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(height) || height <= 0) {
      return `-${this.config.tmux.captureLines}`;
    }

    return `-${height}`;
  }

  private describeCaptureScope(scope: TmuxCaptureScope): string {
    switch (scope.mode) {
      case "visible":
        return "visible pane";
      case "lines":
        return `last ${scope.lines} lines`;
      case "full":
        return "full history";
    }
  }

  private async replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: Parameters<TelegramMenuContext["replyWithDocument"]>[1] = {},
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.replyWithDocument(document, options);
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
          "Telegram rate limit hit while sending document, cooling down",
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

  private async unpairActiveSession(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "No active session selected.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    await this.bindingStore.clearBinding(sessionId);

    this.logger.info("Telegram active session unpaired from menu", {
      sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    this.clearPendingInteractionsForContext(ctx);

    await ctx.answerCallbackQuery({
      text: session?.label
        ? `Unpaired: ${session.label}`
        : `Unpaired: ${sessionId}`,
    });
    await this.showSessionsMenu(
      ctx,
      session?.label
        ? `Session unpaired: ${session.label}`
        : `Session unpaired: ${sessionId}`,
    );
  }

  private async beginRenameActiveSession(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "No active session selected.",
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingBroadcasts.delete(principalKey);
    this.pendingRenames.set(principalKey, { sessionId });
    await ctx.answerCallbackQuery({ text: "Send the new session title." });
    await this.replyText(
      ctx,
      [
        "✏ Rename session",
        "",
        "Send the next text message as the new title for the active session.",
        "Commands like /menu or /help will cancel rename mode.",
      ].join("\n"),
      { kind: "menu", sessionId },
    );
  }

  private async beginBroadcast(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);
    if (sessionIds.length === 0) {
      await ctx.answerCallbackQuery({
        text: "No linked sessions found.",
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingRenames.delete(principalKey);
    this.pendingBroadcasts.set(principalKey, {
      initiatedAt: new Date().toISOString(),
    });

    await ctx.answerCallbackQuery({
      text: `Broadcast to ${sessionIds.length} sessions.`,
    });
    await this.replyText(
      ctx,
      [
        "📣 Broadcast",
        "",
        `Send the next text message to broadcast it to all ${sessionIds.length} linked sessions.`,
        "The message will be stored in every session inbox and the service will nudge every configured tmux target.",
        "Commands like /menu or /help will cancel broadcast mode.",
      ].join("\n"),
      { kind: "menu" },
    );
  }

  private async pruneAllSessions(ctx: TelegramMenuContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: "Pruning all state..." });
    const result = await this.maintenanceStore.pruneAll();
    this.clearPendingInteractionsForContext(ctx);
    this.clearTmuxNudgeDebounceTimers();
    await this.showSessionsMenu(
      ctx,
      `Prune complete. Deleted ${result.deletedKeys} Redis keys.`,
    );
  }

  private async handlePendingRename(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const pending = this.pendingRenames.get(buildPrincipalKey(principal));
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingRenames.delete(buildPrincipalKey(principal));
      return false;
    }

    const session = await this.sessionStore.getSession(pending.sessionId);
    const updatedAt = new Date().toISOString();
    const label = redactSecrets(text);

    await this.sessionStore.setSession({
      sessionId: pending.sessionId,
      label,
      ...(session?.task ? { task: session.task } : {}),
      ...(session?.summary ? { summary: session.summary } : {}),
      ...(session?.files ? { files: session.files } : {}),
      ...(session?.decisions ? { decisions: session.decisions } : {}),
      ...(session?.risks ? { risks: session.risks } : {}),
      ...(session?.tmuxSessionName
        ? { tmuxSessionName: session.tmuxSessionName }
        : {}),
      ...(session?.tmuxWindowName
        ? { tmuxWindowName: session.tmuxWindowName }
        : {}),
      ...(typeof session?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: session.tmuxWindowIndex }
        : {}),
      ...(session?.tmuxPaneId ? { tmuxPaneId: session.tmuxPaneId } : {}),
      ...(typeof session?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: session.tmuxPaneIndex }
        : {}),
      ...(session?.tmuxTarget ? { tmuxTarget: session.tmuxTarget } : {}),
      ...(session?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: session.lastTmuxNudgeAt }
        : {}),
      updatedAt,
    });

    this.pendingRenames.delete(buildPrincipalKey(principal));
    this.logger.info("Telegram session renamed from menu", {
      sessionId: pending.sessionId,
      sessionLabel: label,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await this.replyText(
      ctx,
      `Session renamed: ${label}`,
      { kind: "menu", sessionId: pending.sessionId },
      { reply_markup: this.mainMenu },
    );
    return true;
  }

  private async handlePendingBroadcast(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingBroadcasts.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingBroadcasts.delete(principalKey);
      return false;
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);
    const broadcastText = text.trim();
    if (sessionIds.length === 0) {
      this.pendingBroadcasts.delete(principalKey);
      await this.replyText(
        ctx,
        "Broadcast cancelled because no linked sessions were found.",
        { kind: "menu" },
      );
      return true;
    }

    const receivedAt = new Date(
      ctx.message?.date ? ctx.message.date * 1000 : Date.now(),
    ).toISOString();
    let storedCount = 0;

    for (const sessionId of sessionIds) {
      const inboxMessage: TelegramInboxMessage = {
        id: createInboxMessageId(),
        sessionId,
        telegramChatId: principal.telegramChatId,
        telegramUserId: principal.telegramUserId,
        sourceTelegramMessageId: ctx.message?.message_id ?? 0,
        text: broadcastText,
        receivedAt,
      };

      await this.inboxStore.createInboxMessage(inboxMessage);
      storedCount += 1;

      this.logger.info("Telegram broadcast message stored in inbox", {
        sessionId,
        chatId: principal.telegramChatId,
        userId: principal.telegramUserId,
        inboxMessageId: inboxMessage.id,
        text: redactSecrets(broadcastText),
      });

      const session = await this.sessionStore.getSession(sessionId);
      try {
        this.scheduleTmuxNudgeForInboxMessage(sessionId, session);
      } catch (error) {
        this.logger.error("tmux nudge failed after broadcast inbox capture", {
          sessionId,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      }
    }

    this.pendingBroadcasts.delete(principalKey);
    this.logger.info("Telegram broadcast completed", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
      storedCount,
      sessionCount: sessionIds.length,
      initiatedAt: pending.initiatedAt,
      text: redactSecrets(broadcastText),
    });

    await this.showDeveloperMenu(
      ctx,
      `Broadcast delivered to ${storedCount} sessions.`,
    );
    return true;
  }
}
