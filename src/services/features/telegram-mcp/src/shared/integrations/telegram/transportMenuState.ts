import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import { getTellyMcpPackageRoot, getTellyMcpPackageVersion } from "../../lib/version/versionHandshake";
import type {
  CurrentAttachmentTargetRecord,
  GatewayClientRecord,
  GatewayConnectedClientRecord,
  TelegramMenuContext,
  TelegramSendMessageOptions,
} from "./transportTypes";
import {
  buildBrowserMenuText,
  buildBufferMenuText,
  buildInboxMenuText,
  buildLinkMenuText,
  buildLocalMenuText,
  buildMainMenuText,
  buildPartnerMenuText,
  buildScreenshotsMenuText,
  buildSettingsMenuText,
  buildStorageMenuText,
} from "./transportMenuText";
import {
  escapeHtml,
  formatMenuTimestamp,
  readMenuPayloadKey,
  renderMarkdownChunk,
} from "./transportUtils";

function splitSessionDisplayLabel(input: {
  sessionId: string;
  sessionLabel?: string;
}): {
  shortLabel: string;
  ownerLabel: string | null;
} {
  const label = (input.sessionLabel?.trim() || input.sessionId.trim() || "session").trim();
  const separator = " · ";
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex <= 0) {
    return {
      shortLabel: label,
      ownerLabel: null,
    };
  }

  return {
    shortLabel: label.slice(0, separatorIndex).trim() || label,
    ownerLabel: label.slice(separatorIndex + separator.length).trim() || null,
  };
}

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportMenuStateHost {
  logger: Logger;
  t(
    locale: SupportedLocale,
    key: string,
    vars?: Record<string, string | number>,
  ): string;
  resolveLocaleForContext(ctx: TelegramMenuContext): Promise<SupportedLocale>;
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  getTmuxStatusLine(locale: SupportedLocale): Promise<string>;
  setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void;
  renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  renderMenuScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  renderMenuMarkdownScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    menu: unknown,
  ): Promise<void>;
  replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: { kind: "menu"; sessionId?: string },
    options?: TelegramSendMessageOptions,
  ): Promise<void | { message_id: number }>;
  getMenuPayloadByKey(key: string): Promise<Record<string, unknown> | null>;
  getMainMenu(): unknown;
  getSessionsMenu(): unknown;
  getInboxMenu(): unknown;
  getStorageMenu(): unknown;
  getBrowserMenu(): unknown;
  getScreenshotsMenu(): unknown;
  getLinkMenu(): unknown;
  getPartnerMenu(): unknown;
  getLocalMenu(): unknown;
  getSettingsMenu(): unknown;
  getBufferMenu(): unknown;
  getDeveloperMenu(): unknown;
  getUnpairConfirmMenu(): unknown;
  getPruneConfirmMenu(): unknown;
  sessionStore: {
    getSession(sessionId: string): Promise<{
      sessionId: string;
      label?: string | undefined;
      linkedSessionId?: string | undefined;
      activeProjectName?: string | undefined;
      tmuxTarget?: string | undefined;
      updatedAt?: string | undefined;
    } | null>;
  };
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
    listBoundSessionIdsForPrincipal(principal: Principal): Promise<string[]>;
  };
  inboxStore: {
    countInboxMessages(sessionId: string): Promise<number>;
  };
  listActiveSessionScreenshots(sessionId: string): Promise<string[]>;
  listActiveSessionStorageEntries(
    sessionId: string,
  ): Promise<Array<{ filePath: string }>>;
  callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
}

export class TransportMenuState {
  public constructor(private readonly host: TransportMenuStateHost) {}

