import type { Bot } from "grammy";

import type { Logger } from "../../lib/logger/logger";
import type { TelegramMenuContext } from "./transportTypes";

type TransportMenuShellHost = {
  logger: Logger;
  tForContext: (
    ctx: TelegramMenuContext,
    key: string,
  ) => Promise<string>;
  showProjectsMenu: (ctx: TelegramMenuContext) => Promise<void>;
  handleMessage: (ctx: TelegramMenuContext) => Promise<void>;
  cancelPendingBroadcast: (ctx: TelegramMenuContext) => Promise<void>;
  cancelPendingPartnerNote: (ctx: TelegramMenuContext) => Promise<void>;
  cancelPendingFileHandoff: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectSetCallback: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectMembersCallback: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectMemberOpenCallback: (
    ctx: TelegramMenuContext,
  ) => Promise<void>;
  handleProjectMemberNoteCallback: (
    ctx: TelegramMenuContext,
  ) => Promise<void>;
  handleProjectMemberLiveCallback: (
    ctx: TelegramMenuContext,
  ) => Promise<void>;
  handleLiveApprovalCallback: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectDetailCallback: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectDeleteCallback: (ctx: TelegramMenuContext) => Promise<void>;
  handleProjectLeaveCallback: (ctx: TelegramMenuContext) => Promise<void>;
};

export class TransportMenuShell {
  public constructor(private readonly host: TransportMenuShellHost) {}

  public register(bot: Bot<TelegramMenuContext>): void {
    bot.catch((error) => {
      this.host.logger.error("Telegram polling error", {
        error:
          error.error instanceof Error
            ? error.error.message
            : String(error.error),
      });
    });
    bot.callbackQuery("broadcast-cancel", async (ctx) => {
      await this.host.cancelPendingBroadcast(ctx);
    });
    bot.callbackQuery("partner-note-cancel", async (ctx) => {
      await this.host.cancelPendingPartnerNote(ctx);
    });
    bot.callbackQuery("file-handoff-cancel", async (ctx) => {
      await this.host.cancelPendingFileHandoff(ctx);
    });
    bot.callbackQuery(/^project-set:(.+)$/u, async (ctx) => {
      await this.host.handleProjectSetCallback(ctx);
    });
    bot.callbackQuery(/^project-members:(.+)$/u, async (ctx) => {
      await this.host.handleProjectMembersCallback(ctx);
    });
    bot.callbackQuery(/^project-member-open:(.+)$/u, async (ctx) => {
      await this.host.handleProjectMemberOpenCallback(ctx);
    });
    bot.callbackQuery(
      /^project-member-note:(question|share):(.+)$/u,
      async (ctx) => {
        await this.host.handleProjectMemberNoteCallback(ctx);
      },
    );
    bot.callbackQuery(/^project-member-live:(.+)$/u, async (ctx) => {
      await this.host.handleProjectMemberLiveCallback(ctx);
    });
    bot.callbackQuery(/^live-approval:(approve|deny):(.+)$/u, async (ctx) => {
      await this.host.handleLiveApprovalCallback(ctx);
    });
    bot.callbackQuery(/^project-detail:(.+)$/u, async (ctx) => {
      await this.host.handleProjectDetailCallback(ctx);
    });
    bot.callbackQuery(/^project-delete:(.+)$/u, async (ctx) => {
      await this.host.handleProjectDeleteCallback(ctx);
    });
    bot.callbackQuery(/^project-leave:(.+)$/u, async (ctx) => {
      await this.host.handleProjectLeaveCallback(ctx);
    });
    bot.callbackQuery("project-back", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Back to projects." });
      await this.host.showProjectsMenu(ctx);
    });
    bot.on("message", async (ctx) => {
      await this.host.handleMessage(ctx);
    });
  }
}
