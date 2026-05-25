import { Menu, MenuRange } from "@grammyjs/menu";

import type { TelegramMenuContext } from "./transportTypes";

export interface TransportProjectMenusHost {
  createMenuOptions(
    onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void>,
  ): {
    onMenuOutdated: (ctx: TelegramMenuContext) => Promise<void>;
  };
  buildProjectsFingerprint(ctx: TelegramMenuContext): Promise<string>;
  loadProjectsContext(
    ctx: TelegramMenuContext,
  ): Promise<{
    session: {
      sessionId: string;
      activeProjectUuid?: string | undefined;
    } | null;
    projects: Array<{
      project_uuid: string;
      name: string;
      role: string;
    }> | null;
  }>;
  tForContext(
    ctx: TelegramMenuContext,
    key: string,
    vars?: Record<string, string | number>,
  ): Promise<string>;
  createProjectMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string>;
  createProjectDeleteMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string>;
  handleProjectSelect(ctx: TelegramMenuContext): Promise<void>;
  handleProjectDeleteSelect(ctx: TelegramMenuContext): Promise<void>;
  beginProjectMode(
    ctx: TelegramMenuContext,
    mode: "create" | "join",
  ): Promise<void>;
  beginProjectBroadcast(ctx: TelegramMenuContext): Promise<void>;
  handleCollabHistoryExport(ctx: TelegramMenuContext): Promise<void>;
  showCollabToolsMenu(ctx: TelegramMenuContext): Promise<void>;
  showCollabDeleteMenu(ctx: TelegramMenuContext): Promise<void>;
  showProjectsMenu(ctx: TelegramMenuContext): Promise<void>;
  showMainMenu(ctx: TelegramMenuContext): Promise<void>;
}

export class TransportProjectMenus {
  public constructor(private readonly host: TransportProjectMenusHost) {}

  public createProjectsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-projects-menu", {
      fingerprint: async (ctx) => this.host.buildProjectsFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showProjectsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const { session, projects } = await this.host.loadProjectsContext(ctx);
        if (!session || !projects) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.gateway_unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:collab.actions.gateway_only",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        if (projects.length === 0) {
          range
            .text(
              await this.host.tForContext(ctx, "menu:collab.labels.no_projects"),
              async (innerCtx) => {
                await innerCtx.answerCallbackQuery({
                  text: await this.host.tForContext(
                    innerCtx,
                    "menu:collab.actions.no_projects",
                  ),
                });
              },
            )
            .row();
          return range;
        }

        for (const project of projects) {
          const isActive = session.activeProjectUuid === project.project_uuid;
          range
            .text(
              {
                text: `${isActive ? "✅" : "📁"} ${project.name}`,
                payload: async () =>
                  this.host.createProjectMenuPayload(
                    session.sessionId,
                    project.project_uuid,
                    project.name,
                  ),
              },
              async (innerCtx) => {
                await this.host.handleProjectSelect(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.create"),
        async (ctx) => {
          await this.host.beginProjectMode(ctx, "create");
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.tools"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:collab.actions.open_tools"),
          });
          await this.host.showCollabToolsMenu(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.join"),
        async (ctx) => {
          await this.host.beginProjectMode(ctx, "join");
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(
              ctx,
              "menu:collab.actions.back_to_session_menu",
            ),
          });
          await this.host.showMainMenu(ctx);
        },
      );
  }

  public createCollabToolsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-collab-tools-menu",
      this.host.createMenuOptions((ctx) => this.host.showCollabToolsMenu(ctx)),
    )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.broadcast"),
        async (ctx) => {
          await this.host.beginProjectBroadcast(ctx);
        },
      )
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.history"),
        async (ctx) => {
          await this.host.handleCollabHistoryExport(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "menu:collab.buttons.delete"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:collab.actions.open_delete"),
          });
          await this.host.showCollabDeleteMenu(ctx);
        },
      )
      .row()
      .text(
        async (ctx) => this.host.tForContext(ctx, "common:menu.back"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.host.tForContext(ctx, "menu:collab.actions.back_to_collab"),
          });
          await this.host.showProjectsMenu(ctx);
        },
      );
  }

  public createCollabDeleteMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-collab-delete-menu", {
      fingerprint: async (ctx) => this.host.buildProjectsFingerprint(ctx),
      ...this.host.createMenuOptions((ctx) => this.host.showCollabDeleteMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const { session, projects } = await this.host.loadProjectsContext(ctx);
        if (!session || !projects) {
          range.text(
            await this.host.tForContext(ctx, "common:menu.gateway_unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:collab.actions.gateway_only",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        if (projects.length === 0) {
          range.text(
            await this.host.tForContext(ctx, "menu:collab.labels.no_projects"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.host.tForContext(
                  innerCtx,
                  "menu:collab.actions.no_projects",
                ),
              });
            },
          );
          return range;
        }

        for (const project of projects.filter((item) => item.role === "owner")) {
          range
            .text(
              {
                text: `🗑 ${project.name}`,
                payload: async () =>
                  this.host.createProjectDeleteMenuPayload(
                    session.sessionId,
                    project.project_uuid,
                    project.name,
                  ),
              },
              async (innerCtx) => {
                await this.host.handleProjectDeleteSelect(innerCtx);
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
            text: await this.host.tForContext(ctx, "menu:collab.actions.back_to_tools"),
          });
          await this.host.showCollabToolsMenu(ctx);
        },
      );
  }
}