  private async collectDeveloperInfo(
    ctx: TelegramMenuContext,
  ): Promise<{
    headerMarkdown: string;
    clientMarkdownChunks: string[];
  }> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return {
        headerMarkdown: renderMarkdownChunk("Gateway Info", "No Telegram identity."),
        clientMarkdownChunks: [],
      };
    }

    const clientsResult = await this.host.callGatewayJson<{
      clients: GatewayClientRecord[];
    }>("/clients/list", {
      telegram_user_id: principal.telegramUserId,
    });
    const connectedResult = await this.host.callGatewayJson<{
      clients: GatewayConnectedClientRecord[];
    }>("/clients/connected", {});

    const ownedClientUuids = new Set(
      clientsResult.clients.map((client) => client.client_uuid),
    );
    const connectedClients = connectedResult.clients.filter((client) =>
      ownedClientUuids.has(client.client_uuid),
    );

    const packageVersion = getTellyMcpPackageVersion(__dirname);
    const toolsHash = this.getGatewayToolsHash();
    const connectedClientCount = new Set(
      connectedClients.map((client) => client.client_uuid),
    ).size;
    const connectedSessionCount = connectedClients.reduce(
      (total, client) => total + client.session_tools.length,
      0,
    );

    const headerLines: string[] = [
      `Gateway package: ${packageVersion}`,
      `Gateway TOOLS hash: ${toolsHash ?? "unknown"}`,
      `Clients: ${clientsResult.clients.length}`,
      `Connected clients: ${connectedClientCount}`,
      `Connected sessions: ${connectedSessionCount}`,
    ];

    const clientByUuid = new Map(
      clientsResult.clients.map((client) => [client.client_uuid, client]),
    );

    const clientMarkdownChunks = connectedClients.flatMap((connectedClient) => {
      const client = clientByUuid.get(connectedClient.client_uuid);
      if (!client) {
        return [];
      }

      return connectedClient.session_tools.map((sessionTool) => {
        const owner =
          client.telegram_display_name ||
          (client.telegram_username
            ? `@${client.telegram_username}`
            : client.system_username || client.client_label || client.node_id || client.client_uuid);
        const sessionName =
          sessionTool.session_label?.trim() || sessionTool.local_session_id;
        const title = `${owner} / ${sessionName}`;
        const bodyLines = [
          `client_uuid: ${client.client_uuid}`,
          `session_id: ${sessionTool.local_session_id}`,
          `node: ${client.node_id || client.client_label || "unknown"}`,
          ...(sessionTool.tools_hash
            ? [`tools_hash: ${sessionTool.tools_hash}`]
            : []),
          ...(connectedClient.package_version
            ? [`agent_version: ${connectedClient.package_version}`]
            : []),
          ...(client.last_seen_at ? [`last_seen_at: ${client.last_seen_at}`] : []),
        ];

        return renderMarkdownChunk(title, bodyLines.join("\n"));
      });
    });

    return {
      headerMarkdown: renderMarkdownChunk("Gateway Info", headerLines.join("\n")),
      clientMarkdownChunks,
    };
  }

  private getGatewayToolsHash(): string | null {
    const packageRoot = getTellyMcpPackageRoot(__dirname);
    if (!packageRoot) {
      return null;
    }

    try {
      const content = readFileSync(join(packageRoot, "TOOLS.md"), "utf8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  }

  public async showMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.host.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getMainMenu(),
    );
  }

  public async buildMainMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const inboxCount = await this.host.inboxStore.countInboxMessages(activeSessionId);
    const sessionName = escapeHtml(session?.label ?? activeSessionId);
    const projectName = session?.activeProjectName
      ? escapeHtml(session.activeProjectName)
      : null;
    return buildMainMenuText({
      title: this.host.t(locale, "menu:main.screen.title", { sessionName }),
      inboxMessagesLine: this.host.t(locale, "menu:main.screen.inbox_messages", {
        count: inboxCount,
      }),
      projectLine: projectName
        ? this.host.t(locale, "menu:main.screen.project", { projectName })
        : null,
    });
  }

  public async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    try {
      const text = await this.buildSessionsMenuText(ctx);
      const intro = introText ? escapeHtml(introText) : null;
      await this.host.renderMenuHtmlScreen(
        ctx,
        intro ? `${intro}\n\n${text}` : text,
        { kind: "menu" },
        this.host.getSessionsMenu(),
      );
    } catch (error) {
      this.host.logger.error("Failed to render Telegram sessions menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      await this.host.replyText(
        ctx,
        this.host.t(
          await this.host.resolveLocaleForContext(ctx),
          "menu:system.sessions_menu_unavailable",
        ),
        { kind: "menu" },
      );
    }
  }

  public async buildSessionsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    const sessionIds = (
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal)
    ).sort();

    if (sessionIds.length === 0) {
      return this.host.t(locale, "menu:sessions.screen.no_linked_sessions");
    }

    let lastWorkedSession:
      | {
          sessionId: string;
          label?: string | undefined;
          updatedAt?: string | undefined;
        }
      | undefined;

    for (const sessionId of sessionIds) {
      const session = await this.host.sessionStore.getSession(sessionId);
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

    const lines = [this.host.t(locale, "menu:sessions.screen.title"), ""];
    if (lastWorkedSession) {
      lines.push(
        this.host.t(locale, "menu:sessions.screen.last_worked", {
          sessionName: escapeHtml(
            lastWorkedSession.label ?? lastWorkedSession.sessionId,
          ),
        }),
      );
      const formattedUpdatedAt = formatMenuTimestamp(lastWorkedSession.updatedAt);
      if (formattedUpdatedAt) {
        lines.push(
          this.host.t(locale, "menu:sessions.screen.updated", {
            timestamp: escapeHtml(formattedUpdatedAt),
          }),
        );
      }
      lines.push("");
    }

    if (activeSessionId) {
      const activeSession = await this.host.sessionStore.getSession(activeSessionId);
      lines.push(
        this.host.t(locale, "menu:sessions.screen.current_active", {
          sessionName: escapeHtml(activeSession?.label ?? activeSessionId),
        }),
      );
      lines.push("");
    }

    const currentPayloadKey = readMenuPayloadKey(ctx);
    let selectedOwnerLabel: string | null = null;
    if (currentPayloadKey) {
      const payload = await this.host.getMenuPayloadByKey(currentPayloadKey);
      if (
        payload &&
        (payload.kind === "session-group" || payload.kind === "active-session") &&
        typeof payload.ownerKey === "string"
      ) {
        selectedOwnerLabel = payload.ownerKey;
      }
    }

    const groupedSessions = new Map<string, { ownerLabel: string | null; labels: string[] }>();
    for (const sessionId of sessionIds) {
      const session = await this.host.sessionStore.getSession(sessionId);
      const display = splitSessionDisplayLabel({
        sessionId,
        ...(session?.label ? { sessionLabel: session.label } : {}),
      });
      const groupKey =
        parseLiveRelaySessionId(sessionId)?.clientUuid ??
        display.ownerLabel ??
        sessionId;
      const currentGroup = groupedSessions.get(groupKey) ?? {
        ownerLabel: display.ownerLabel,
        labels: [],
      };
      currentGroup.labels.push(display.shortLabel);
      if (!currentGroup.ownerLabel && display.ownerLabel) {
        currentGroup.ownerLabel = display.ownerLabel;
      }
      groupedSessions.set(groupKey, currentGroup);
    }

    if (groupedSessions.size > 0) {
      lines.push(this.host.t(locale, "menu:sessions.screen.choose_session"));
      for (const [groupKey, group] of [...groupedSessions.entries()].sort(
        (left, right) => {
          const leftKey = left[0] || "\uffff";
          const rightKey = right[0] || "\uffff";
          return leftKey.localeCompare(rightKey);
        },
      )) {
        if (selectedOwnerLabel !== null && groupKey !== selectedOwnerLabel) {
          continue;
        }
        const renderedLabels = group.labels.sort((left, right) =>
          left.localeCompare(right),
        );
        if (selectedOwnerLabel !== null) {
          if (group.ownerLabel) {
            lines.push(`• ${escapeHtml(group.ownerLabel)}`);
            lines.push("");
          }
          for (const label of renderedLabels) {
            lines.push(`• ${escapeHtml(label)}`);
          }
          break;
        }
        if (group.ownerLabel) {
          lines.push(
            `• ${escapeHtml(group.ownerLabel)}: ${escapeHtml(renderedLabels.join(", "))}`,
          );
        } else {
          lines.push(`• ${escapeHtml(renderedLabels.join(", "))}`);
        }
      }
      lines.push("");
    }

    lines.push(`<i>${escapeHtml(await this.host.getTmuxStatusLine(locale))}</i>`);
    lines.push("");
    return lines.join("\n");
  }

  public async showInboxMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildInboxMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getInboxMenu(),
    );
  }

  public async buildInboxMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const total = await this.host.inboxStore.countInboxMessages(activeSessionId);

    return buildInboxMenuText({
      title: this.host.t(locale, "menu:inbox.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:inbox.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedMessagesLine: this.host.t(locale, "menu:inbox.screen.stored_messages", {
        count: total,
      }),
      chooseMessageLine: this.host.t(locale, "menu:inbox.screen.choose_message"),
      emptyLine: this.host.t(locale, "menu:inbox.screen.empty"),
      total,
    });
  }

  public async showStorageMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildStorageMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getStorageMenu(),
    );
  }

  public async buildStorageMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const entries = await this.host.listActiveSessionStorageEntries(activeSessionId);

    return buildStorageMenuText({
      title: this.host.t(locale, "menu:storage.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:storage.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedFilesLine: this.host.t(locale, "menu:storage.screen.stored_files", {
        count: entries.length,
      }),
      chooseFileLine: this.host.t(locale, "menu:storage.screen.choose_file"),
      emptyLine: this.host.t(locale, "menu:storage.screen.empty"),
      total: entries.length,
    });
  }

  public async showBrowserMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBrowserMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getBrowserMenu(),
    );
  }

  public async buildBrowserMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const screenshots = await this.host.listActiveSessionScreenshots(activeSessionId);

    return buildBrowserMenuText({
      title: this.host.t(locale, "menu:browser.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:browser.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      storedScreenshotsLine: this.host.t(
        locale,
        "menu:browser.screen.stored_screenshots",
        { count: screenshots.length },
      ),
      chooseActionLine: this.host.t(locale, "menu:browser.screen.choose_action"),
    });
  }

  public async showScreenshotsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildScreenshotsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getScreenshotsMenu(),
    );
  }

  public async buildScreenshotsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const files = await this.host.listActiveSessionScreenshots(activeSessionId);

    return buildScreenshotsMenuText({
      title: this.host.t(locale, "menu:screenshots.screen.title"),
      activeSessionLine: this.host.t(
        locale,
        "menu:screenshots.screen.active_session",
        {
          sessionName: session?.label ?? activeSessionId,
        },
      ),
      storedScreenshotsLine: this.host.t(
        locale,
        "menu:screenshots.screen.stored_screenshots",
        { count: files.length },
      ),
      chooseScreenshotLine: this.host.t(
        locale,
        "menu:screenshots.screen.choose_screenshot",
      ),
      emptyLine: this.host.t(locale, "menu:screenshots.screen.empty"),
      total: files.length,
    });
  }

  public async showLinkMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildLinkMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getLinkMenu(),
    );
  }

  public async buildLinkMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    return buildLinkMenuText({
      title: this.host.t(locale, "menu:link.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:link.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      choosePartnerLine: this.host.t(locale, "menu:link.screen.choose_partner"),
      hintLine: this.host.t(locale, "menu:link.screen.hint"),
    });
  }

  public async showPartnerMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (principal) {
      const sessionId =
        await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
      const session = sessionId
        ? await this.host.sessionStore.getSession(sessionId)
        : null;
      if (sessionId && session?.linkedSessionId) {
        const linkedSession = await this.host.sessionStore.getSession(
          session.linkedSessionId,
        );
        this.host.setCurrentAttachmentTargetForContext(ctx, {
          sessionId,
          targetSessionId: session.linkedSessionId,
          targetSessionLabel: linkedSession?.label ?? session.linkedSessionId,
        });
      } else {
        this.host.setCurrentAttachmentTargetForContext(ctx, null);
      }
    }
    const text = await this.buildPartnerMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getPartnerMenu(),
    );
  }

  public async buildPartnerMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    if (!session?.linkedSessionId) {
      return buildPartnerMenuText({
        title: this.host.t(locale, "menu:partner.screen.title"),
        activeSessionLine: this.host.t(locale, "menu:partner.screen.active_session", {
          sessionName: session?.label ?? activeSessionId,
        }),
        noPartnerLine: this.host.t(locale, "menu:partner.screen.no_partner"),
        useLinkFirstLine: this.host.t(locale, "menu:partner.screen.use_link_first"),
      });
    }

    const linkedSession = await this.host.sessionStore.getSession(
      session.linkedSessionId,
    );

    return buildPartnerMenuText({
      title: this.host.t(locale, "menu:partner.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:partner.screen.active_session", {
        sessionName: session.label ?? activeSessionId,
      }),
      linkedPartnerLine: this.host.t(locale, "menu:partner.screen.linked_partner", {
        partnerName: linkedSession?.label ?? session.linkedSessionId,
      }),
      promptHintLine: this.host.t(locale, "menu:partner.screen.prompt_hint"),
      promptFormatLine: this.host.t(locale, "menu:partner.screen.prompt_format"),
    });
  }

  public async showLocalMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.host.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildLocalMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getLocalMenu(),
    );
  }

  public async buildLocalMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "menu:local.screen.unavailable");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "menu:local.screen.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);
    const linkedSession = session?.linkedSessionId
      ? await this.host.sessionStore.getSession(session.linkedSessionId)
      : null;

    return buildLocalMenuText({
      title: this.host.t(locale, "menu:main.buttons.local"),
      activeSessionLine: this.host.t(locale, "menu:local.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      linkStatusLine: linkedSession?.label
        ? this.host.t(locale, "menu:local.screen.link_status", {
            linkedSessionName: linkedSession.label,
          })
        : this.host.t(locale, "menu:local.screen.link_status_none"),
      hintTitleLine: this.host.t(locale, "menu:local.screen.hint_title"),
      hintBodyLine: this.host.t(locale, "menu:local.screen.hint_body"),
    });
  }

  public async showSettingsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildSettingsMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getSettingsMenu(),
    );
  }

  public async buildSettingsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return buildSettingsMenuText({
      title: this.host.t(locale, "menu:settings.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:settings.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      hintLine: this.host.t(locale, "menu:settings.screen.hint"),
    });
  }

  public async showBufferMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBufferMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getBufferMenu(),
    );
  }

  public async buildBufferMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return buildBufferMenuText({
      title: this.host.t(locale, "menu:buffer.screen.title"),
      activeSessionLine: this.host.t(locale, "menu:buffer.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      tmuxTargetLine: this.host.t(locale, "menu:buffer.screen.tmux_target", {
        tmuxTarget: session?.tmuxTarget ?? "not set",
      }),
      exportHintLine: this.host.t(locale, "menu:buffer.screen.export_hint"),
      exportModesLine: this.host.t(locale, "menu:buffer.screen.export_modes"),
    });
  }

  public async showDeveloperMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildDeveloperMenuText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getDeveloperMenu(),
    );
  }

  public async showDeveloperInfo(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const info = await this.collectDeveloperInfo(ctx);
    const headerText = introText
      ? `${renderMarkdownChunk("Gateway Info", introText)}\n\n${info.headerMarkdown}`
      : info.headerMarkdown;
    await this.host.renderMenuMarkdownScreen(
      ctx,
      headerText,
      { kind: "menu" },
      this.host.getDeveloperMenu(),
    );
    for (const clientMarkdown of info.clientMarkdownChunks) {
      await this.host.replyText(
        ctx,
        clientMarkdown,
        { kind: "menu" },
        { parse_mode: "MarkdownV2" },
      );
    }
  }

  public async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.host.t(locale, "menu:developer.screen.title"),
      "",
      this.host.t(locale, "menu:developer.screen.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.host.t(locale, "menu:developer.screen.broadcast_help"),
      this.host.t(locale, "menu:developer.screen.prune_help"),
    ].join("\n");
  }

  public async buildDeveloperInfoMarkdown(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const info = await this.collectDeveloperInfo(ctx);
    return info.headerMarkdown;
  }

  public async showUnpairConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildUnpairConfirmText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getUnpairConfirmMenu(),
    );
  }

  public async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.host.t(locale, "common:errors.no_active_session");
    }

    const session = await this.host.sessionStore.getSession(activeSessionId);

    return [
      this.host.t(locale, "menu:unpair.title"),
      "",
      this.host.t(locale, "menu:unpair.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      "",
      this.host.t(locale, "menu:unpair.body_1"),
      this.host.t(locale, "menu:unpair.body_2"),
    ].join("\n");
  }

  public async showPruneConfirmMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildPruneConfirmText(ctx);
    await this.host.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.host.getPruneConfirmMenu(),
    );
  }

  public async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.host.resolveLocaleForContext(ctx);
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.host.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.host.t(locale, "menu:prune.title"),
      "",
      this.host.t(locale, "menu:prune.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.host.t(locale, "menu:prune.body_1"),
      this.host.t(locale, "menu:prune.body_2"),
    ].join("\n");
  }
}
