import path from "node:path";
import { readFile } from "node:fs/promises";

import { Menu, MenuRange, type MenuFlavor } from "@grammyjs/menu";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import {
  buildLiveRelaySessionId,
  resolveGatewayWebAppBaseUrl,
} from "../../../app/webapp/relay";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  PartnerNoteKind,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types";
import type {
  SessionStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramMenuPayloadStore,
  TelegramXchangeFileMetaStore,
  MaintenanceStore,
} from "../../api/storage/contract";
import type {
  HumanTransportNotification,
  HumanTransport,
  HumanTransportReply,
  HumanTransportRequest,
} from "../../api/transport/contract";
import {
  createInboxMessageId,
  createMenuPayloadKey,
} from "../../lib/ids/ids";
import type { Logger } from "../../lib/logger/logger";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";
import {
  formatTelegramMessage,
  formatTelegramNotification,
} from "./messageFormat";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import { createTelegramFetch } from "./proxyFetch";
import {
  captureTmuxPaneRange,
  getTmuxWindowHeight,
  isTmuxUnavailableError,
  listXchangeFiles,
  readWorkspaceFile,
  sendTmuxLiteralLine,
  writeXchangeRelativeFile,
} from "../tmux/client";

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
type TelegramEditMessageOptions = NonNullable<
  Parameters<Bot<TelegramMenuContext>["api"]["editMessageText"]>[3]
>;

type TelegramClientFetch = NonNullable<
  NonNullable<NonNullable<ConstructorParameters<typeof Bot>[1]>["client"]>["fetch"]
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
  promptMessageId?: number;
  menuMessageId?: number;
};

type PendingPartnerNoteRecord = {
  sessionId: string;
  kind: PartnerNoteKind;
  initiatedAt: string;
  promptMessageId?: number;
  targetSessionId?: string;
  targetSessionLabel?: string;
  projectUuid?: string;
};

type PendingFileHandoffRecord = {
  sessionId: string;
  filePath: string;
  target: "agent" | "partner";
  initiatedAt: string;
  promptMessageId?: number;
  targetSessionId?: string;
  targetSessionLabel?: string;
  projectUuid?: string;
};

type CurrentAttachmentTargetRecord = {
  sessionId: string;
  targetSessionId: string;
  targetSessionLabel: string;
  projectUuid?: string;
};

type PendingProjectRecord = {
  sessionId: string;
  mode: "create" | "join";
  initiatedAt: string;
  promptMessageId?: number;
};

type GatewayProjectRecord = {
  project_uuid: string;
  name: string;
  invite_token: string;
  role: string;
  status: string;
  joined_at?: string;
};

type GatewayProjectSessionRecord = {
  session_uuid: string;
  project_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  client_label: string | null;
  telegram_username: string | null;
  bot_username: string | null;
  joined_at?: string;
  updated_at?: string;
};

type GatewayActorProfile = {
  telegramUsername?: string;
  telegramFirstName?: string;
  telegramLastName?: string;
  telegramDisplayName?: string;
};

type TmuxProxyStatusCacheEntry = {
  checkedAtMs: number;
  statusLine: string;
};

type TmuxCaptureScope =
  | { mode: "visible" }
  | { mode: "lines"; lines: number }
  | { mode: "full" };

type TelegramAttachmentDescriptor = {
  fileId: string;
  preferredName: string;
  mimeType?: string | undefined;
};

type StoredAttachmentRecord = {
  filePath: string;
  relativePath: string;
  storageRef?: string | undefined;
  bucketName?: string | undefined;
  objectName?: string | undefined;
  vfsNodeId?: number | undefined;
  vfsPublicUrl?: string | undefined;
  vfsParentId?: number | undefined;
  sizeBytes: number;
  mimeType?: string | undefined;
};

const LOCAL_INDEX_FILE_NAME = "LOCAL_INDEX.md";

const TMUX_PROXY_STATUS_CACHE_MS = 5000;

function isExecutorTargetKind(kind: PartnerNoteKind): boolean {
  return kind === "question" || kind === "request";
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeBasePath(value: string): string {
  const trimmed = trimTrailingSlashes(value.trim());
  return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed || ""}`;
}

function resolveWebAppPublicBaseUrl(config: AppConfig): string | null {
  if (!config.webapp.publicUrl) {
    return null;
  }

  const rootPrefix = normalizeBasePath(process.env.ROOT_PREFIX || "/api");
  const webAppBasePath = normalizeBasePath(config.webapp.basePath || "/webapp");
  const expectedPath = trimTrailingSlashes(
    `${rootPrefix === "/" ? "" : rootPrefix}${webAppBasePath}`,
  ) || "/";

  const url = new URL(config.webapp.publicUrl);
  const currentPath = normalizeBasePath(url.pathname || "/");

  if (currentPath === expectedPath) {
    return trimTrailingSlashes(url.toString());
  }

  if (currentPath === webAppBasePath) {
    url.pathname = expectedPath;
    return trimTrailingSlashes(url.toString());
  }

  if (currentPath.endsWith(webAppBasePath)) {
    url.pathname = expectedPath;
    return trimTrailingSlashes(url.toString());
  }

  url.pathname = expectedPath;
  return trimTrailingSlashes(url.toString());
}

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

function buildDatedRelativePath(fileName: string, date = new Date()): string {
  const dateSegment = date.toISOString().slice(0, 10);
  const timeSegment = date.toTimeString().slice(0, 8).replace(/:/gu, "-");
  return `${dateSegment}/${timeSegment}/${fileName}`;
}

function buildPrincipalKey(principal: {
  telegramChatId: number;
  telegramUserId: number;
}): string {
  return `${principal.telegramChatId}:${principal.telegramUserId}`;
}

function formatTmuxBridgeError(
  config: AppConfig,
  error: unknown,
  fallback: string,
): string {
  if (isTmuxUnavailableError(error)) {
    return config.tmux.proxyUrl
      ? "TMUX bridge is unavailable right now."
      : "tmux is unavailable right now."
  }

  if (config.tmux.proxyUrl && error instanceof Error) {
    return `TMUX bridge error: ${error.message}`;
  }

  return fallback;
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

function buildLocalHandoffId(fileName: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${timestamp}-${slugifyFilenamePart(fileName) || "file-handoff"}`;
}

function buildLocalIndexLine(input: {
  createdAt: string;
  summary: string;
  relativeNotePath: string;
}): string {
  return [
    "-",
    `[${input.createdAt}]`,
    `local-handoff |`,
    `${input.summary}`,
    `| \`${input.relativeNotePath}\``,
  ].join(" ");
}

function buildLocalNoteContent(input: {
  handoffId: string;
  createdAt: string;
  sessionId: string;
  sessionLabel?: string | undefined;
  filePath: string;
  description: string;
}): string {
  return [
    "---",
    `handoff_id: ${JSON.stringify(input.handoffId)}`,
    `kind: "local-file"`,
    `created_at: ${JSON.stringify(input.createdAt)}`,
    `session_id: ${JSON.stringify(input.sessionId)}`,
    `session_label: ${JSON.stringify(input.sessionLabel ?? input.sessionId)}`,
    `artifacts:\n  - ${JSON.stringify(input.filePath)}`,
    "---",
    "",
    "# Summary",
    `Local file handoff: ${path.basename(input.filePath)}`,
    "",
    "# Message",
    input.description.trim(),
    "",
    "# Artifacts",
    `- ${input.filePath}`,
    "",
  ].join("\n");
}

