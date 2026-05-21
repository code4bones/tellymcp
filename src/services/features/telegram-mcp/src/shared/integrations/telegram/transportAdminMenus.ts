import { Menu, MenuRange } from "@grammyjs/menu";

import type { AdminClientViewRecord, TelegramMenuContext } from "./transportTypes";
import { buildAdminClientButtonLabel } from "./transportUtils";

export interface TransportAdminMenusHost {
  createMenuOptions(
    onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void>,
  ): { onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void> };
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  showAdminMainMenu(ctx: TelegramMenuContext): Promise<void>;
  showAdminClientsMenu(ctx: TelegramMenuContext): Promise<void>;
  showAdminClientSessionsMenu(ctx: TelegramMenuContext): Promise<void>;
  showAdminClientSessionList(
    ctx: TelegramMenuContext,
    scope: "collab" | "all",
  ): Promise<void>;
  showAdminToolsMenu(ctx: TelegramMenuContext): Promise<void>;
  listGatewayAdminClients(): Promise<AdminClientViewRecord[]>;
  createAdminClientMenuPayload(client: AdminClientViewRecord): Promise<string>;
  handleAdminClientSelectCallback(ctx: TelegramMenuContext): Promise<void>;
  adminHandleClientEnvExport(ctx: TelegramMenuContext): Promise<void>;
}

export class TransportAdminMenus {
  public constructor(private readonly host: TransportAdminMenusHost) {}

  public createAdminMainMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-main-menu", {
      ...this.host.createMenuOptions((ctx) => this.host.showAdminMainMenu(ctx)),
    })
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:admin.buttons.clients"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.open_clients"),
          });
          await this.host.showAdminClientsMenu(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:admin.buttons.tools"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.open_tools"),
          });
          await this.host.showAdminToolsMenu(ctx);
        },
      );
  }

  public createAdminClientsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-clients-menu", {
      ...this.host.createMenuOptions((ctx) => this.host.showAdminClientsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        let clients: AdminClientViewRecord[];
        try {
          clients = await this.host.listGatewayAdminClients();
        } catch {
          range.text(
            await this.host.tForContext(ctx, "menu:admin.clients.unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:admin.clients.unavailable",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        if (clients.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:admin.clients.empty"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(innerCtx, "menu:admin.clients.empty"),
              });
            },
          );
          return range;
        }

        for (const client of clients) {
          const payloadKey = await this.host.createAdminClientMenuPayload(client);
          range
            .text(
              {
                text: buildAdminClientButtonLabel(client),
                payload: async () => payloadKey,
              },
              async (innerCtx) => {
                await this.host.handleAdminClientSelectCallback(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.back_to_admin"),
          });
          await this.host.showAdminMainMenu(ctx);
        },
      );
  }

  public createAdminClientSessionsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-client-sessions-menu", {
      ...this.host.createMenuOptions((ctx) => this.host.showAdminClientSessionsMenu(ctx)),
    })
      .text(
        async (ctx) =>
          this.host.tForContext(ctx, "menu:admin.client_sessions.buttons.collab"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
          });
          await this.host.showAdminClientSessionList(ctx, "collab");
        },
      )
      .text(
        async (ctx) =>
          this.host.tForContext(ctx, "menu:admin.client_sessions.buttons.all"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
          });
          await this.host.showAdminClientSessionList(ctx, "all");
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.back_to_clients"),
          });
          await this.host.showAdminClientsMenu(ctx);
        },
      );
  }

  public createAdminClientSessionDetailMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-client-session-detail-menu", {
      ...this.host.createMenuOptions((ctx) => this.host.showAdminClientSessionsMenu(ctx)),
    });
  }

  public createAdminToolsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-tools-menu", {
      ...this.host.createMenuOptions((ctx) => this.host.showAdminToolsMenu(ctx)),
    })
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:admin.buttons.client_env"),
        async (ctx) => {
          await this.host.adminHandleClientEnvExport(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:admin.actions.back_to_admin"),
          });
          await this.host.showAdminMainMenu(ctx);
        },
      );
  }
}