export class TelegramTransport implements HumanTransport {
  private readonly telegramFetch: TelegramClientFetch;
  private readonly bot: Bot<TelegramMenuContext>;
  private readonly mainMenu: Menu<TelegramMenuContext>;
  private readonly inboxMenu: Menu<TelegramMenuContext>;
  private readonly browserMenu: Menu<TelegramMenuContext>;
  private readonly projectsMenu: Menu<TelegramMenuContext>;
  private readonly localMenu: Menu<TelegramMenuContext>;
  private readonly screenshotsMenu: Menu<TelegramMenuContext>;
  private readonly linkMenu: Menu<TelegramMenuContext>;
  private readonly partnerMenu: Menu<TelegramMenuContext>;
  private readonly sessionsMenu: Menu<TelegramMenuContext>;
  private readonly bufferMenu: Menu<TelegramMenuContext>;
  private readonly settingsMenu: Menu<TelegramMenuContext>;
  private readonly developerMenu: Menu<TelegramMenuContext>;
  private readonly unpairConfirmMenu: Menu<TelegramMenuContext>;
  private readonly pruneConfirmMenu: Menu<TelegramMenuContext>;
  private readonly inboxMessageMenu: Menu<TelegramMenuContext>;
  private readonly screenshotMessageMenu: Menu<TelegramMenuContext>;
  private readonly waiters = new Map<string, WaiterRecord>();
  private readonly tmuxNudgeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingRenames = new Map<string, PendingRenameRecord>();
  private readonly pendingBroadcasts = new Map<string, PendingBroadcastRecord>();
  private readonly pendingPartnerNotes = new Map<string, PendingPartnerNoteRecord>();
  private readonly pendingFileHandoffs = new Map<string, PendingFileHandoffRecord>();
  private readonly pendingProjects = new Map<string, PendingProjectRecord>();
  private readonly currentAttachmentTargets = new Map<
    string,
    CurrentAttachmentTargetRecord
  >();
  private tmuxProxyStatusCache?: TmuxProxyStatusCacheEntry;
  private started = false;
  private pollingTask: Promise<void> | undefined;
  private collaborationService?: CollaborationService;

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
    private readonly xchangeFileMetaStore: TelegramXchangeFileMetaStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly objectStore: MinioExchangeStore,
    private readonly webAppLaunchRegistry: WebAppLaunchRegistry,
    private readonly logger: Logger,
  ) {
    this.telegramFetch = createTelegramFetch(
      this.config,
      this.logger,
    ) as unknown as TelegramClientFetch;

    this.bot = new Bot<TelegramMenuContext>(this.config.telegram.botToken, {
      client: {
        fetch: this.telegramFetch,
      },
    });
    this.mainMenu = this.createMainMenu();
    this.inboxMenu = this.createInboxMenu();
    this.browserMenu = this.createBrowserMenu();
    this.projectsMenu = this.createProjectsMenu();
    this.localMenu = this.createLocalMenu();
    this.screenshotsMenu = this.createScreenshotsMenu();
    this.linkMenu = this.createLinkMenu();
    this.partnerMenu = this.createPartnerMenu();
    this.sessionsMenu = this.createSessionsMenu();
    this.bufferMenu = this.createBufferMenu();
    this.settingsMenu = this.createSettingsMenu();
    this.developerMenu = this.createDeveloperMenu();
    this.unpairConfirmMenu = this.createUnpairConfirmMenu();
    this.pruneConfirmMenu = this.createPruneConfirmMenu();
    this.inboxMessageMenu = this.createInboxMessageMenu();
    this.screenshotMessageMenu = this.createScreenshotMessageMenu();
    this.mainMenu.register([
      this.inboxMenu,
      this.browserMenu,
      this.projectsMenu,
      this.localMenu,
      this.screenshotsMenu,
      this.linkMenu,
      this.partnerMenu,
      this.sessionsMenu,
      this.bufferMenu,
      this.settingsMenu,
      this.developerMenu,
      this.unpairConfirmMenu,
      this.pruneConfirmMenu,
      this.inboxMessageMenu,
      this.screenshotMessageMenu,
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
    this.bot.callbackQuery("broadcast-cancel", async (ctx) => {
      await this.cancelPendingBroadcast(ctx);
    });
    this.bot.callbackQuery("partner-note-cancel", async (ctx) => {
      await this.cancelPendingPartnerNote(ctx);
    });
    this.bot.callbackQuery("partner-back", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Назад к напарнику." });
      await this.showPartnerMenu(ctx);
    });
    this.bot.callbackQuery("file-handoff-cancel", async (ctx) => {
      await this.cancelPendingFileHandoff(ctx);
    });
    this.bot.callbackQuery(/^project-set:(.+)$/u, async (ctx) => {
      await this.handleProjectSetCallback(ctx);
    });
    this.bot.callbackQuery(/^project-members:(.+)$/u, async (ctx) => {
      await this.handleProjectMembersCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-open:(.+)$/u, async (ctx) => {
      await this.handleProjectMemberOpenCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-note:(question|reply|handoff|share):(.+)$/u, async (ctx) => {
      await this.handleProjectMemberNoteCallback(ctx);
    });
    this.bot.callbackQuery(/^project-detail:(.+)$/u, async (ctx) => {
      await this.handleProjectDetailCallback(ctx);
    });
    this.bot.callbackQuery(/^project-leave:(.+)$/u, async (ctx) => {
      await this.handleProjectLeaveCallback(ctx);
    });
    this.bot.callbackQuery("project-back", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Back to projects." });
      await this.showProjectsMenu(ctx);
    });
    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
  }

  public setCollaborationService(service: CollaborationService): void {
    this.collaborationService = service;
  }

  private async sendPartnerNote(
    input: SendPartnerNoteInput,
  ): Promise<SendPartnerNoteOutput> {
    if (this.collaborationService) {
      return this.collaborationService.sendPartnerNote(input);
    }

    if (!this.config.distributed.gatewayPublicUrl) {
      throw new Error("Partner collaboration service is not configured.");
    }

    const url = normalizeGatewayBaseUrl(this.config.distributed.gatewayPublicUrl);
    url.pathname = `${url.pathname}/partner-note`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distributed.gatewayAuthToken
          ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Gateway collaboration request failed with status ${response.status}: ${text || response.statusText}`,
      );
    }

    return (await response.json()) as SendPartnerNoteOutput;
  }

  private async callGatewayJson<T>(
    endpointPath: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    if (!this.config.distributed.gatewayPublicUrl) {
      throw new Error("Gateway is not configured.");
    }

    const url = new URL(this.config.distributed.gatewayPublicUrl);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    if (!url.pathname.endsWith("/gateway")) {
      url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
    }
    url.pathname = `${url.pathname}${endpointPath}`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distributed.gatewayAuthToken
          ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || response.statusText);
    }

    return (await response.json()) as T;
  }

  private async ensureGatewayClientUuid(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<string> {
    const existing = await this.maintenanceStore.getGatewayClientUuid();
    if (existing && !actor) {
      return existing;
    }

    const response = await this.callGatewayJson<{
      client_uuid: string;
    }>("/client/register", {
      ...(existing ? { client_uuid: existing } : {}),
      client_label:
        this.config.project.name ||
        this.config.telegram.botUsername ||
        "telegram-mcp client",
      bot_username: this.config.telegram.botUsername,
      meta: {
        telegram_chat_id: principal.telegramChatId,
        telegram_user_id: principal.telegramUserId,
        ...(actor?.telegramUsername
          ? { telegram_username: actor.telegramUsername }
          : {}),
        ...(actor?.telegramFirstName
          ? { telegram_first_name: actor.telegramFirstName }
          : {}),
        ...(actor?.telegramLastName
          ? { telegram_last_name: actor.telegramLastName }
          : {}),
        ...(actor?.telegramDisplayName
          ? { telegram_display_name: actor.telegramDisplayName }
          : {}),
      },
    });

    await this.maintenanceStore.setGatewayClientUuid(response.client_uuid);
    return response.client_uuid;
  }

  private async listGatewayProjects(
    principal: { telegramChatId: number; telegramUserId: number },
    actor?: GatewayActorProfile,
  ): Promise<GatewayProjectRecord[]> {
    const clientUuid = await this.ensureGatewayClientUuid(principal, actor);
    const response = await this.callGatewayJson<{
      projects: GatewayProjectRecord[];
    }>("/projects/list", {
      client_uuid: clientUuid,
    });
    return response.projects;
  }

  private async listGatewayProjectSessions(
    principal: { telegramChatId: number; telegramUserId: number },
    projectUuid: string,
  ): Promise<GatewayProjectSessionRecord[]> {
    const clientUuid = await this.ensureGatewayClientUuid(principal);
    const response = await this.callGatewayJson<{
      sessions: GatewayProjectSessionRecord[];
    }>("/projects/sessions", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });
    return response.sessions;
  }

  private async ensureProjectSessionRegistered(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error("Active session not found.");
    }

    const clientUuid = await this.ensureGatewayClientUuid(input.principal);
    await this.callGatewayJson("/sessions/register", {
      client_uuid: clientUuid,
      project_uuid: input.projectUuid,
      local_session_id: session.sessionId,
      label: session.label ?? session.sessionId,
      cwd: session.cwd,
      tmux_session_name: session.tmuxSessionName,
      tmux_window_name: session.tmuxWindowName,
      tmux_window_index: session.tmuxWindowIndex,
      tmux_pane_id: session.tmuxPaneId,
      tmux_pane_index: session.tmuxPaneIndex,
      tmux_target: session.tmuxTarget,
      status: "active",
    });
  }

  private async loadProjectsContext(
    ctx: TelegramMenuContext,
  ): Promise<{
    principal: { telegramChatId: number; telegramUserId: number } | null;
    session: Awaited<ReturnType<SessionStore["getSession"]>> | null;
    projects: GatewayProjectRecord[] | null;
  }> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal || !this.config.distributed.gatewayPublicUrl) {
      return { principal, session: null, projects: null };
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return { principal, session: null, projects: null };
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    if (!session) {
      return { principal, session: null, projects: null };
    }

    const projects = await this.listGatewayProjects(
      principal,
      this.getGatewayActorFromContext(ctx),
    );
    return { principal, session, projects };
  }

  private async activateProjectForSession(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error("Active session not found.");
    }

    await this.ensureProjectSessionRegistered({
      principal: input.principal,
      sessionId: input.sessionId,
      projectUuid: input.projectUuid,
    });

    await this.sessionStore.setSession({
      ...session,
      activeProjectUuid: input.projectUuid,
      activeProjectName: input.projectName,
      updatedAt: new Date().toISOString(),
    });
  }

  private async ensureOpenedProjectIsActive(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    projectUuid: string;
    projectName: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.sessionId);
    if (
      session?.activeProjectUuid === input.projectUuid &&
      session.activeProjectName === input.projectName
    ) {
      return;
    }

    await this.activateProjectForSession(input);
  }

  private async buildProjectsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const { session, projects } = await this.loadProjectsContext(ctx);
    return `${session?.sessionId ?? "none"}:${session?.activeProjectUuid ?? "none"}:${projects?.map((item) => item.project_uuid).join(",") ?? "none"}`;
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

  public async deleteMessage(
    telegramChatId: number,
    telegramMessageId: number,
  ): Promise<void> {
    await this.bot.api.deleteMessage(telegramChatId, telegramMessageId);
  }

  public async sendDocumentToChat(
    telegramChatId: number,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number }> {
    const fileBuffer = await readFile(filePath);
    const response = await this.bot.api.sendDocument(
      telegramChatId,
      new InputFile(fileBuffer, path.basename(filePath)),
      caption?.trim()
        ? {
            caption: caption.trim(),
          }
        : {},
    );

    return {
      messageId: response.message_id,
    };
  }

  public async editChatMessage(
    telegramChatId: number,
    telegramMessageId: number,
    text: string,
    options: TelegramEditMessageOptions = {},
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.bot.api.editMessageText(
          telegramChatId,
          telegramMessageId,
          text,
          options,
        );
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
              "Telegram rate limit hit while editing chat message, cooling down",
              {
                telegramChatId,
                telegramMessageId,
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

  public async handleProjectMemberJoinedEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    const memberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : "Новый участник");

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: `В проект «${input.project_name}» вошёл участник: ${memberLabel}.`,
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectMemberLeftEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    const memberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : "Участник");

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: `Из проекта «${input.project_name}» вышел участник: ${memberLabel}.`,
      });
      notifiedChats.add(binding.telegramChatId);
    }
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

  public async nudgeSessionInbox(sessionId: string): Promise<void> {
    await this.nudgeTmuxForInboxMessage(sessionId);
  }

  public async nudgeSessionPartnerNote(sessionId: string): Promise<void> {
    await this.nudgeTmuxForSession(sessionId, {
      message: this.config.tmux.partnerNudgeMessage,
      reason: "partner_note",
      requireInboxMessage: false,
    });
  }

  private async replyText(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & {
      kind: "pairing" | "menu" | "inbox" | "transport";
    },
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
      .text("📄 Content", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Opening content menu." });
        await this.showBufferMenu(ctx);
      })
      .text("🌐 Browser", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Opening browser menu." });
        await this.showBrowserMenu(ctx);
      })
      .row()
      .text("🏠 Local", async (ctx) => {
        await this.showLocalEntryPoint(ctx);
      })
      .text("👥 Collab", async (ctx) => {
        await this.showProjectsEntryPoint(ctx);
      })
      .row()
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
      .text("⚙ Settings", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Открываю настройки." });
        await this.showSettingsMenu(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to sessions." });
        await this.showSessionsMenu(ctx);
      });
  }

  private createBrowserMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-browser-menu",
      this.createMenuOptions((ctx) => this.showBrowserMenu(ctx)),
    )
      .text(
        async (ctx) => this.buildScreenshotsButtonLabel(ctx),
        async (ctx) => {
          await ctx.answerCallbackQuery({ text: "Opening screenshots." });
          await this.showScreenshotsMenu(ctx);
        },
      )
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createProjectsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-projects-menu",
      {
        fingerprint: async (ctx) => this.buildProjectsFingerprint(ctx),
        ...this.createMenuOptions((ctx) => this.showProjectsMenu(ctx)),
      },
    )
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const { session, projects } = await this.loadProjectsContext(ctx);
        if (!session || !projects) {
          range.text("Gateway недоступен", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "Проекты доступны только через gateway.",
              show_alert: true,
            });
          });
          return range;
        }

        if (projects.length === 0) {
          range
            .text("🫥 Нет проектов", async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: "Проектов пока нет. Создай или войди в существующий.",
              });
            })
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
                  this.createProjectMenuPayload(
                    session.sessionId,
                    project.project_uuid,
                    project.name,
                  ),
              },
              async (innerCtx) => {
                await this.handleProjectSelect(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text("➕ Создать", async (ctx) => {
        await this.beginProjectMode(ctx, "create");
      })
      .text("🔑 Войти", async (ctx) => {
        await this.beginProjectMode(ctx, "join");
      })
      .text("⬅ Назад", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Назад к меню сессии." });
        await this.showMainMenu(ctx);
      });
  }

  private createLocalMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-local-menu",
      this.createMenuOptions((ctx) => this.showLocalMenu(ctx)),
    )
      .text("🤝 Напарник", async (ctx) => {
        await this.showPartnerEntryPoint(ctx);
      })
      .text(
        async (ctx) => this.buildLinkButtonLabel(ctx),
        async (ctx) => {
          await this.handleLinkButton(ctx);
        },
      )
      .row()
      .text("⬅ Назад", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Назад к меню сессии." });
        await this.showMainMenu(ctx);
      });
  }

  private createLinkMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-link-menu", {
      fingerprint: async (ctx) => this.buildLinkFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showLinkMenu(ctx)),
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
        if (!activeSessionId) {
          range.text("No active session", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No active session is linked yet.",
              show_alert: true,
            });
          });
          return range;
        }

        const sessionIds = (
          await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
        )
          .filter((sessionId) => sessionId !== activeSessionId)
          .sort();

        if (sessionIds.length === 0) {
          range.text("🫥 No partner sessions", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No other linked sessions are available.",
              show_alert: true,
            });
          });
          return range;
        }

        for (const sessionId of sessionIds) {
          const session = await this.sessionStore.getSession(sessionId);
          range
            .text(
              {
                text: `🔗 ${session?.label ?? sessionId}`,
                payload: async () =>
                  this.createLinkMenuPayload(activeSessionId, sessionId),
              },
              async (innerCtx) => {
                await this.handleLinkTargetSelect(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createPartnerMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-partner-menu",
      this.createMenuOptions((ctx) => this.showPartnerMenu(ctx)),
    )
      .text("❓ Ask", async (ctx) => {
        await this.beginPartnerNoteMode(ctx, "question");
      })
      .text("📤 Share", async (ctx) => {
        await this.beginPartnerNoteMode(ctx, "share");
      })
      .row()
      .text("🔓 Unlink", async (ctx) => {
        await this.handleLinkButton(ctx);
      })
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
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
      .text("🧾 Full", async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, { mode: "full" });
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
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to session menu." });
        await this.showMainMenu(ctx);
      });
  }

  private createSettingsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-settings-menu",
      this.createMenuOptions((ctx) => this.showSettingsMenu(ctx)),
    )
      .text("ℹ Info", async (ctx) => {
        await this.showActiveSessionInfo(ctx);
      })
      .row()
      .text("✏ Rename", async (ctx) => {
        await this.beginRenameActiveSession(ctx);
      })
      .row()
      .text("🗑 Unpair", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Confirm unpair." });
        await this.showUnpairConfirmMenu(ctx);
      })
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Назад к меню сессии." });
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
        await ctx.answerCallbackQuery({ text: "Back to settings." });
        await this.showSettingsMenu(ctx);
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

  private createScreenshotsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-screenshots-menu", {
      fingerprint: async (ctx) => this.buildScreenshotsFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showScreenshotsMenu(ctx)),
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

        const filePaths = await this.listActiveSessionScreenshots(sessionId);
        if (filePaths.length === 0) {
          range.text("📭 No screenshots", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "No screenshots are stored for this session.",
            });
          });
          return range;
        }

        for (const filePath of filePaths) {
          range
            .text(
              {
                text: this.formatFilePreviewLabel(filePath),
                payload: async () =>
                  this.createFileMenuPayload(sessionId, filePath),
              },
              async (innerCtx) => {
                await this.handleScreenshotOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text("🔄 Refresh", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Screenshots refreshed." });
        await this.showScreenshotsMenu(ctx);
      })
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to browser menu." });
        await this.showBrowserMenu(ctx);
      });
  }

  private createSessionsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-sessions-menu", {
      fingerprint: async (ctx) => this.buildSessionsFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showSessionsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        try {
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

          for (const sessionId of sessionIds) {
            const session = await this.sessionStore.getSession(sessionId);
            const linkedSession = session?.linkedSessionId
              ? await this.sessionStore.getSession(session.linkedSessionId)
              : null;
            const inboxCount = await this.inboxStore.countInboxMessages(sessionId);

            range.text(
              {
                text: this.formatSessionMenuLabel({
                  sessionId,
                  active: sessionId === activeSessionId,
                  inboxCount,
                  ...(session?.label ? { sessionLabel: session.label } : {}),
                  ...(linkedSession?.label
                    ? { linkedSessionLabel: linkedSession.label }
                    : session?.linkedSessionId
                      ? { linkedSessionLabel: session.linkedSessionId }
                      : {}),
                }),
                payload: async () => this.createSessionMenuPayload(sessionId),
              },
              async (innerCtx) => {
                await this.handleSessionSelection(innerCtx);
              },
            );

            range.row();
          }

          return range;
        } catch (error) {
          this.logger.error("Failed to build Telegram sessions menu", {
            chatId: ctx.chat?.id,
            userId: ctx.from?.id,
            error:
              error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
          range.text("⚠ Sessions unavailable", async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: "Sessions menu is temporarily unavailable.",
              show_alert: true,
            });
          });
          return range;
        }
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

  private createScreenshotMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-screenshot-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.createMenuOptions((ctx) => this.showScreenshotsMenu(ctx)),
    })
      .text(
        {
          text: "📥 Получить",
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleScreenshotGet(ctx);
        },
      )
      .text(
        {
          text: "🗑 Delete",
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleScreenshotDelete(ctx);
        },
      )
      .row()
      .text("⬅ Back", async (ctx) => {
        await ctx.answerCallbackQuery({ text: "Back to screenshots." });
        await this.showScreenshotsMenu(ctx);
      });
  }

  private async handleMessage(ctx: TelegramMenuContext): Promise<void> {
    const text = this.extractIncomingText(ctx.message);
    const attachments = this.collectIncomingAttachments(ctx.message);
    if (!text && attachments.length === 0) {
      return;
    }

    this.logger.info("Telegram message received", {
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
      ...(text ? { text: redactSecrets(text) } : {}),
      attachmentCount: attachments.length,
      activeWaiters: this.waiters.size,
    });

    if (text && (await this.handlePendingRename(ctx, text))) {
      return;
    }

    if (text && (await this.handlePendingBroadcast(ctx, text))) {
      return;
    }

    if (text && (await this.handlePendingPartnerNote(ctx, text))) {
      return;
    }

    if (text && (await this.handlePendingFileHandoff(ctx, text))) {
      return;
    }

    if (text && (await this.handlePendingProject(ctx, text))) {
      return;
    }

    if (text && isMenuEntryCommand(text)) {
      this.clearPendingInteractionsForContext(ctx);
      await this.showSessionsMenu(ctx);
      return;
    }

    if (text && isHelpCommand(text)) {
      this.clearPendingInteractionsForContext(ctx);
      await this.showHelp(ctx);
      return;
    }

    const pairingCode = text ? parsePairingCode(text) : null;
    if (pairingCode) {
      this.logger.debug("Telegram message identified as pairing command", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        messageId: ctx.message?.message_id,
      });
      await this.handlePairingCommand(ctx, pairingCode);
      return;
    }

    const replyMatched = text ? await this.handleReply(ctx) : false;
    if (replyMatched) {
      return;
    }

    if (attachments.length > 0) {
      await this.handleAttachmentUpload(ctx, attachments);
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
      ...(ctx.from?.username ? { telegramUsername: ctx.from.username } : {}),
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
      ...(existingSession?.cwd ? { cwd: existingSession.cwd } : {}),
      ...(existingSession?.linkedSessionId
        ? { linkedSessionId: existingSession.linkedSessionId }
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
    const text = this.extractIncomingText(message);
    const attachmentDescriptors = this.collectIncomingAttachments(message);

    if (
      !message ||
      (!text && attachmentDescriptors.length === 0) ||
      !fromUserId ||
      !chatId
    ) {
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

    const session = await this.sessionStore.getSession(sessionId);
    let attachments: StoredAttachmentRecord[] = [];
    try {
      attachments = await this.downloadIncomingAttachments(
        session,
        sessionId,
        message.message_id,
        attachmentDescriptors,
      );
    } catch (error) {
      this.logger.error("Telegram attachment upload failed", {
        sessionId,
        chatId,
        userId: fromUserId,
        messageId: message.message_id,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      await this.replyText(
        ctx,
        error instanceof Error
          ? `Could not save uploaded file: ${error.message}`
          : "Could not save uploaded file.",
        { kind: "transport", sessionId },
        { reply_markup: this.mainMenu },
      );
      return;
    }
    const normalizedText = this.buildInboxText(
      text,
      attachments.map((attachment) => attachment.filePath),
    );

    await this.storeTelegramUploadMetas({
      sessionId,
      sourceTelegramMessageId: message.message_id,
      uploadedAt: new Date(message.date * 1000).toISOString(),
      attachments,
      descriptors: attachmentDescriptors,
    });

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId,
      telegramChatId: chatId,
      telegramUserId: fromUserId,
      sourceTelegramMessageId: message.message_id,
      text: normalizedText,
      ...(attachments.length > 0
        ? { attachments: attachments.map((attachment) => attachment.filePath) }
        : {}),
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
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => attachment.filePath),
    });

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
        ? attachments.length > 0
          ? `Saved to inbox for session: ${session.label}. Files downloaded: ${attachments.length}`
          : `Saved to inbox for session: ${session.label}`
        : attachments.length > 0
          ? `Saved to inbox for session: ${sessionId}. Files downloaded: ${attachments.length}`
          : `Saved to inbox for session: ${sessionId}`,
      {
        kind: "inbox",
        sessionId,
      },
      { reply_markup: this.mainMenu },
    );
  }

  private async handleAttachmentUpload(
    ctx: TelegramMenuContext,
    attachmentDescriptors: TelegramAttachmentDescriptor[],
  ): Promise<void> {
    const message = ctx.message;
    const fromUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!message || !fromUserId || !chatId || attachmentDescriptors.length === 0) {
      return;
    }

    const principal = {
      telegramChatId: chatId,
      telegramUserId: fromUserId,
    };
    const principalKey = buildPrincipalKey(principal);
    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await this.replyText(
        ctx,
        "No active session is linked yet. Use a pairing code first, then open the menu.",
        { kind: "transport" },
      );
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    const caption = this.extractIncomingText(message);
    const attachments = await this.downloadIncomingAttachments(
      session,
      sessionId,
      message.message_id,
      attachmentDescriptors,
    );

    const currentTarget = this.currentAttachmentTargets.get(principalKey);
    if (currentTarget && currentTarget.sessionId === sessionId) {
      await this.storeTelegramUploadMetas({
        sessionId,
        sourceTelegramMessageId: message.message_id,
        uploadedAt: new Date(message.date * 1000).toISOString(),
        attachments,
        descriptors: attachmentDescriptors,
        caption: caption || undefined,
      });

      for (const attachment of attachments) {
        await this.deliverFileToPartner({
          sessionId,
          filePath: attachment.filePath,
          description: (caption || "").trim() || path.basename(attachment.filePath),
          targetSessionId: currentTarget.targetSessionId,
          ...(currentTarget.projectUuid
            ? { projectUuid: currentTarget.projectUuid }
            : {}),
        });
      }

      await this.replyText(
        ctx,
        currentTarget.projectUuid
          ? `Файл отправлен в сессию ${currentTarget.targetSessionLabel}.`
          : `Файл отправлен напарнику ${currentTarget.targetSessionLabel}.`,
        {
          kind: "inbox",
          sessionId,
        },
        { reply_markup: this.mainMenu },
      );
      return;
    }

    await this.storeTelegramUploadMetas({
      sessionId,
      sourceTelegramMessageId: message.message_id,
      uploadedAt: new Date(message.date * 1000).toISOString(),
      attachments,
      descriptors: attachmentDescriptors,
      caption: caption || undefined,
    });

    this.logger.info("Telegram files uploaded for session", {
      sessionId,
      chatId,
      userId: fromUserId,
      messageId: message.message_id,
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => attachment.filePath),
    });

    await this.replyText(
      ctx,
      session?.label
        ? attachments.length === 1
          ? `Файл доставлен в сессию ${session.label}.`
          : `Файлы доставлены в сессию ${session.label}: ${attachments.length}.`
        : attachments.length === 1
          ? `Файл доставлен в сессию ${sessionId}.`
          : `Файлы доставлены в сессию ${sessionId}: ${attachments.length}.`,
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
    await this.nudgeTmuxForSession(sessionId, {
      message: this.config.tmux.nudgeMessage,
      reason: "inbox_message",
      requireInboxMessage: true,
    });
  }

  private async nudgeTmuxForSession(
    sessionId: string,
    input: {
      message: string;
      reason: "inbox_message" | "partner_note";
      requireInboxMessage: boolean;
    },
  ): Promise<void> {
    if (!this.config.tmux.nudgeEnabled) {
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);

    if (!session?.tmuxTarget) {
      this.logger.debug("tmux nudge skipped", {
        sessionId,
        nudgeReason: input.reason,
        skipReason: "no_tmux_target",
      });
      return;
    }

    const inboxCount = await this.inboxStore.countInboxMessages(sessionId);
    if (input.requireInboxMessage && inboxCount === 0) {
      this.logger.debug("tmux nudge skipped because inbox is empty", {
        sessionId,
        reason: input.reason,
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
        reason: input.reason,
        tmuxTarget: session.tmuxTarget,
        inboxCount,
        lastTmuxNudgeAt: session.lastTmuxNudgeAt,
      });
      return;
    }

    await this.sendTypingForSession(sessionId);
    await sendTmuxLiteralLine(
      this.config.tmux,
      session.tmuxTarget,
      input.message,
    );

    const lastTmuxNudgeAt = new Date(nowMs).toISOString();
    await this.sessionStore.setSession({
      ...session,
      lastTmuxNudgeAt,
    });

    this.logger.info("tmux nudge sent", {
      sessionId,
      reason: input.reason,
      message: input.message,
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
    this.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
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
    const sessionName = escapeHtml(session?.label ?? activeSessionId);
    const projectName = session?.activeProjectName
      ? escapeHtml(session.activeProjectName)
      : null;
    const linkedSession = session?.linkedSessionId
      ? await this.sessionStore.getSession(session.linkedSessionId)
      : null;
    return [
      `🎛 Session: ${sessionName}`,
      "",
      `📥 Inbox messages: ${inboxCount}`,
      ...(projectName ? [`📦 Project: <b>${projectName}</b>`] : []),
      ...(session?.linkedSessionId
        ? [
            `🤝 Partner: <b><i>${escapeHtml(
              linkedSession?.label ?? session.linkedSessionId,
            )}</i></b>`,
            "",
            "Share API details, what's new, errors, and git changes with your teammate.",
          ]
        : ["", "🔗 Link a partner session to coordinate through shared notes and files."]),
    ].join("\n");
  }

  private async getTmuxProxyStatusLine(): Promise<string> {
    if (!this.config.tmux.proxyUrl) {
      return "🖧 TMUX mode: direct";
    }

    const now = Date.now();
    if (
      this.tmuxProxyStatusCache &&
      now - this.tmuxProxyStatusCache.checkedAtMs < TMUX_PROXY_STATUS_CACHE_MS
    ) {
      return this.tmuxProxyStatusCache.statusLine;
    }

    let statusLine = "🖧 TMUX bridge error: unknown";
    try {
      const url = new URL(
        "/healthz",
        this.config.tmux.proxyUrl.endsWith("/")
          ? this.config.tmux.proxyUrl
          : `${this.config.tmux.proxyUrl}/`,
      );
      const response = await fetch(url);
      if (response.ok) {
        statusLine = "🟢 TMUX bridge running";
      } else {
        statusLine = `🔴 TMUX bridge error: HTTP ${response.status}`;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      statusLine = `🔴 TMUX bridge error: ${message}`;
    }

    this.tmuxProxyStatusCache = {
      checkedAtMs: now,
      statusLine,
    };

    return statusLine;
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
    const session = await this.sessionStore.getSession(sessionId);
    return `${sessionId}:${count}:${session?.linkedSessionId ?? "none"}`;
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

  private async buildScreenshotsFingerprint(
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

    const files = await this.listActiveSessionScreenshots(sessionId);
    return `${sessionId}:${files.join(",")}`;
  }

  private async buildSessionsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    try {
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
    } catch (error) {
      this.logger.warn("Failed to build Telegram sessions menu fingerprint", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return "sessions-error";
    }
  }

  private async buildLinkFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "no-principal";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return "no-active-session";
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const sessionIds = (
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
    )
      .filter((sessionId) => sessionId !== activeSessionId)
      .sort();

    return `${activeSessionId}:${session?.linkedSessionId ?? "none"}:${sessionIds.join(",")}`;
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

  private async buildScreenshotsButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "📸 Screenshots";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "📸 Screenshots";
    }

    const count = (await this.listActiveSessionScreenshots(sessionId)).length;
    return count > 0 ? `📸 Screenshots (${count})` : "📸 Screenshots";
  }

  private async buildLinkButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "🔗 Связать";
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return "🔗 Связать";
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      return "🔗 Связать";
    }

    const linkedSession = await this.sessionStore.getSession(
      session.linkedSessionId,
    );
    return linkedSession?.label
      ? `🔓 Разорвать ${linkedSession.label}`
      : "🔓 Разорвать";
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

  private async createFileMenuPayload(
    sessionId: string,
    filePath: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "file-entry",
        sessionId,
        filePath,
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

  private async createLinkMenuPayload(
    sessionId: string,
    targetSessionId: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "link-target",
        sessionId,
        targetSessionId,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async createProjectMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "project-entry",
        sessionId,
        projectUuid,
        title,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async createProjectMemberMenuPayload(
    sessionId: string,
    projectUuid: string,
    targetSessionId: string,
    title: string,
    options?: {
      filePath?: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: options?.filePath ? "project-file-target" : "project-member",
        sessionId,
        projectUuid,
        targetSessionId,
        title,
        ...(options?.filePath ? { filePath: options.filePath } : {}),
        ...(options?.targetClientUuid
          ? { targetClientUuid: options.targetClientUuid }
          : {}),
        ...(options?.targetLocalSessionId
          ? { targetLocalSessionId: options.targetLocalSessionId }
          : {}),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async createPartnerFileTargetPayload(
    sessionId: string,
    targetSessionId: string,
    title: string,
    filePath: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "partner-file-target",
        sessionId,
        targetSessionId,
        title,
        filePath,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async listActiveSessionFiles(sessionId: string): Promise<string[]> {
    const metas = await this.xchangeFileMetaStore.listXchangeFileMetas(sessionId);
    if (metas.length > 0) {
      return metas
        .filter((meta) => meta.source === "telegram-upload")
        .map((meta) => meta.filePath);
    }

    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim() || "";
    if (this.config.tmux.proxyUrl && !workspaceDir) {
      return [];
    }

    const resolvedWorkspaceDir = workspaceDir || process.cwd();
    const files = await listXchangeFiles(
      this.config.tmux,
      resolvedWorkspaceDir,
      this.config.exchange.dir,
    );
    return files.sort((left, right) => right.localeCompare(left));
  }

  private async listActiveSessionScreenshots(
    sessionId: string,
  ): Promise<string[]> {
    const metas = await this.xchangeFileMetaStore.listXchangeFileMetas(sessionId);
    if (metas.length > 0) {
      return metas
        .filter((meta) => meta.source === "browser-screenshot")
        .map((meta) => meta.filePath);
    }

    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim() || "";
    if (this.config.tmux.proxyUrl && !workspaceDir) {
      return [];
    }

    const resolvedWorkspaceDir = workspaceDir || process.cwd();
    const files = await listXchangeFiles(
      this.config.tmux,
      resolvedWorkspaceDir,
      this.config.exchange.dir,
    );
    return files.sort((left, right) => right.localeCompare(left));
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

  private async beginFileHandoffModeForTarget(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      filePath: string;
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram user or chat is missing.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(input.sessionId);
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const fileName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(input.filePath);
    const principalKey = buildPrincipalKey(principal);

    await ctx.answerCallbackQuery({
      text: "Project file handoff.",
    });
    const sent = await this.replyText(
      ctx,
      [
        "🤝 Передать участнику",
        "",
        `Сессия: ${session?.label ?? input.sessionId} -> ${input.targetSessionLabel}`,
        `Кому: ${input.targetSessionLabel}`,
        `Файл: ${fileName}`,
        "",
        "Отправь следующим сообщением описание или инструкции для этого файла.",
        "Этот текст будет приложен к handoff.",
      ].join("\n"),
      { kind: "menu", sessionId: input.sessionId },
      {
        reply_markup: new InlineKeyboard().text("Отмена", "file-handoff-cancel"),
      },
    );

    this.pendingFileHandoffs.set(principalKey, {
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

  private async handleLinkButton(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity недоступна.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (session?.linkedSessionId) {
      await this.unlinkSessions(sessionId, session.linkedSessionId);
      await ctx.answerCallbackQuery({ text: "Partner session unlinked." });
      await this.showMainMenu(ctx, "Partner session unlinked.");
      return;
    }

    await ctx.answerCallbackQuery({ text: "Choose a partner session." });
    await this.showLinkMenu(ctx);
  }

  private async showPartnerEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Идентификатор Telegram недоступен.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: "Сначала свяжи сессию с напарником.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Открываю меню напарника." });
    await this.showPartnerMenu(ctx);
  }

  private async showPartnerFiles(ctx: TelegramMenuContext): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Идентификатор Telegram недоступен.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: "Сначала свяжи сессию с напарником.",
        show_alert: true,
      });
      return;
    }

    const linkedSession = await this.sessionStore.getSession(session.linkedSessionId);
    const files = await this.listActiveSessionFiles(sessionId);
    const lines = [
      "📎 Выбор файла",
      "",
      `Получатель: ${linkedSession?.label ?? session.linkedSessionId}`,
      "",
      files.length > 0
        ? "Выбери файл для отправки локальному напарнику."
        : "В этой сессии нет загруженных файлов.",
    ];

    const keyboard = new InlineKeyboard();
    for (const filePath of files) {
      const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
        sessionId,
        filePath,
      );
      const label = this.formatFilePreviewLabel(filePath, meta).slice(0, 56);
      const payloadKey = await this.createPartnerFileTargetPayload(
        sessionId,
        session.linkedSessionId,
        linkedSession?.label ?? session.linkedSessionId,
        filePath,
      );
      keyboard.text(label, `partner-file-open:${payloadKey}`).row();
    }

    keyboard.text("⬅ К напарнику", "partner-back");

    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      await this.editText(
        ctx,
        text,
        { kind: "menu", sessionId },
        { reply_markup: keyboard },
      );
      return;
    }

    await this.replyText(
      ctx,
      text,
      { kind: "menu", sessionId },
      { reply_markup: keyboard },
    );
  }

  private async showLocalEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    await ctx.answerCallbackQuery({ text: "Открываю локальное взаимодействие." });
    await this.showLocalMenu(ctx);
  }

  private async showProjectsEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    if (!this.config.distributed.gatewayPublicUrl) {
      await ctx.answerCallbackQuery({
        text: "Collab доступен только через gateway.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Открываю Collab." });
    await this.showProjectsMenu(ctx);
  }

  private async handleLinkTargetSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Link payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "link-target" ||
      !payload.sessionId ||
      !payload.targetSessionId
    ) {
      await ctx.answerCallbackQuery({
        text: "Link payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    await this.linkSessions(payload.sessionId, payload.targetSessionId);
    const linkedSession = await this.sessionStore.getSession(
      payload.targetSessionId,
    );
    await ctx.answerCallbackQuery({ text: "Sessions linked." });
    await this.showMainMenu(
      ctx,
      linkedSession?.label
        ? `Linked with ${linkedSession.label}. Share API details, changes, errors, and git context with your teammate.`
        : `Linked with ${payload.targetSessionId}. Share API details, changes, errors, and git context with your teammate.`,
    );
  }

  private async handleScreenshotOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );

    await ctx.answerCallbackQuery({ text: "Screenshot opened." });
    await this.editText(
      ctx,
      this.formatScreenshotDetail(payload.sessionId, payload.filePath, meta),
      {
        kind: "menu",
        sessionId: payload.sessionId,
      },
      { reply_markup: this.screenshotMessageMenu },
    );
  }

  private async handleScreenshotGet(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({
        text: "Telegram chat is unavailable.",
        show_alert: true,
      });
      return;
    }

    const ensured = await this.ensureStoredXchangeFile(
      payload.sessionId,
      payload.filePath,
      "browser-screenshot",
    );
    await this.sendDocumentToChat(
      chatId,
      ensured.filePath,
      `Screenshot: ${path.basename(ensured.filePath)}`,
    );

    await ctx.answerCallbackQuery({ text: "Screenshot sent." });
    await this.showScreenshotsMenu(ctx, "Screenshot sent to Telegram.");
  }

  private async handleScreenshotDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Screenshot payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );
    await this.objectStore.deleteStoredFile({
      storageRef: meta?.storageRef,
      vfsNodeId: meta?.vfsNodeId,
    });
    await this.xchangeFileMetaStore.deleteXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );

    await ctx.answerCallbackQuery({
      text: meta ? "Screenshot deleted." : "Screenshot already absent.",
    });
    await this.showScreenshotsMenu(
      ctx,
      meta ? "Screenshot deleted." : "Screenshot was already removed.",
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
    await ctx.deleteMessage().catch(async () => {
      await ctx.editMessageText(
        deleted
          ? "Inbox message deleted."
          : "Inbox message was already removed.",
      );
    });
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
    const label = preview.length > 0 ? preview : "(empty message)";
    return message.attachments?.length ? `📎 ${label}` : label;
  }

  private formatFilePreviewLabel(
    filePath: string,
    meta?: {
      originalName?: string | undefined;
      relativePath?: string | undefined;
    } | null,
  ): string {
    return (
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(filePath)
    );
  }

  private formatSessionMenuLabel(input: {
    sessionId: string;
    sessionLabel?: string;
    linkedSessionLabel?: string;
    active: boolean;
    inboxCount: number;
  }): string {
    const baseName = input.sessionLabel ?? input.sessionId;
    const base = input.linkedSessionLabel
      ? `${baseName} → ${input.linkedSessionLabel}`
      : baseName;
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
      ...(message.attachments?.length
        ? [
            "",
            "Attachments:",
            ...message.attachments.map((attachment) => `- ${attachment}`),
          ]
        : []),
    ].join("\n");
  }

  private formatFileDetail(
    sessionId: string,
    filePath: string,
    meta?: {
      originalName?: string | undefined;
      relativePath?: string | undefined;
      caption?: string | undefined;
      uploadedAt?: string | undefined;
    } | null,
  ): string {
    const displayName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(filePath);

    return [
      "Session file",
      "",
      `Session: ${sessionId}`,
      `File: ${displayName}`,
      ...(meta?.uploadedAt ? [`Uploaded: ${meta.uploadedAt}`] : []),
      `Path: ${filePath}`,
      ...(meta?.caption ? ["", "Description:", meta.caption] : []),
    ].join("\n");
  }

  private formatScreenshotDetail(
    sessionId: string,
    filePath: string,
    meta?: {
      caption?: string | undefined;
      uploadedAt?: string | undefined;
    } | null,
  ): string {
    return [
      "Browser screenshot",
      "",
      `Session: ${sessionId}`,
      `File: ${path.basename(filePath)}`,
      ...(meta?.uploadedAt ? [`Created: ${meta.uploadedAt}`] : []),
      `Path: ${filePath}`,
      ...(meta?.caption ? ["", "Caption:", meta.caption] : []),
    ].join("\n");
  }

  private extractIncomingText(
    message: TelegramMenuContext["message"] | undefined,
  ): string | null {
    const text = message?.text?.trim() || message?.caption?.trim();
    return text && text.length > 0 ? text : null;
  }

  private collectIncomingAttachments(
    message: TelegramMenuContext["message"] | undefined,
  ): TelegramAttachmentDescriptor[] {
    if (!message) {
      return [];
    }

    const attachments: TelegramAttachmentDescriptor[] = [];

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largestPhoto = [...message.photo].sort(
        (left, right) => right.width * right.height - left.width * left.height,
      )[0];

      if (largestPhoto?.file_id) {
        attachments.push({
          fileId: largestPhoto.file_id,
          preferredName: `photo-${message.message_id}.jpg`,
          mimeType: "image/jpeg",
        });
      }
    }

    if (message.document?.file_id) {
      attachments.push({
        fileId: message.document.file_id,
        preferredName:
          message.document.file_name || `document-${message.message_id}.bin`,
        ...(message.document.mime_type
          ? { mimeType: message.document.mime_type }
          : {}),
      });
    }

    return attachments;
  }

  private buildInboxText(text: string | null, attachments: string[]): string {
    const lines: string[] = [];

    if (text) {
      lines.push(text);
    }

    if (attachments.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("Files saved in .mcp-xchange:");
      lines.push(...attachments.map((attachment) => `- ${attachment}`));
    }

    if (lines.length === 0) {
      return "Files uploaded from Telegram.";
    }

    return lines.join("\n");
  }

  private async storeTelegramUploadMetas(input: {
    sessionId: string;
    sourceTelegramMessageId: number;
    uploadedAt: string;
    attachments: StoredAttachmentRecord[];
    descriptors?: TelegramAttachmentDescriptor[] | undefined;
    caption?: string | undefined;
  }): Promise<void> {
    for (let index = 0; index < input.attachments.length; index += 1) {
      const attachment = input.attachments[index];
      if (!attachment) {
        continue;
      }

      const descriptor = input.descriptors?.[index];
      await this.xchangeFileMetaStore.setXchangeFileMeta({
        sessionId: input.sessionId,
        filePath: attachment.filePath,
        relativePath: attachment.relativePath,
        source: "telegram-upload",
        sourceTelegramMessageId: input.sourceTelegramMessageId,
        uploadedAt: input.uploadedAt,
        storageRef: attachment.storageRef,
        bucketName: attachment.bucketName,
        objectName: attachment.objectName,
        vfsNodeId: attachment.vfsNodeId,
        vfsPublicUrl: attachment.vfsPublicUrl,
        vfsParentId: attachment.vfsParentId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(
          descriptor && !descriptor.preferredName.startsWith("photo-")
            ? { originalName: descriptor.preferredName }
            : {}
        ),
        ...(input.caption ? { caption: input.caption } : {}),
      });
    }
  }

  private async ensureStoredXchangeFile(
    sessionId: string,
    filePath: string,
    source: "telegram-upload" | "browser-screenshot",
  ): Promise<{ session: Awaited<ReturnType<SessionStore["getSession"]>>; filePath: string }> {
    const session = await this.sessionStore.getSession(sessionId);
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      sessionId,
      filePath,
    );

    if (!meta) {
      return { session, filePath };
    }

    const materializedPath = await this.objectStore.ensureLocalFile({
      sessionId,
      session,
      filePath,
      relativePath: meta.relativePath,
      storageRef: meta.storageRef,
      source,
    });

    return {
      session,
      filePath: materializedPath,
    };
  }

  private async downloadIncomingAttachments(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    sourceTelegramMessageId: number,
    attachments: TelegramAttachmentDescriptor[],
  ): Promise<StoredAttachmentRecord[]> {
    if (attachments.length === 0) {
      return [];
    }

    const savedFiles: StoredAttachmentRecord[] = [];
    for (const attachment of attachments) {
      const savedFile = await this.downloadTelegramFile(
        session,
        sessionId,
        attachment.fileId,
        sourceTelegramMessageId,
        attachment.preferredName,
        attachment.mimeType,
      );
      savedFiles.push(savedFile);
    }

    return savedFiles;
  }

  private async downloadTelegramFile(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    fileId: string,
    _sourceTelegramMessageId: number,
    preferredName: string,
    preferredMimeType?: string | undefined,
  ): Promise<StoredAttachmentRecord> {
    const telegramFile = await this.bot.api.getFile(fileId);
    if (!telegramFile.file_path) {
      throw new Error("Telegram file path is missing");
    }

    const outputName = preferredName;
    const fileUrl = `https://api.telegram.org/file/bot${this.config.telegram.botToken}/${telegramFile.file_path}`;
    const response = await this.telegramFetch(fileUrl);

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with status ${response.status}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return this.objectStore.storeFile({
      session,
      sessionId,
      source: "telegram-upload",
      relativePath: buildDatedRelativePath(outputName),
      content: buffer,
      mimeType:
        preferredMimeType ||
        response.headers.get("content-type") ||
        undefined,
    });
  }

  private slugifyPathPart(input: string): string {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    return slug.slice(0, 80) || "item";
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

  private getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined {
    const firstName = ctx.from?.first_name?.trim();
    const lastName = ctx.from?.last_name?.trim();
    const username = ctx.from?.username?.trim();
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName && !lastName && !username) {
      return undefined;
    }

    return {
      ...(username ? { telegramUsername: username } : {}),
      ...(firstName ? { telegramFirstName: firstName } : {}),
      ...(lastName ? { telegramLastName: lastName } : {}),
      ...(displayName ? { telegramDisplayName: displayName } : {}),
    };
  }

  private async showSessionsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.setCurrentAttachmentTargetForContext(ctx, null);
    try {
      const text = await this.buildSessionsMenuText(ctx);
      const intro = introText ? escapeHtml(introText) : null;
      await this.renderMenuHtmlScreen(
        ctx,
        intro ? `${intro}\n\n${text}` : text,
        { kind: "menu" },
        this.sessionsMenu,
      );
    } catch (error) {
      this.logger.error("Failed to render Telegram sessions menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      await this.replyText(
        ctx,
        "Sessions menu is temporarily unavailable. Try /menu again.",
        { kind: "menu" },
      );
    }
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

  private async showBrowserMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildBrowserMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.browserMenu,
    );
  }

  private async showScreenshotsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildScreenshotsMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.screenshotsMenu,
    );
  }

  private async showLinkMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildLinkMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.linkMenu,
    );
  }

  private async showPartnerMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (principal) {
      const sessionId =
        await this.bindingStore.getActiveSessionIdForPrincipal(principal);
      const session = sessionId
        ? await this.sessionStore.getSession(sessionId)
        : null;
      if (sessionId && session?.linkedSessionId) {
        const linkedSession = await this.sessionStore.getSession(
          session.linkedSessionId,
        );
        this.setCurrentAttachmentTargetForContext(ctx, {
          sessionId,
          targetSessionId: session.linkedSessionId,
          targetSessionLabel: linkedSession?.label ?? session.linkedSessionId,
        });
      } else {
        this.setCurrentAttachmentTargetForContext(ctx, null);
      }
    }
    const text = await this.buildPartnerMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.partnerMenu,
    );
  }

  private async showLocalMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildLocalMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.localMenu,
    );
  }

  private async showProjectsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    this.setCurrentAttachmentTargetForContext(ctx, null);
    const text = await this.buildProjectsMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.projectsMenu,
    );
  }

  private async showSettingsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildSettingsMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.settingsMenu,
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

  private async renderMenuMarkdownScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.editText(ctx, text, meta, {
        parse_mode: "MarkdownV2",
        reply_markup: menu,
      });
      return;
    }

    await this.replyText(
      ctx,
      text,
      meta,
      {
        parse_mode: "MarkdownV2",
        reply_markup: menu,
      },
    );
  }

  private async renderMenuHtmlScreen(
    ctx: TelegramMenuContext,
    text: string,
    meta: Omit<SendMessageMeta, "kind"> & { kind: "menu" },
    menu: Menu<TelegramMenuContext>,
  ): Promise<void> {
    if (ctx.callbackQuery?.message) {
      await this.editText(ctx, text, meta, {
        parse_mode: "HTML",
        reply_markup: menu,
      });
      return;
    }

    await this.replyText(
      ctx,
      text,
      meta,
      {
        parse_mode: "HTML",
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

    if (
      !this.config.webapp.enabled ||
      (!this.config.webapp.publicUrl &&
        !this.config.distributed.gatewayPublicUrl)
    ) {
      await ctx.answerCallbackQuery({
        text: "WebApp is not enabled on the server.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const actor = this.getGatewayActorFromContext(ctx);
    const useGatewayRelay =
      this.config.distributed.mode === "client" &&
      Boolean(this.config.distributed.gatewayPublicUrl);
    const clientUuid = useGatewayRelay
      ? await this.ensureGatewayClientUuid(principal, actor)
      : null;
    const baseUrl = useGatewayRelay
      ? resolveGatewayWebAppBaseUrl(
          this.config.distributed.gatewayPublicUrl!,
          this.config.webapp.basePath,
        )
      : resolveWebAppPublicBaseUrl(this.config);
    if (!baseUrl) {
      await ctx.answerCallbackQuery({
        text: "WebApp public URL is not configured.",
        show_alert: true,
      });
      return;
    }
    const liveSessionId =
      useGatewayRelay && clientUuid
        ? buildLiveRelaySessionId(clientUuid, activeSessionId)
        : activeSessionId;
    const url = new URL(`${baseUrl}/live/${encodeURIComponent(liveSessionId)}`);

    await ctx.answerCallbackQuery({ text: "Открываю Live View." });
    const sent = await this.replyText(
      ctx,
      [
        "🖥 Live View",
        "",
        `Сессия: ${session?.label ?? activeSessionId}`,
        ...(useGatewayRelay ? ["Режим: relay через gateway"] : []),
        "Открой Mini App, чтобы видеть текущий tmux-экран и отправлять Up/Down/Enter.",
      ].join("\n"),
      { kind: "menu", sessionId: activeSessionId },
      {
        reply_markup: new InlineKeyboard().webApp(
          "Open Live View",
          url.toString(),
        ),
      },
    );
    this.webAppLaunchRegistry.set(
      principal.telegramUserId,
      activeSessionId,
      this.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: principal.telegramChatId,
        ...(sent && "message_id" in sent
          ? { telegramMessageId: sent.message_id }
          : {}),
      },
    );
  }

  private buildLiveViewUrlForSessionTarget(input: {
    targetSessionId: string;
    targetClientUuid?: string | undefined;
    targetLocalSessionId?: string | undefined;
    sourceClientUuid?: string | undefined;
  }): string | null {
    if (
      !this.config.webapp.enabled ||
      (!this.config.webapp.publicUrl &&
        !this.config.distributed.gatewayPublicUrl)
    ) {
      return null;
    }

    const canUseRelay =
      Boolean(input.targetClientUuid) &&
      Boolean(input.targetLocalSessionId) &&
      Boolean(this.config.distributed.gatewayPublicUrl);
    const baseUrl = canUseRelay
      ? resolveGatewayWebAppBaseUrl(
          this.config.distributed.gatewayPublicUrl!,
          this.config.webapp.basePath,
        )
      : resolveWebAppPublicBaseUrl(this.config);
    if (!baseUrl) {
      return null;
    }

    const liveSessionId = canUseRelay
      ? buildLiveRelaySessionId(
          input.targetClientUuid!,
          input.targetLocalSessionId!,
          input.sourceClientUuid,
        )
      : (input.targetLocalSessionId ?? input.targetSessionId);
    return new URL(
      `${baseUrl}/live/${encodeURIComponent(liveSessionId)}`,
    ).toString();
  }

  private clearPendingInteractionsForContext(ctx: TelegramMenuContext): void {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return;
    }

    const key = buildPrincipalKey(principal);
    this.pendingRenames.delete(key);
    this.pendingBroadcasts.delete(key);
    this.pendingPartnerNotes.delete(key);
    this.pendingFileHandoffs.delete(key);
    this.pendingProjects.delete(key);
  }

  private setCurrentAttachmentTargetForContext(
    ctx: TelegramMenuContext,
    target: CurrentAttachmentTargetRecord | null,
  ): void {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return;
    }

    const key = buildPrincipalKey(principal);
    if (target) {
      this.currentAttachmentTargets.set(key, target);
      return;
    }

    this.currentAttachmentTargets.delete(key);
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
          formatTmuxBridgeError(
            this.config,
            error,
            "Unable to capture tmux buffer right now.",
          ),
          { kind: "menu", sessionId },
        );
        return;
      }

      this.logger.error("tmux buffer capture failed", payload);
      await this.replyText(
        ctx,
        formatTmuxBridgeError(
          this.config,
          error,
          "Failed to capture the tmux buffer for this session.",
        ),
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
        `🕘 Last worked: <i>${escapeHtml(
          lastWorkedSession.label ?? lastWorkedSession.sessionId,
        )}</i>`,
      );
      const formattedUpdatedAt = formatMenuTimestamp(
        lastWorkedSession.updatedAt,
      );
      if (formattedUpdatedAt) {
        lines.push(`⏱ Updated: <i>${escapeHtml(formattedUpdatedAt)}</i>`);
      }
      lines.push("");
    }

    if (activeSessionId) {
      const activeSession = await this.sessionStore.getSession(activeSessionId);
      lines.push(
        `📌 Current active: <b>${escapeHtml(
          activeSession?.label ?? activeSessionId,
        )}</b>`,
      );
      lines.push("");
    }

    lines.push(`<i>${escapeHtml(await this.getTmuxProxyStatusLine())}</i>`);
    lines.push("");
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
      "📄 Content",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `🖥 tmux target: ${session?.tmuxTarget ?? "not set"}`,
      "",
      "Choose how much pane history to export as a Markdown file.",
      "Visible is the current pane viewport. Full exports the whole available tmux history.",
    ].join("\n");
  }

  private async buildBrowserMenuText(
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
    const screenshots = await this.listActiveSessionScreenshots(activeSessionId);

    return [
      "🌐 Browser",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `📸 Stored screenshots: ${screenshots.length}`,
      "",
      "Choose a browser-related action below.",
    ].join("\n");
  }

  private async buildSettingsMenuText(
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
      "⚙ Settings",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      "",
      "Открой информацию о сессии, переименуй её или отвяжи от Telegram.",
    ].join("\n");
  }

  private async buildScreenshotsMenuText(
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
    const files = await this.listActiveSessionScreenshots(activeSessionId);

    return [
      "📸 Screenshots",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      `📦 Stored screenshots: ${files.length}`,
      "",
      files.length > 0
        ? "Choose a screenshot below to get it in Telegram or delete it."
        : "No browser screenshots are stored for this session.",
    ].join("\n");
  }

  private async buildLinkMenuText(ctx: TelegramMenuContext): Promise<string> {
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
      "🔗 Link partner",
      "",
      `📌 Active session: ${session?.label ?? activeSessionId}`,
      "",
      "Choose another session to link as a teammate.",
      "Use this partnership to share API summaries, what's new, errors, and relevant git changes through .mcp-xchange notes and files.",
    ].join("\n");
  }

  private async buildPartnerMenuText(
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
    if (!session?.linkedSessionId) {
      return [
        "🤝 Partner",
        "",
        `📌 Active session: ${session?.label ?? activeSessionId}`,
        "",
        "No partner is linked yet.",
        "Use Link in the session menu first.",
      ].join("\n");
    }

    const linkedSession = await this.sessionStore.getSession(
      session.linkedSessionId,
    );

    return [
      "🤝 Partner",
      "",
      `📌 Active session: ${session.label ?? activeSessionId}`,
      `👥 Linked partner: ${linkedSession?.label ?? session.linkedSessionId}`,
      "",
      "Ask for API details or share what changed.",
      "Prompt format: first line is summary. Add a blank line and then the main message body if needed.",
    ].join("\n");
  }

  private async buildLocalMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return "Локальное взаимодействие недоступно для этого чата.";
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return "Активная сессия не выбрана. Сначала привяжи её через /start.";
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const linkedSession = session?.linkedSessionId
      ? await this.sessionStore.getSession(session.linkedSessionId)
      : null;

    return [
      "🏠 Local",
      "",
      `📌 Активная сессия: ${session?.label ?? activeSessionId}`,
      `🤝 Связь: ${linkedSession?.label ?? "не настроена"}`,
      "",
      "Здесь живёт локальная работа в одном боте:",
      "связка сессий, обмен note и файлами без gateway.",
    ].join("\n");
  }

  private async buildProjectsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const { session, projects } = await this.loadProjectsContext(ctx);
    if (!this.config.distributed.gatewayPublicUrl) {
      return [
        "👥 Collab",
        "",
        "Gateway не настроен для этого запуска.",
        "Для локальной работы в одном боте используй раздел Local.",
      ].join("\n");
    }

    if (!session || !projects) {
      return "Collab недоступен для текущей сессии.";
    }

    return [
      "👥 Collab",
      "",
      `📌 Активная сессия: ${session.label ?? session.sessionId}`,
      `📦 Открытый проект: ${session.activeProjectName ?? "не выбран"}`,
      `🗂 Доступно проектов: ${projects.length}`,
      "",
      "Открой проект, создай новый или войди по invite-коду.",
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
    const linkedSession = session?.linkedSessionId
      ? await this.sessionStore.getSession(session.linkedSessionId)
      : null;

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
        `🤝 Partner: ${linkedSession?.label ?? session?.linkedSessionId ?? "not linked"}`,
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
      { reply_markup: this.settingsMenu },
    );
  }

  private async linkSessions(
    sessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    if (sessionId === targetSessionId) {
      throw new Error("A session cannot be linked to itself.");
    }

    const sourceSession = await this.sessionStore.getSession(sessionId);
    const targetSession = await this.sessionStore.getSession(targetSessionId);
    if (!sourceSession || !targetSession) {
      throw new Error("Source or target session does not exist.");
    }

    await this.unlinkSessions(sessionId, sourceSession.linkedSessionId);
    await this.unlinkSessions(targetSessionId, targetSession.linkedSessionId);

    await this.sessionStore.setSession({
      ...sourceSession,
      linkedSessionId: targetSessionId,
      updatedAt: new Date().toISOString(),
    });
    await this.sessionStore.setSession({
      ...targetSession,
      linkedSessionId: sessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  private async unlinkSessions(
    sessionId: string,
    linkedSessionId?: string | undefined,
  ): Promise<void> {
    const sourceSession = await this.sessionStore.getSession(sessionId);
    if (!sourceSession) {
      return;
    }

    const partnerId = linkedSessionId ?? sourceSession.linkedSessionId;
    if (sourceSession.linkedSessionId) {
      const { linkedSessionId: _linkedSessionId, ...rest } = sourceSession;
      await this.sessionStore.setSession({
        ...rest,
        updatedAt: new Date().toISOString(),
      });
    }

    if (!partnerId) {
      return;
    }

    const partnerSession = await this.sessionStore.getSession(partnerId);
    if (!partnerSession || partnerSession.linkedSessionId !== sessionId) {
      return;
    }

    const { linkedSessionId: _partnerLinkedSessionId, ...restPartner } =
      partnerSession;
    await this.sessionStore.setSession({
      ...restPartner,
      updatedAt: new Date().toISOString(),
    });
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
    const stdout = await captureTmuxPaneRange(
      this.config.tmux,
      target,
      paneStart,
      false,
    );

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
      stdout.replaceAll("\u0000", ""),
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

    const height = await getTmuxWindowHeight(this.config.tmux, target);
    if (typeof height !== "number" || height <= 0) {
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

    await ctx.answerCallbackQuery({
      text: `Broadcast to ${sessionIds.length} sessions.`,
    });
    const sent = await this.replyText(
      ctx,
      [
        "📣 Broadcast",
        "",
        `Send the next text message to broadcast it to all ${sessionIds.length} linked sessions.`,
        "The message will be stored in every session inbox and the service will nudge every configured tmux target.",
        "Commands like /menu or /help will cancel broadcast mode.",
      ].join("\n"),
      { kind: "menu" },
      {
        reply_markup: new InlineKeyboard().text(
          "Cancel",
          "broadcast-cancel",
        ),
      },
    );

    this.pendingBroadcasts.set(principalKey, {
      initiatedAt: new Date().toISOString(),
      ...(sent ? { promptMessageId: sent.message_id } : {}),
      ...(ctx.callbackQuery?.message?.message_id
        ? { menuMessageId: ctx.callbackQuery.message.message_id }
        : {}),
    });
  }

  private async deletePendingBroadcastArtifacts(
    ctx: TelegramMenuContext,
    pending: PendingBroadcastRecord,
    options: {
      deleteMenuMessage: boolean;
    },
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    for (const messageId of [
      pending.promptMessageId,
      ...(options.deleteMenuMessage ? [pending.menuMessageId] : []),
    ]) {
      if (!messageId) {
        continue;
      }

      try {
        await this.deleteMessage(chatId, messageId);
      } catch (error) {
        this.logger.warn("Failed to delete pending broadcast menu artifact", {
          chatId,
          messageId,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      }
    }
  }

  private async cancelPendingBroadcast(
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

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingBroadcasts.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Broadcast mode is not active.",
        show_alert: true,
      });
      return;
    }

    this.pendingBroadcasts.delete(principalKey);
    await this.deletePendingBroadcastArtifacts(ctx, pending, {
      deleteMenuMessage: false,
    });
    await ctx.answerCallbackQuery({ text: "Broadcast cancelled." });
    await this.showDeveloperMenu(ctx);
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
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.linkedSessionId
        ? { linkedSessionId: session.linkedSessionId }
        : {}),
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
      await this.deletePendingBroadcastArtifacts(ctx, pending, {
        deleteMenuMessage: false,
      });
      return false;
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);
    const broadcastText = text.trim();
    if (sessionIds.length === 0) {
      this.pendingBroadcasts.delete(principalKey);
      await this.deletePendingBroadcastArtifacts(ctx, pending, {
        deleteMenuMessage: false,
      });
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
    await this.deletePendingBroadcastArtifacts(ctx, pending, {
      deleteMenuMessage: false,
    });
    this.logger.info("Telegram broadcast completed", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
      storedCount,
      sessionCount: sessionIds.length,
      initiatedAt: pending.initiatedAt,
      text: redactSecrets(broadcastText),
    });
    return true;
  }

  private parsePartnerNoteText(text: string): {
    summary: string;
    message: string;
  } {
    const normalized = text.trim();
    const lines = normalized.split("\n");
    const summary = lines[0]?.trim() || normalized;
    const body = lines.slice(1).join("\n").replace(/^\s*\n/u, "").trim();

    return {
      summary,
      message: body || normalized,
    };
  }

  private async beginPartnerNoteMode(
    ctx: TelegramMenuContext,
    kind: PartnerNoteKind,
    target?: {
      targetSessionId: string;
      targetSessionLabel: string;
      projectUuid?: string;
    },
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
    if (!target && !session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: "Link a partner session first.",
        show_alert: true,
      });
      return;
    }

    const linkedSession =
      target
        ? null
        : await this.sessionStore.getSession(session!.linkedSessionId!);
    const targetLabel =
      target?.targetSessionLabel ??
      linkedSession?.label ??
      session?.linkedSessionId ??
      "напарник";
    const sourceLabel = session?.label ?? sessionId;
    const isProjectTarget = Boolean(target?.projectUuid);
    const executesOnTarget = isExecutorTargetKind(kind);
    const kindLabel =
      kind === "question"
        ? isProjectTarget
          ? "Вопрос участнику"
          : "Вопрос напарнику"
        : kind === "reply"
          ? isProjectTarget
            ? "Ответ участнику"
            : "Ответ напарнику"
          : kind === "handoff"
            ? isProjectTarget
              ? "Передача участнику"
              : "Передача напарнику"
            : isProjectTarget
              ? "Поделиться с участником"
              : "Поделиться обновлением";

    await ctx.answerCallbackQuery({ text: `${kindLabel}.` });
    const sent = await this.replyText(
      ctx,
      [
        `🤝 ${kindLabel}`,
        "",
        `Текущая сессия: ${sourceLabel}`,
        executesOnTarget
          ? isProjectTarget
            ? `Исполнитель: ${targetLabel}`
            : `Напарник: ${targetLabel}`
          : isProjectTarget
            ? `Получатель: ${targetLabel}`
            : `Напарник: ${targetLabel}`,
        executesOnTarget
          ? `Ожидаемый ответ: ${targetLabel} -> ${sourceLabel}`
          : `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        "",
        executesOnTarget
          ? "Отправь следующим сообщением задачу для выбранной сессии."
          : "Отправь следующим сообщением, чем текущая сессия должна поделиться.",
        executesOnTarget
          ? isProjectTarget
            ? "Агент выбранной сессии получит задачу и сможет отправить результат обратно в текущую сессию проекта."
            : "Агент напарника получит задачу и сможет отправить результат обратно в текущую сессию."
          : isProjectTarget
            ? "Агент текущей сессии получит задачу и сам отправит результат в выбранную сессию проекта."
            : "Агент текущей сессии получит задачу и сам отправит результат напарнику.",
        "Формат:",
        "1. Первая строка = короткое summary",
        "2. Пустая строка опциональна",
        "3. Остальной текст = основное сообщение",
        "",
        "Команды вроде /menu или /help отменят этот режим.",
      ].join("\n"),
      { kind: "menu", sessionId },
      {
        reply_markup: new InlineKeyboard().text("Отмена", "partner-note-cancel"),
      },
    );

    this.pendingPartnerNotes.set(buildPrincipalKey(principal), {
      sessionId,
      kind,
      initiatedAt: new Date().toISOString(),
      ...(target ? { targetSessionId: target.targetSessionId } : {}),
      ...(target ? { targetSessionLabel: target.targetSessionLabel } : {}),
      ...(target?.projectUuid ? { projectUuid: target.projectUuid } : {}),
      ...(sent && "message_id" in sent ? { promptMessageId: sent.message_id } : {}),
    });
  }

  private async deletePendingPartnerNotePrompt(
    ctx: TelegramMenuContext,
    pending: PendingPartnerNoteRecord,
  ): Promise<void> {
    if (!pending.promptMessageId) {
      return;
    }

    try {
      await this.deleteMessage(ctx.chat!.id, pending.promptMessageId);
    } catch (error) {
      this.logger.warn("Failed to delete pending partner note prompt", {
        sessionId: pending.sessionId,
        promptMessageId: pending.promptMessageId,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async cancelPendingPartnerNote(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity недоступна.",
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingPartnerNotes.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Нет активного ввода для note напарнику.",
        show_alert: true,
      });
      return;
    }

    this.pendingPartnerNotes.delete(principalKey);
    await this.deletePendingPartnerNotePrompt(ctx, pending);
    await ctx.answerCallbackQuery({ text: "Отправка note напарнику отменена." });
    await this.showPartnerMenu(ctx);
  }

  private async beginProjectMode(
    ctx: TelegramMenuContext,
    mode: "create" | "join",
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

    const sent = await this.replyText(
      ctx,
      mode === "create"
        ? [
            "📦 Создать проект",
            "",
            "Отправь следующим сообщением имя проекта.",
            "Команды вроде /menu или /help отменят этот режим.",
          ].join("\n")
        : [
            "🔑 Вступить в проект",
            "",
            "Отправь следующим сообщением invite token проекта.",
            "Команды вроде /menu или /help отменят этот режим.",
          ].join("\n"),
      { kind: "menu", sessionId },
    );

    this.pendingProjects.set(buildPrincipalKey(principal), {
      sessionId,
      mode,
      initiatedAt: new Date().toISOString(),
      ...(sent ? { promptMessageId: sent.message_id } : {}),
    });

    await ctx.answerCallbackQuery({
      text: mode === "create" ? "Создание проекта." : "Вход в проект.",
    });
  }

  private async handleProjectSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Данные проекта не найдены.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: "Данные проекта устарели или некорректны.",
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: "Telegram identity is unavailable.",
        show_alert: true,
      });
      return;
    }

    const project = await this.getProjectPayloadByUuid(
      payload.sessionId,
      payload.projectUuid,
    );
    if (!project) {
      await ctx.answerCallbackQuery({
        text: "Проект не найден.",
        show_alert: true,
      });
      return;
    }

    await this.ensureOpenedProjectIsActive({
      principal,
      sessionId: project.sessionId,
      projectUuid: project.projectUuid,
      projectName: project.projectName,
    });
    await ctx.answerCallbackQuery({ text: "Открываю участников проекта." });
    await this.showProjectMembers(ctx, project);
  }

  private async leaveActiveProject(
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
    if (!session?.activeProjectUuid) {
      await ctx.answerCallbackQuery({
        text: "No active project.",
        show_alert: true,
      });
      return;
    }

    const clientUuid = await this.ensureGatewayClientUuid(principal);
    await this.callGatewayJson("/projects/leave", {
      client_uuid: clientUuid,
      project_uuid: session.activeProjectUuid,
    });

    await this.sessionStore.setSession({
      ...session,
      activeProjectUuid: undefined,
      activeProjectName: undefined,
      updatedAt: new Date().toISOString(),
    });

    await ctx.answerCallbackQuery({ text: "Project left." });
    await this.showProjectsMenu(ctx, "Вы вышли из текущего проекта.");
  }

  private async showProjectDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
  ): Promise<void> {
    await this.showProjectMembers(ctx, input);
  }

  private async showProjectMembers(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
    options?: {
      filePath?: string;
    },
  ): Promise<void> {
    this.setCurrentAttachmentTargetForContext(ctx, null);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      throw new Error("Telegram identity is unavailable.");
    }

    await this.ensureOpenedProjectIsActive({
      principal,
      sessionId: input.sessionId,
      projectUuid: input.projectUuid,
      projectName: input.projectName,
    });
    const screen = await this.buildProjectMembersScreen(input, options);
    if (ctx.callbackQuery?.message) {
      await this.editText(
        ctx,
        screen.text,
        { kind: "menu", sessionId: input.sessionId },
        { parse_mode: "HTML", reply_markup: screen.keyboard },
      );
      if (ctx.chat && "message_id" in ctx.callbackQuery.message) {
        await this.maintenanceStore.setProjectMenuViewState({
          sessionId: input.sessionId,
          projectUuid: input.projectUuid,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.callbackQuery.message.message_id,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    const sent = await this.replyText(
      ctx,
      screen.text,
      { kind: "menu", sessionId: input.sessionId },
      { parse_mode: "HTML", reply_markup: screen.keyboard },
    );
    if (sent && "message_id" in sent && ctx.chat) {
      await this.maintenanceStore.setProjectMenuViewState({
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        telegramChatId: ctx.chat.id,
        telegramMessageId: sent.message_id,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async buildProjectMembersScreen(
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
    },
    options?: {
      filePath?: string;
    },
  ): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const session = await this.sessionStore.getSession(input.sessionId);
    const binding = await this.bindingStore.getBinding(input.sessionId);
    if (!binding) {
      throw new Error("Binding is missing for project members screen.");
    }
    const sessions = await this.listGatewayProjectSessions(
      {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      input.projectUuid,
    );
    const activeSessionId = session?.sessionId ?? null;
    const selectableMembers = sessions.filter(
      (item) => item.local_session_id !== activeSessionId,
    );
    const currentMember = sessions.find(
      (item) => item.local_session_id === activeSessionId,
    );

    const lines = [
      "👥 Участники проекта",
      "",
      `Проект: ${input.projectName}`,
      `UUID: ${input.projectUuid}`,
      `Invite: <i>${escapeHtml(input.inviteToken)}</i>`,
      "",
      `Ваш клиент: ${currentMember?.client_label ?? currentMember?.bot_username ?? "текущий бот"}`,
      `Других сессий: ${selectableMembers.length}`,
      "",
      selectableMembers.length > 0
        ? options?.filePath
          ? "Выбери, кому передать этот файл."
          : "Выбери сессию, чтобы спросить, поделиться, ответить или передать."
        : "В этом проекте пока нет других активных сессий.",
    ];

    const keyboard = new InlineKeyboard();
    for (const member of selectableMembers) {
      const sessionLabel = member.label?.trim() || member.local_session_id;
      const telegramUsernameRaw = member.telegram_username?.trim() || null;
      const botUsernameRaw = member.bot_username?.trim() || null;
      const normalizedTelegramUsername =
        telegramUsernameRaw?.replace(/^@/u, "") || null;
      const normalizedBotUsername = botUsernameRaw?.replace(/^@/u, "") || null;
      const identityParts = [
        normalizedTelegramUsername ? `👤${normalizedTelegramUsername}` : null,
        normalizedBotUsername ? `🤖${normalizedBotUsername}` : null,
      ].filter(Boolean);
      const buttonLabel = identityParts.length > 0
        ? `${sessionLabel} · ${identityParts.join(" / ")}`.slice(0, 56)
        : sessionLabel.slice(0, 56);
      const payloadKey = await this.createProjectMemberMenuPayload(
        input.sessionId,
        input.projectUuid,
        member.session_uuid,
        sessionLabel,
        {
          ...(options?.filePath ? { filePath: options.filePath } : {}),
          targetClientUuid: member.client_uuid,
          targetLocalSessionId: member.local_session_id,
        },
      );
      keyboard.text(buttonLabel, `project-member-open:${payloadKey}`).row();
    }

    keyboard
      .text("🚪 Выйти", `project-leave:${input.projectUuid}`)
      .text("⬅ К проектам", "project-back");

    return { text: lines.join("\n"), keyboard };
  }

  private async showProjectMemberDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (principal) {
      await this.ensureOpenedProjectIsActive({
        principal,
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        projectName: input.projectName,
      });
      this.setCurrentAttachmentTargetForContext(ctx, {
        sessionId: input.sessionId,
        targetSessionId: input.targetSessionId,
        targetSessionLabel: input.targetSessionLabel,
        projectUuid: input.projectUuid,
      });
    }
    const session = await this.sessionStore.getSession(input.sessionId);
    const actor = this.getGatewayActorFromContext(ctx);
    const sourceClientUuid =
      this.config.distributed.mode === "client" &&
      this.config.distributed.gatewayPublicUrl &&
      principal
        ? await this.ensureGatewayClientUuid(principal, actor)
        : null;

    const text = [
      "🤝 Сессия проекта",
      "",
      `Проект: ${input.projectName}`,
      `Текущая сессия: ${session?.label ?? input.sessionId}`,
      `Исполнитель: ${input.targetSessionLabel}`,
      `Ask: ${input.targetSessionLabel} -> ${session?.label ?? input.sessionId}`,
      `Share: ${session?.label ?? input.sessionId} -> ${input.targetSessionLabel}`,
      "",
      "Выбери тип действия для этой пары сессий.",
    ].join("\n");

    const payloadKey = await this.createProjectMemberMenuPayload(
      input.sessionId,
      input.projectUuid,
      input.targetSessionId,
      input.targetSessionLabel,
      {
        ...(input.targetClientUuid
          ? { targetClientUuid: input.targetClientUuid }
          : {}),
        ...(input.targetLocalSessionId
          ? { targetLocalSessionId: input.targetLocalSessionId }
          : {}),
      },
    );
    const liveViewUrl = this.buildLiveViewUrlForSessionTarget({
      targetSessionId: input.targetSessionId,
      targetClientUuid: input.targetClientUuid,
      targetLocalSessionId: input.targetLocalSessionId,
      ...(sourceClientUuid ? { sourceClientUuid } : {}),
    });

    const keyboard = new InlineKeyboard()
      .text("❓ Спросить", `project-member-note:question:${payloadKey}`)
      .text("📤 Поделиться", `project-member-note:share:${payloadKey}`)
      .row();
    if (liveViewUrl) {
      keyboard.webApp("🖥 Live", liveViewUrl).row();
    }
    keyboard.text("⬅ К участникам", `project-members:${input.projectUuid}`);

    if (ctx.callbackQuery?.message) {
      if (principal && ctx.chat && "message_id" in ctx.callbackQuery.message) {
        this.webAppLaunchRegistry.set(
          principal.telegramUserId,
          input.sessionId,
          this.config.webapp.initDataTtlSeconds,
          {
            telegramChatId: ctx.chat.id,
            telegramMessageId: ctx.callbackQuery.message.message_id,
          },
        );
      }
      await this.editText(
        ctx,
        text,
        { kind: "menu", sessionId: input.sessionId },
        { parse_mode: "HTML", reply_markup: keyboard },
      );
      return;
    }

    const sent = await this.replyText(
      ctx,
      text,
      { kind: "menu", sessionId: input.sessionId },
      { parse_mode: "HTML", reply_markup: keyboard },
    );
    if (principal) {
      this.webAppLaunchRegistry.set(
        principal.telegramUserId,
        input.sessionId,
        this.config.webapp.initDataTtlSeconds,
        {
          ...(ctx.chat ? { telegramChatId: ctx.chat.id } : {}),
          ...(sent && "message_id" in sent
            ? { telegramMessageId: sent.message_id }
            : {}),
        },
      );
    }
  }

  private async showProjectMemberFiles(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      projectUuid: string;
      projectName: string;
      inviteToken: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid?: string;
      targetLocalSessionId?: string;
    },
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (principal) {
      await this.ensureOpenedProjectIsActive({
        principal,
        sessionId: input.sessionId,
        projectUuid: input.projectUuid,
        projectName: input.projectName,
      });
    }

    const files = await this.listActiveSessionFiles(input.sessionId);
    const lines = [
      "📎 Выбор файла",
      "",
      `Проект: ${input.projectName}`,
      `Получатель: ${input.targetSessionLabel}`,
      "",
      files.length > 0
        ? "Выбери файл для отправки."
        : "В этой сессии нет загруженных файлов.",
    ];

    const keyboard = new InlineKeyboard();
    for (const filePath of files) {
      const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
        input.sessionId,
        filePath,
      );
      const label = this.formatFilePreviewLabel(filePath, meta).slice(0, 56);
      const payloadKey = await this.createProjectMemberMenuPayload(
        input.sessionId,
        input.projectUuid,
        input.targetSessionId,
        input.targetSessionLabel,
        {
          filePath,
          ...(input.targetClientUuid
            ? { targetClientUuid: input.targetClientUuid }
            : {}),
          ...(input.targetLocalSessionId
            ? { targetLocalSessionId: input.targetLocalSessionId }
            : {}),
        },
      );
      keyboard.text(label, `project-member-open:${payloadKey}`).row();
    }

    keyboard.text("⬅ К сессии", `project-member-open:${await this.createProjectMemberMenuPayload(
      input.sessionId,
      input.projectUuid,
      input.targetSessionId,
      input.targetSessionLabel,
      {
        ...(input.targetClientUuid
          ? { targetClientUuid: input.targetClientUuid }
          : {}),
        ...(input.targetLocalSessionId
          ? { targetLocalSessionId: input.targetLocalSessionId }
          : {}),
      },
    )}`);

    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      await this.editText(
        ctx,
        text,
        { kind: "menu", sessionId: input.sessionId },
        { reply_markup: keyboard },
      );
      return;
    }

    await this.replyText(
      ctx,
      text,
      { kind: "menu", sessionId: input.sessionId },
      { reply_markup: keyboard },
    );
  }

  private async getProjectPayloadByUuid(
    sessionId: string,
    projectUuid: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
  } | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return null;
    }

    const principalBindings = await this.bindingStore.getBinding(sessionId);
    if (!principalBindings) {
      return null;
    }

    const projects = await this.listGatewayProjects({
      telegramChatId: principalBindings.telegramChatId,
      telegramUserId: principalBindings.telegramUserId,
    });
    const project = projects.find((item) => item.project_uuid === projectUuid);
    if (!project) {
      return null;
    }

    return {
      sessionId,
      projectUuid,
      projectName: project.name,
      inviteToken: project.invite_token,
    };
  }

  private async getProjectMemberPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    projectUuid: string;
    projectName: string;
    inviteToken: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid?: string;
    targetLocalSessionId?: string;
    filePath?: string;
  } | null> {
    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      (payload.kind !== "project-member" &&
        payload.kind !== "project-file-target") ||
      !payload.sessionId ||
      !payload.projectUuid ||
      !payload.targetSessionId
    ) {
      return null;
    }

    const project = await this.getProjectPayloadByUuid(
      payload.sessionId,
      payload.projectUuid,
    );
    if (!project) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      projectUuid: payload.projectUuid,
      projectName: project.projectName,
      inviteToken: project.inviteToken,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.title ?? payload.targetSessionId,
      ...(payload.targetClientUuid
        ? { targetClientUuid: payload.targetClientUuid }
        : {}),
      ...(payload.targetLocalSessionId
        ? { targetLocalSessionId: payload.targetLocalSessionId }
        : {}),
      ...(payload.filePath ? { filePath: payload.filePath } : {}),
    };
  }

  private async getPartnerFileTargetPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    filePath: string;
  } | null> {
    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "partner-file-target" ||
      !payload.sessionId ||
      !payload.targetSessionId ||
      !payload.filePath
    ) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.title ?? payload.targetSessionId,
      filePath: payload.filePath,
    };
  }

  private extractCallbackSuffix(
    ctx: TelegramMenuContext,
    prefix: string,
  ): string | null {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith(prefix)) {
      return null;
    }
    return data.slice(prefix.length) || null;
  }

  private async handleProjectSetCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const projectUuid = this.extractCallbackSuffix(ctx, "project-set:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: "Некорректное действие проекта.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Проект не найден.",
        show_alert: true,
      });
      return;
    }

    await this.activateProjectForSession({
      principal,
      sessionId,
      projectUuid: payload.projectUuid,
      projectName: payload.projectName,
    });
    await ctx.answerCallbackQuery({ text: "Открываю участников проекта." });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectDetailCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const projectUuid = this.extractCallbackSuffix(ctx, "project-detail:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: "Некорректное действие проекта.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Проект не найден.",
        show_alert: true,
      });
      return;
    }

    await this.ensureOpenedProjectIsActive({
      principal,
      sessionId,
      projectUuid: payload.projectUuid,
      projectName: payload.projectName,
    });
    await ctx.answerCallbackQuery({ text: "Открываю участников проекта." });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectMemberOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = this.extractCallbackSuffix(ctx, "project-member-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Некорректные данные участника проекта.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Данные участника проекта некорректны или устарели.",
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (payload.filePath) {
      await this.beginFileHandoffModeForTarget(ctx, {
        sessionId: payload.sessionId,
        filePath: payload.filePath,
        targetSessionId: payload.targetSessionId,
        targetSessionLabel: payload.targetSessionLabel,
        projectUuid: payload.projectUuid,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Открываю сессию." });
    await this.showProjectMemberDetail(ctx, payload);
  }

  private async handleProjectMemberNoteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^project-member-note:(question|reply|handoff|share):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({
        text: "Некорректное действие для участника проекта.",
        show_alert: true,
      });
      return;
    }

    const [, kind, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Некорректные данные участника проекта.",
        show_alert: true,
      });
      return;
    }
    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Данные участника проекта некорректны или устарели.",
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    await this.beginPartnerNoteMode(ctx, kind as PartnerNoteKind, {
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.targetSessionLabel,
      projectUuid: payload.projectUuid,
    });
  }

  private async handleProjectMemberFilesCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = this.extractCallbackSuffix(ctx, "project-member-files:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Некорректные данные участника проекта.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Данные участника проекта некорректны или устарели.",
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Открываю файлы." });
    await this.showProjectMemberFiles(ctx, payload);
  }

  private async handlePartnerFileOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = this.extractCallbackSuffix(ctx, "partner-file-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Некорректные данные файла.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getPartnerFileTargetPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Данные файла устарели.",
        show_alert: true,
      });
      return;
    }

    await this.beginFileHandoffModeForTarget(ctx, {
      sessionId: payload.sessionId,
      filePath: payload.filePath,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.targetSessionLabel,
    });
  }

  private async handleProjectMembersCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const projectUuid = this.extractCallbackSuffix(ctx, "project-members:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: "Некорректное действие проекта.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Проект не найден.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Загружаю участников." });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectLeaveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const projectUuid = this.extractCallbackSuffix(ctx, "project-leave:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: "Некорректное действие проекта.",
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: "Активная сессия не выбрана.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    const clientUuid = await this.ensureGatewayClientUuid(principal);
    await this.callGatewayJson("/projects/leave", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });

    if (session?.activeProjectUuid === projectUuid) {
      await this.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }

    await ctx.answerCallbackQuery({ text: "Выход из проекта выполнен." });
    await this.showProjectsMenu(ctx, "Вы вышли из выбранного проекта.");
  }

  private async deletePendingFileHandoffPrompt(
    ctx: TelegramMenuContext,
    pending: PendingFileHandoffRecord,
  ): Promise<void> {
    if (!pending.promptMessageId) {
      return;
    }

    try {
      await this.deleteMessage(ctx.chat!.id, pending.promptMessageId);
    } catch (error) {
      this.logger.warn("Failed to delete pending file handoff prompt", {
        sessionId: pending.sessionId,
        promptMessageId: pending.promptMessageId,
        target: pending.target,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async cancelPendingFileHandoff(
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

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingFileHandoffs.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "No pending file handoff prompt.",
        show_alert: true,
      });
      return;
    }

    this.pendingFileHandoffs.delete(principalKey);
    await this.deletePendingFileHandoffPrompt(ctx, pending);
    await ctx.answerCallbackQuery({ text: "File handoff cancelled." });
    if (pending.projectUuid && pending.targetSessionId && pending.targetSessionLabel) {
      const project = await this.getProjectPayloadByUuid(
        pending.sessionId,
        pending.projectUuid,
      );
      if (project) {
        await this.showProjectMemberDetail(ctx, {
          sessionId: pending.sessionId,
          projectUuid: pending.projectUuid,
          projectName: project.projectName,
          inviteToken: project.inviteToken,
          targetSessionId: pending.targetSessionId,
          targetSessionLabel: pending.targetSessionLabel,
        });
        return;
      }
    }

    if (pending.target === "partner") {
      await this.showPartnerMenu(ctx);
      return;
    }

    await this.showLocalMenu(ctx);
  }

  private async deliverFileToAgent(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    filePath: string;
    sourceTelegramMessageId: number;
    description: string;
  }): Promise<void> {
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const session = await this.sessionStore.getSession(input.sessionId);
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
        ? await this.objectStore.ensureLocalFile({
            sessionId: input.sessionId,
            session,
            filePath: input.filePath,
            relativePath: relativeArtifactPath,
            storageRef: meta.storageRef,
            source: "partner-artifact",
          })
        : input.filePath;

    const workspaceDir = this.objectStore.resolveWorkspaceDir(session);
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
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      relativeNotePath,
      Buffer.from(noteContent, "utf8"),
    );
    await writeXchangeRelativeFile(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
      LOCAL_INDEX_FILE_NAME,
      Buffer.from(
        `${buildLocalIndexLine({
          createdAt,
          summary: handoffSummary,
          relativeNotePath,
        })}\n`,
        "utf8",
      ),
      { append: true },
    );

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId: input.sessionId,
      telegramChatId: input.principal.telegramChatId,
      telegramUserId: input.principal.telegramUserId,
      sourceTelegramMessageId: input.sourceTelegramMessageId,
      text: [
        "Получен локальный handoff файла.",
        `Кратко: ${handoffSummary}`,
        "",
        `Immediate action: read ${LOCAL_INDEX_FILE_NAME} and then open the note below.`,
        `Note: ${notePath}`,
        "",
        "Artifacts:",
        `- ${ensuredFilePath}`,
      ].join("\n"),
      attachments: [notePath, ensuredFilePath],
      receivedAt: createdAt,
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    try {
      await this.nudgeSessionInbox(input.sessionId);
    } catch (error) {
      this.logger.warn("tmux nudge failed after local agent handoff", {
        sessionId: input.sessionId,
        handoffId,
        filePath: ensuredFilePath,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private async deliverFileToPartner(input: {
    sessionId: string;
    filePath: string;
    description: string;
    targetSessionId?: string;
    projectUuid?: string;
  }): Promise<SendPartnerNoteOutput> {
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      input.sessionId,
      input.filePath,
    );
    const session = await this.sessionStore.getSession(input.sessionId);
    const fileName =
      meta?.originalName ||
      (meta?.relativePath ? path.basename(meta.relativePath) : undefined) ||
      path.basename(input.filePath);
    const localFilePath = await this.objectStore.ensureLocalFile({
      sessionId: input.sessionId,
      session,
      filePath: input.filePath,
      relativePath: meta?.relativePath,
      storageRef: meta?.storageRef,
      source: meta?.source ?? "telegram-upload",
    });
    const fileContent = await readWorkspaceFile(
      this.config.tmux,
      this.objectStore.resolveWorkspaceDir(session),
      localFilePath,
    );
    const handoffSummary =
      input.description
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? `Передача файла: ${fileName}`;

    return this.sendPartnerNote({
      session_id: input.sessionId,
      ...(input.targetSessionId ? { target_session_id: input.targetSessionId } : {}),
      ...(input.projectUuid ? { project_uuid: input.projectUuid } : {}),
      kind: "handoff",
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
          ...(meta?.originalName
            ? { original_name: meta.originalName }
            : { original_name: fileName }),
          ...(meta?.mimeType ? { mime_type: meta.mimeType } : {}),
          ...(typeof meta?.sizeBytes === "number"
            ? { size_bytes: meta.sizeBytes }
            : {}),
          content_base64: Buffer.from(fileContent).toString("base64"),
        },
      ],
    });
  }

  private async handlePendingPartnerNote(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingPartnerNotes.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingPartnerNotes.delete(principalKey);
      await this.deletePendingPartnerNotePrompt(ctx, pending);
      return false;
    }

    const parsed = this.parsePartnerNoteText(text);
    const sourceSession = await this.sessionStore.getSession(pending.sessionId);
    const sourceLabel = sourceSession?.label ?? pending.sessionId;
    let resolvedTargetLabel = pending.targetSessionLabel;
    if (!resolvedTargetLabel && sourceSession?.linkedSessionId) {
      const linkedSession = await this.sessionStore.getSession(
        sourceSession.linkedSessionId,
      );
      resolvedTargetLabel =
        linkedSession?.label ?? sourceSession.linkedSessionId ?? "напарник";
    }
    const targetLabel = resolvedTargetLabel ?? "напарник";

    this.pendingPartnerNotes.delete(principalKey);
    await this.deletePendingPartnerNotePrompt(ctx, pending);
    if (isExecutorTargetKind(pending.kind)) {
      if (pending.projectUuid) {
        await this.ensureProjectSessionRegistered({
          principal,
          sessionId: pending.sessionId,
          projectUuid: pending.projectUuid,
        });
      }
      const delegatedMessage = [
        `Пользователь из Telegram просит тебя выполнить задачу для сессии ${sourceLabel}.`,
        `Маршрут результата: ${targetLabel} -> ${sourceLabel}`,
        "",
        "Задача:",
        parsed.message,
      ].join("\n");
      const expectedReply = [
        `Подготовь результат для сессии ${sourceLabel}.`,
        "Когда будешь готов, отправь его обратно через send_partner_note.",
      ].join(" ");
      const output = await this.sendPartnerNote({
        session_id: pending.sessionId,
        ...(pending.targetSessionId
          ? { target_session_id: pending.targetSessionId }
          : {}),
        ...(pending.projectUuid ? { project_uuid: pending.projectUuid } : {}),
        kind: pending.kind,
        summary: parsed.summary,
        message: delegatedMessage,
        expected_reply: expectedReply,
        requires_reply: true,
      });
      const sent = await this.replyText(
        ctx,
        [
          "Задача отправлена выбранной сессии.",
          ...(output.project_name ? [`Проект: ${output.project_name}`] : []),
          ...(output.target_actor_label ? [`Исполнитель: ${output.target_actor_label}`] : []),
          `Маршрут результата: ${targetLabel} -> ${sourceLabel}`,
          `Тип: ${pending.kind}`,
          `Кратко: ${parsed.summary}`,
          `Статус: ${output.delivery_status === "delivered" ? "доставлено" : "в очереди"}`,
          `Share: ${output.share_id}`,
        ].join("\n"),
        { kind: "menu", sessionId: pending.sessionId },
      );
      if (
        output.delivery_status === "queued" &&
        sent &&
        "message_id" in sent &&
        ctx.chat
      ) {
        await this.maintenanceStore.setOutgoingDeliveryNotice({
          deliveryUuid: output.inbox_message_id,
          sessionId: pending.sessionId,
          telegramChatId: ctx.chat.id,
          telegramMessageId: sent.message_id,
          shareId: output.share_id,
          kind: output.kind,
          summary: parsed.summary,
          ...(output.project_name ? { projectName: output.project_name } : {}),
          ...(output.target_actor_label
            ? { targetLabel: output.target_actor_label }
            : { targetLabel }),
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
      ...(pending.targetSessionId
        ? { targetSessionId: pending.targetSessionId }
        : {}),
      ...(pending.targetSessionLabel
        ? { targetSessionLabel: pending.targetSessionLabel }
        : {}),
      ...(pending.projectUuid ? { projectUuid: pending.projectUuid } : {}),
    });
    await this.replyText(
      ctx,
      [
        "Задача поставлена в inbox текущей сессии.",
        `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${pending.kind}`,
        `Кратко: ${parsed.summary}`,
        "Текущая сессия подготовит результат и отправит его сама.",
      ].join("\n"),
      { kind: "menu", sessionId: pending.sessionId },
    );
    return true;
  }

  private async enqueuePartnerNoteInstruction(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sourceTelegramMessageId: number;
    kind: PartnerNoteKind;
    summary: string;
    message: string;
    targetSessionId?: string;
    targetSessionLabel?: string;
    projectUuid?: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.sessionId);
    const sourceLabel = session?.label ?? input.sessionId;
    const targetLabel = input.targetSessionLabel ?? input.targetSessionId ?? "напарник";
    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId: input.sessionId,
      telegramChatId: input.principal.telegramChatId,
      telegramUserId: input.principal.telegramUserId,
      sourceTelegramMessageId: input.sourceTelegramMessageId,
      text: [
        "Пользователь просит текущую сессию подготовить сообщение для другой сессии.",
        `Маршрут отправки: ${sourceLabel} -> ${targetLabel}`,
        `Тип: ${input.kind}`,
        `Кратко: ${input.summary}`,
        ...(input.projectUuid ? [`Проект UUID: ${input.projectUuid}`] : []),
        ...(input.targetSessionId
          ? [`Target session ID: ${input.targetSessionId}`]
          : []),
        "",
        "Содержимое для отправки:",
        input.message,
        "",
        "Не используй linked partner для отправки. Передай target_session_id явно в send_partner_note.",
        "Когда будешь готов, используй send_partner_note.",
      ].join("\n"),
      receivedAt: new Date().toISOString(),
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    await this.nudgeSessionInbox(input.sessionId);
  }

  private async handlePendingFileHandoff(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingFileHandoffs.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingFileHandoffs.delete(principalKey);
      await this.deletePendingFileHandoffPrompt(ctx, pending);
      return false;
    }

    const description = text.trim();
    if (!description) {
      return true;
    }

    if (pending.target === "agent") {
      await this.deliverFileToAgent({
        principal,
        sessionId: pending.sessionId,
        filePath: pending.filePath,
        sourceTelegramMessageId: ctx.message?.message_id ?? 0,
        description,
      });
      this.pendingFileHandoffs.delete(principalKey);
      await this.deletePendingFileHandoffPrompt(ctx, pending);
      await this.replyText(
        ctx,
        "Файл передан агенту.",
        { kind: "menu", sessionId: pending.sessionId },
      );
      return true;
    }

    if (pending.projectUuid) {
      await this.ensureProjectSessionRegistered({
        principal,
        sessionId: pending.sessionId,
        projectUuid: pending.projectUuid,
      });
    }

    const output = await this.deliverFileToPartner({
      sessionId: pending.sessionId,
      filePath: pending.filePath,
      description,
      ...(pending.targetSessionId
        ? { targetSessionId: pending.targetSessionId }
        : {}),
      ...(pending.projectUuid ? { projectUuid: pending.projectUuid } : {}),
    });
    this.pendingFileHandoffs.delete(principalKey);
    await this.deletePendingFileHandoffPrompt(ctx, pending);
    const sent = await this.replyText(
      ctx,
      [
        "Файл поставлен в очередь доставки напарнику.",
        ...(output.project_name ? [`Проект: ${output.project_name}`] : []),
        ...(output.target_actor_label ? [`Получатель: ${output.target_actor_label}`] : []),
        ...(output.target_session_label ? [`Сессия: ${output.target_session_label}`] : []),
        `Статус: ${output.delivery_status === "delivered" ? "доставлено" : "в очереди"}`,
        `Share: ${output.share_id}`,
      ].join("\n"),
      { kind: "menu", sessionId: pending.sessionId },
    );
    if (
      output.delivery_status === "queued" &&
      sent &&
      "message_id" in sent &&
      ctx.chat
    ) {
      const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
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
      await this.maintenanceStore.setOutgoingDeliveryNotice({
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
        ...(output.target_session_label
          ? { targetSessionLabel: output.target_session_label }
          : {}),
      });
    }
    return true;
  }

  private async handlePendingProject(
    ctx: TelegramMenuContext,
    text: string,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return false;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingProjects.get(principalKey);
    if (!pending) {
      return false;
    }

    if (text.startsWith("/")) {
      this.pendingProjects.delete(principalKey);
      return false;
    }

    const value = text.trim();
    if (!value) {
      return true;
    }

    const clientUuid = await this.ensureGatewayClientUuid(principal);
    let projectName = "";
    let projectUuid = "";

    if (pending.mode === "create") {
      const created = await this.callGatewayJson<{
        project_uuid: string;
        invite_token: string;
        name: string;
      }>("/projects/create", {
        client_uuid: clientUuid,
        name: value,
      });
      projectUuid = created.project_uuid;
      projectName = created.name;
      await this.activateProjectForSession({
        principal,
        sessionId: pending.sessionId,
        projectUuid,
        projectName,
      });
      await this.replyText(
        ctx,
        `Проект создан: ${projectName}\nInvite: ${created.invite_token}`,
        { kind: "menu", sessionId: pending.sessionId },
      );
    } else {
      const joined = await this.callGatewayJson<{
        project_uuid: string;
        invite_token: string;
        name: string;
      }>("/projects/join", {
        client_uuid: clientUuid,
        invite_token: value,
      });
      projectUuid = joined.project_uuid;
      projectName = joined.name;
      await this.activateProjectForSession({
        principal,
        sessionId: pending.sessionId,
        projectUuid,
        projectName,
      });
      await this.replyText(
        ctx,
        `Вход в проект выполнен: ${projectName}`,
        { kind: "menu", sessionId: pending.sessionId },
      );
    }

    this.pendingProjects.delete(principalKey);
    await this.showProjectsMenu(ctx, `Открыт проект: ${projectName}`);
    return true;
  }
}
