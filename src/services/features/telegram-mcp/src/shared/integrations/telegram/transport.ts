import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { Menu, MenuRange, type MenuFlavor } from "@grammyjs/menu";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import {
  buildLiveRelaySessionId,
  parseLiveRelaySessionId,
  resolveGatewayWebAppBaseUrl,
} from "../../../app/webapp/relay";
import type { CollaborationService } from "../../../features/collaboration/model/collaborationService";
import type {
  PartnerNoteKind,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type {
  TelegramInboxMessage,
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type {
  SessionStore,
  TelegramAdminAuthStore,
  SessionBindingStore,
  TelegramInboxStore,
  TelegramMenuPayloadStore,
  TelegramUserLocaleStore,
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
import {
  isExecutorTargetKind,
} from "./collabSemantics";
import {
  buildPartnerNotePromptText,
  buildProjectMemberDetailText,
} from "./collabUi";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";
import { createTelegramFetch } from "./proxyFetch";
import {
  captureVisibleTmuxPane,
  captureTmuxPaneRange,
  deleteXchangeFile,
  getTmuxWindowHeight,
  isTmuxTargetInvalidError,
  isTmuxUnavailableError,
  listXchangeFiles,
  readWorkspaceFile,
  resolveTmuxTargetFromHint,
  sendTmuxLiteralLine,
  writeXchangeRelativeFile,
} from "../tmux/client";
import {
  TELLYMCP_PACKAGE_NAME,
  TELLYMCP_PROTOCOL_VERSION,
  detectAvailablePackageUpdate,
  getTellyMcpPackageVersion,
} from "../../lib/version/versionHandshake";
import {
  normalizeLocale,
  translate,
  type SupportedLocale,
} from "../../i18n";
import {
  detectTmuxInteractivePrompt,
  type TmuxPromptDetection,
} from "../../lib/tmuxPromptDetection";
import {
  buildLocalHandoffActionDesc,
  buildLocalHandoffTools,
} from "../../lib/xchangeRecordHints";
import { upsertXchangeRecord } from "../xchange/sqliteRecordStore";

type WaiterRecord = {
  requestId: string;
  telegramChatId: number;
  telegramUserId: number;
  telegramMessageId: number;
  sentAtMs: number;
  sourceClientUuid?: string;
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
  scope: "linked" | "project";
  sessionId?: string;
  projectUuid?: string;
  projectName?: string;
  localTargetSessionIds?: string[];
  remoteTargets?: PendingProjectBroadcastRemoteTarget[];
};

type PendingProjectBroadcastRemoteTarget = {
  sessionUuid: string;
  sessionLabel: string;
  clientUuid: string;
  localSessionId: string;
  projectUuid: string;
  projectName?: string;
};

type LiveApprovalEventPayload = {
  project_uuid?: string;
  project_name?: string;
  source_session_id: string;
  source_session_label: string;
  source_client_uuid: string;
  source_local_session_id: string;
  target_session_id: string;
  target_session_label: string;
  target_client_uuid: string;
  target_local_session_id: string;
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

type GatewayClientRecord = {
  client_uuid: string;
  client_label: string | null;
  namespace?: string | null;
  node_id?: string | null;
  telegram_username: string | null;
  telegram_display_name: string | null;
  bot_username: string | null;
  last_seen_at?: string;
  updated_at?: string;
  session_count?: number;
};

type GatewayClientSessionRecord = {
  session_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  project_uuid?: string;
  project_name?: string | null;
  updated_at?: string;
};

type GatewayConnectedClientSessionTool = {
  local_session_id: string;
  session_label?: string;
  tools_hash?: string;
};

type AdminGatewayRegistrationSessionRecord = {
  local_session_id: string;
  session_label?: string;
};

type GatewayConnectedClientRecord = {
  client_uuid: string;
  namespace?: string;
  node_id?: string;
  package_version?: string;
  protocol_version?: string;
  session_tools: GatewayConnectedClientSessionTool[];
  capabilities: string[];
};

type AdminClientViewRecord = GatewayClientRecord & {
  is_connected?: boolean;
  is_registered?: boolean;
  connected_session_count?: number;
  connected_session_labels?: string[];
};

type AdminClientSessionViewRecord = {
  session_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  project_uuid?: string;
  project_name?: string | null;
  updated_at?: string;
  is_connected?: boolean;
  is_collab?: boolean;
};

type GatewayRelayBindingPayload = {
  sessionId: string;
  targetSessionId: string;
  targetSessionLabel: string;
  targetClientUuid: string;
  targetLocalSessionId: string;
  projectUuid?: string;
  projectName?: string;
};

type GatewayActorProfile = {
  telegramUsername?: string;
  telegramFirstName?: string;
  telegramLastName?: string;
  telegramDisplayName?: string;
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

type WebAppLaunchMode = "default" | "expand" | "fullscreen";
const TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;
const TMUX_PROMPT_SCAN_MATCHED_LINES_LIMIT = 6;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeBasePath(value: string): string {
  const trimmed = trimTrailingSlashes(value.trim());
  return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed || ""}`;
}

function joinHttpPath(prefix: string, suffix: string): string {
  const normalizedPrefix = prefix ? normalizeBasePath(prefix) : "";
  const normalizedSuffix = normalizeBasePath(suffix);

  if (!normalizedPrefix || normalizedPrefix === "/") {
    return normalizedSuffix;
  }

  return `${normalizedPrefix}${normalizedSuffix}`.replace(/\/{2,}/gu, "/");
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

function resolveGatewayControlBaseUrl(config: AppConfig): string | null {
  if (
    config.distributed.mode === "gateway" ||
    config.distributed.mode === "both"
  ) {
    const runtimePort = Number(process.env.PORT || config.mcp.httpPort);
    const rootPrefix = normalizeBasePath(process.env.ROOT_PREFIX || "/api");
    const gatewayPath = joinHttpPath(rootPrefix, "/gateway");
    return trimTrailingSlashes(`http://127.0.0.1:${runtimePort}${gatewayPath}`);
  }

  if (!config.distributed.gatewayPublicUrl) {
    return null;
  }

  const url = new URL(config.distributed.gatewayPublicUrl);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }
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

function parseAdminAuthCommand(text: string): string | null {
  const match = text.trim().match(/^\/auth(?:@\w+)?(?:\s+(.+))?$/i);
  return match?.[1]?.trim() || null;
}

function isGatewayLinkCommand(text: string): boolean {
  return /^\/link(?:@\w+)?$/i.test(text.trim());
}

function isGatewayAdminCommand(text: string): boolean {
  return /^\/admin(?:@\w+)?$/i.test(text.trim());
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
  _config: AppConfig,
  error: unknown,
  fallback: string,
): string {
  if (isTmuxUnavailableError(error)) {
    return "tmux is unavailable right now.";
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
  private readonly adminMainMenu: Menu<TelegramMenuContext>;
  private readonly adminClientsMenu: Menu<TelegramMenuContext>;
  private readonly adminClientSessionsMenu: Menu<TelegramMenuContext>;
  private readonly adminClientSessionDetailMenu: Menu<TelegramMenuContext>;
  private readonly adminToolsMenu: Menu<TelegramMenuContext>;
  private readonly inboxMenu: Menu<TelegramMenuContext>;
  private readonly storageMenu: Menu<TelegramMenuContext>;
  private readonly browserMenu: Menu<TelegramMenuContext>;
  private readonly projectsMenu: Menu<TelegramMenuContext>;
  private readonly collabToolsMenu: Menu<TelegramMenuContext>;
  private readonly collabDeleteMenu: Menu<TelegramMenuContext>;
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
  private readonly storageMessageMenu: Menu<TelegramMenuContext>;
  private readonly screenshotMessageMenu: Menu<TelegramMenuContext>;
  private readonly waiters = new Map<string, WaiterRecord>();
  private readonly tmuxNudgeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly tmuxNudgeFailureNoticeAt = new Map<string, number>();
  private readonly tmuxPromptNoticeState = new Map<
    string,
    { fingerprint: string; sentAtMs: number }
  >();
  private readonly pendingRenames = new Map<string, PendingRenameRecord>();
  private readonly pendingBroadcasts = new Map<string, PendingBroadcastRecord>();
  private readonly pendingPartnerNotes = new Map<string, PendingPartnerNoteRecord>();
  private readonly pendingFileHandoffs = new Map<string, PendingFileHandoffRecord>();
  private readonly pendingProjects = new Map<string, PendingProjectRecord>();
  private readonly adminClientViewByPrincipal = new Map<string, AdminClientViewRecord>();
  private readonly currentAttachmentTargets = new Map<
    string,
    CurrentAttachmentTargetRecord
  >();
  private started = false;
  private pollingTask: Promise<void> | undefined;
  private collaborationService?: CollaborationService;
  private tmuxPromptScanTimer: NodeJS.Timeout | undefined;
  private tmuxPromptScanInFlight = false;

  private isTelegramEnabled(): boolean {
    return Boolean(this.config.telegram.botToken?.trim());
  }

  private ensureTelegramEnabledFor(action: string): void {
    if (this.isTelegramEnabled()) {
      return;
    }

    throw new Error(
      `Telegram transport is disabled for this node; cannot ${action}.`,
    );
  }

  private getRequiredBotToken(action: string): string {
    this.ensureTelegramEnabledFor(action);
    return this.config.telegram.botToken!.trim();
  }

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
          text: await this.tForContext(ctx, "common:menu.refreshed"),
        });
        await handler(ctx);
      },
    };
  }

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly adminAuthStore: TelegramAdminAuthStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly inboxStore: TelegramInboxStore,
    private readonly menuPayloadStore: TelegramMenuPayloadStore,
    private readonly localeStore: TelegramUserLocaleStore,
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

    this.bot = new Bot<TelegramMenuContext>(
      this.config.telegram.botToken ?? "0:disabled",
      {
      client: {
        fetch: this.telegramFetch,
      },
    });
    this.mainMenu = this.createMainMenu();
    this.adminMainMenu = this.createAdminMainMenu();
    this.adminClientsMenu = this.createAdminClientsMenu();
    this.adminClientSessionsMenu = this.createAdminClientSessionsMenu();
    this.adminClientSessionDetailMenu = this.createAdminClientSessionDetailMenu();
    this.adminToolsMenu = this.createAdminToolsMenu();
    this.inboxMenu = this.createInboxMenu();
    this.storageMenu = this.createStorageMenu();
    this.browserMenu = this.createBrowserMenu();
    this.projectsMenu = this.createProjectsMenu();
    this.collabToolsMenu = this.createCollabToolsMenu();
    this.collabDeleteMenu = this.createCollabDeleteMenu();
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
    this.storageMessageMenu = this.createStorageMessageMenu();
    this.screenshotMessageMenu = this.createScreenshotMessageMenu();
    this.mainMenu.register([
      this.adminMainMenu,
      this.inboxMenu,
      this.storageMenu,
      this.browserMenu,
      this.projectsMenu,
      this.collabToolsMenu,
      this.collabDeleteMenu,
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
      this.storageMessageMenu,
      this.screenshotMessageMenu,
    ]);
    this.adminMainMenu.register([
      this.adminClientsMenu,
      this.adminClientSessionsMenu,
      this.adminClientSessionDetailMenu,
      this.adminToolsMenu,
    ]);
    this.bot.use(async (ctx, next) => {
      await this.handleAdminAccessMiddleware(ctx, next);
    });
    this.bot.use(this.getRootMenu());
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
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:partner.actions.back_to_partner"),
      });
      await this.showPartnerMenu(ctx);
    });
    this.bot.callbackQuery("file-handoff-cancel", async (ctx) => {
      await this.cancelPendingFileHandoff(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-live:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionLiveCallback(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-bind:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionBindCallback(ctx);
    });
    this.bot.callbackQuery(/^admin-client-session-open:(.+)$/u, async (ctx) => {
      await this.handleAdminClientSessionOpenCallback(ctx);
    });
    this.bot.callbackQuery("admin-client-sessions-collab", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
      });
      await this.showAdminClientSessionList(ctx, "collab");
    });
    this.bot.callbackQuery("admin-client-sessions-all", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
      });
      await this.showAdminClientSessionList(ctx, "all");
    });
    this.bot.callbackQuery("admin-client-sessions-back", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.back_to_client_sessions"),
      });
      await this.showAdminClientSessionsMenu(ctx);
    });
    this.bot.callbackQuery("admin-client-session-list-back", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.actions.back_to_client_sessions"),
      });
      await this.showAdminClientSessionsMenu(ctx);
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
    this.bot.callbackQuery(/^project-member-note:(question|share):(.+)$/u, async (ctx) => {
      await this.handleProjectMemberNoteCallback(ctx);
    });
    this.bot.callbackQuery(/^project-member-live:(.+)$/u, async (ctx) => {
      await this.handleProjectMemberLiveCallback(ctx);
    });
    this.bot.callbackQuery(/^live-approval:(approve|deny):(.+)$/u, async (ctx) => {
      await this.handleLiveApprovalCallback(ctx);
    });
    this.bot.callbackQuery(/^project-detail:(.+)$/u, async (ctx) => {
      await this.handleProjectDetailCallback(ctx);
    });
    this.bot.callbackQuery(/^project-delete:(.+)$/u, async (ctx) => {
      await this.handleProjectDeleteCallback(ctx);
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

  private isAdminAuthEnabled(): boolean {
    return Boolean(this.config.telegram.adminToken?.trim());
  }

  private isAdminBotProfile(): boolean {
    return this.isAdminAuthEnabled();
  }

  private getRootMenu(): Menu<TelegramMenuContext> {
    return this.mainMenu;
  }

  private async isPrincipalAdminAuthorized(
    principal: { telegramChatId: number; telegramUserId: number } | null,
  ): Promise<boolean> {
    if (!this.isAdminAuthEnabled()) {
      return true;
    }

    if (!principal) {
      return false;
    }

    return this.adminAuthStore.isAdminAuthorized(principal);
  }

  private async handleAdminAccessMiddleware(
    ctx: TelegramMenuContext,
    next: () => Promise<void>,
  ): Promise<void> {
    if (!this.isAdminAuthEnabled()) {
      await next();
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    const authorized = await this.isPrincipalAdminAuthorized(principal);
    if (authorized) {
      await next();
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:admin.auth.required_callback"),
        show_alert: true,
      });
      return;
    }

    const text = this.extractIncomingText(ctx.message);
    const token = text ? parseAdminAuthCommand(text) : null;
    if (principal && token) {
      await this.handleAdminAuthCommand(ctx, principal, token);
      return;
    }

    if (text && isGatewayAdminCommand(text)) {
      await this.replyText(
        ctx,
        await this.tForContext(ctx, "menu:admin.auth.prompt"),
        {
          kind: "transport",
        },
      );
      return;
    }

    await next();
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
    const baseUrl = resolveGatewayControlBaseUrl(this.config);
    if (!baseUrl) {
      throw new Error("Gateway is not configured.");
    }

    const url = new URL(baseUrl);
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
      ...(this.config.distributed.gatewayToken
        ? { gateway_token: this.config.distributed.gatewayToken }
        : {}),
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

  private async listGatewayClients(): Promise<GatewayClientRecord[]> {
    this.logger.info("Telegram admin requested gateway clients list", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.config),
    });
    const response = await this.callGatewayJson<{
      clients: GatewayClientRecord[];
    }>("/clients/list", {});
    const clients = Array.isArray(response.clients) ? response.clients : [];
    this.logger.info("Telegram admin received gateway clients list", {
      count: clients.length,
      clientUuids: clients.map((client) => client.client_uuid),
    });
    return clients;
  }

  private async listGatewayConnectedClients(): Promise<GatewayConnectedClientRecord[]> {
    this.logger.info("Telegram admin requested connected gateway clients list", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.config),
    });
    const response = await this.callGatewayJson<{
      clients: GatewayConnectedClientRecord[];
    }>("/clients/connected", {});
    const clients = Array.isArray(response.clients) ? response.clients : [];
    this.logger.info("Telegram admin received connected gateway clients list", {
      count: clients.length,
      clientUuids: clients.map((client) => client.client_uuid),
    });
    return clients;
  }

  private async listGatewayAdminClients(): Promise<AdminClientViewRecord[]> {
    const [registeredClients, connectedClients] = await Promise.all([
      this.listGatewayClients(),
      this.listGatewayConnectedClients(),
    ]);

    const merged = new Map<string, AdminClientViewRecord>();

    for (const client of registeredClients) {
      merged.set(client.client_uuid, {
        ...client,
        is_registered: true,
      });
    }

    for (const client of connectedClients) {
      const existing = merged.get(client.client_uuid);
      const connectedSessionLabels = client.session_tools
        .map((item) => item.session_label?.trim() || item.local_session_id.trim())
        .filter(Boolean)
        .slice(0, 3);

      merged.set(client.client_uuid, {
        client_uuid: client.client_uuid,
        client_label: existing?.client_label ?? null,
        namespace: existing?.namespace ?? client.namespace ?? null,
        node_id: existing?.node_id ?? client.node_id ?? null,
        telegram_username: existing?.telegram_username ?? null,
        telegram_display_name: existing?.telegram_display_name ?? null,
        bot_username: existing?.bot_username ?? null,
        ...(existing?.last_seen_at ? { last_seen_at: existing.last_seen_at } : {}),
        ...(existing?.updated_at ? { updated_at: existing.updated_at } : {}),
        ...(typeof existing?.session_count === "number"
          ? { session_count: existing.session_count }
          : {}),
        is_registered: existing?.is_registered ?? false,
        is_connected: true,
        connected_session_count: client.session_tools.length,
        connected_session_labels: connectedSessionLabels,
      });
    }

    return Array.from(merged.values()).sort((left, right) =>
      this.buildAdminClientTitle(left).localeCompare(this.buildAdminClientTitle(right)),
    );
  }

  private async listGatewayClientSessions(
    clientUuid: string,
  ): Promise<GatewayClientSessionRecord[]> {
    this.logger.info("Telegram admin requested gateway client sessions", {
      gatewayBaseUrl: resolveGatewayControlBaseUrl(this.config),
      clientUuid,
    });
    const response = await this.callGatewayJson<{
      sessions: GatewayClientSessionRecord[];
    }>("/clients/sessions", {
      client_uuid: clientUuid,
    });
    const sessions = Array.isArray(response.sessions) ? response.sessions : [];
    this.logger.info("Telegram admin received gateway client sessions", {
      clientUuid,
      count: sessions.length,
      localSessionIds: sessions.map((session) => session.local_session_id),
    });
    return sessions;
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

  private async listGatewaySessionHistory(
    principal: { telegramChatId: number; telegramUserId: number },
    localSessionId: string,
  ): Promise<
    Array<{
      message_uuid: string;
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_uuid?: string;
      project_name?: string;
      from_session_id: string;
      from_label: string;
      to_session_id: string;
      to_label: string;
      delivery_status?: string;
    }>
  > {
    const clientUuid = await this.ensureGatewayClientUuid(principal);
    const response = await this.callGatewayJson<{
      history: Array<{
        message_uuid: string;
        kind: string;
        summary: string;
        created_at: string;
        direction: "outgoing" | "incoming";
        project_uuid?: string;
        project_name?: string;
        from_session_id: string;
        from_label: string;
        to_session_id: string;
        to_label: string;
        delivery_status?: string;
      }>;
    }>("/history/list", {
      client_uuid: clientUuid,
      local_session_id: localSessionId,
      limit: 5,
    });
    return Array.isArray(response.history) ? response.history : [];
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

    if (!this.isTelegramEnabled()) {
      this.logger.info(
        "Telegram transport is disabled for this node; skipping bot startup",
        {
          distributedMode: this.config.distributed.mode,
        },
      );
      this.started = true;
      this.startTmuxPromptScan();
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
      ...(this.isAdminAuthEnabled()
        ? [{ command: "auth", description: "Authenticate as gateway admin" }]
        : []),
      ...(this.isAdminBotProfile()
        ? [
            { command: "link", description: "Open gateway clients list" },
            { command: "admin", description: "Open gateway admin menu" },
          ]
        : []),
      { command: "menu", description: "Open session menu" },
      { command: "help", description: "Show help" },
    ]);
    this.logger.info("Telegram bot commands registered", {
      commands: [
        ...(this.isAdminAuthEnabled() ? ["/auth"] : []),
        ...(this.isAdminBotProfile() ? ["/link", "/admin"] : []),
        "/menu",
        "/help",
      ],
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
    this.startTmuxPromptScan();
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
    this.clearTmuxPromptScanTimer();
    if (this.isTelegramEnabled()) {
      await this.bot.stop();
    }
    this.started = false;
    this.pollingTask = undefined;
    this.logger.info("Telegram transport stopped");
  }

  public async deleteMessage(
    telegramChatId: number,
    telegramMessageId: number,
  ): Promise<void> {
    this.ensureTelegramEnabledFor("delete Telegram messages");
    await this.bot.api.deleteMessage(telegramChatId, telegramMessageId);
  }

  public async sendDocumentToChat(
    telegramChatId: number,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number }> {
    this.ensureTelegramEnabledFor("send Telegram documents");
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
    this.ensureTelegramEnabledFor("edit Telegram messages");
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
    if (!this.isTelegramEnabled()) {
      this.logger.debug(
        "Startup inbox nudge recovery skipped because Telegram transport is disabled",
      );
      return;
    }

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

  public async sendStartupNotifications(): Promise<void> {
    if (!this.isTelegramEnabled()) {
      this.logger.debug(
        "Startup notifications skipped because Telegram transport is disabled",
      );
      return;
    }

    const packageVersion = getTellyMcpPackageVersion(__dirname);
    const availableUpdate = await detectAvailablePackageUpdate({
      currentVersion: packageVersion,
    });
    if (availableUpdate) {
      this.logger.warn("A newer TellyMCP package version is available", {
        currentVersion: availableUpdate.currentVersion,
        latestVersion: availableUpdate.latestVersion,
        packageName: TELLYMCP_PACKAGE_NAME,
      });
    }
    const sessions = await this.sessionStore.listSessions();
    const groupedRecipients = new Map<
      string,
      {
        binding: { telegramChatId: number; telegramUserId: number };
        sessionIds: string[];
        sessionLabels: string[];
      }
    >();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding) {
        continue;
      }

      const key = `${binding.telegramChatId}:${binding.telegramUserId}`;
      const current = groupedRecipients.get(key);
      if (current) {
        current.sessionIds.push(session.sessionId);
        current.sessionLabels.push(session.label ?? session.sessionId);
        continue;
      }

      groupedRecipients.set(key, {
        binding: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        sessionIds: [session.sessionId],
        sessionLabels: [session.label ?? session.sessionId],
      });
    }

    if (groupedRecipients.size === 0) {
      this.logger.info("Skipping startup notifications because no Telegram sessions are paired");
      return;
    }

    const runtimePort =
      this.config.distributed.mode === "gateway" || this.config.distributed.mode === "both"
        ? Number(process.env.PORT || this.config.mcp.httpPort)
        : this.config.mcp.httpPort;
    const rootPrefix =
      this.config.distributed.mode === "gateway" || this.config.distributed.mode === "both"
        ? normalizeBasePath(process.env.ROOT_PREFIX || "/api")
        : "";
    const localMcpPath =
      this.config.distributed.mode === "gateway" || this.config.distributed.mode === "both"
        ? joinHttpPath(rootPrefix, this.config.mcp.httpPath)
        : this.config.mcp.httpPath;
    const localWebappPath =
      this.config.distributed.mode === "gateway" || this.config.distributed.mode === "both"
        ? joinHttpPath(rootPrefix, this.config.webapp.basePath)
        : this.config.webapp.basePath;
    const localMcpUrl = `http://${this.config.mcp.httpHost}:${runtimePort}${localMcpPath}`;
    const localWebappUrl = `http://${this.config.mcp.httpHost}:${runtimePort}${localWebappPath}`;

    for (const recipientGroup of groupedRecipients.values()) {
      const primarySessionId = recipientGroup.sessionIds[0];
      if (!primarySessionId) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        recipientGroup.binding.telegramUserId,
      );
      const uniqueSessionLabels = Array.from(new Set(recipientGroup.sessionLabels)).sort();
      const browserStatus = this.config.browser.enabled
        ? (this.config.browser.headless ? "enabled, headless" : "enabled, headed")
        : "disabled";
      const startupMessage = [
        this.t(locale, "menu:notices.startup.title"),
        this.t(locale, "menu:notices.startup.version", {
          packageVersion,
        }),
        this.t(locale, "menu:notices.startup.protocol", {
          protocolVersion: TELLYMCP_PROTOCOL_VERSION,
        }),
        this.t(locale, "menu:notices.startup.mode", {
          mode: this.config.distributed.mode,
        }),
        ...(this.config.telegram.botUsername
          ? [
              this.t(locale, "menu:notices.startup.bot", {
                botUsername: this.config.telegram.botUsername.replace(/^@/u, ""),
              }),
            ]
          : []),
        this.t(locale, "menu:notices.startup.sessions", {
          count: uniqueSessionLabels.length,
        }),
        this.t(locale, "menu:notices.startup.session_list", {
          sessions: uniqueSessionLabels.join(", "),
        }),
        this.t(locale, "menu:notices.startup.mcp", {
          url: localMcpUrl,
        }),
        ...(this.config.webapp.enabled
          ? [this.t(locale, "menu:notices.startup.webapp", { url: localWebappUrl })]
          : []),
        ...(this.config.distributed.gatewayPublicUrl
          ? [
              this.t(locale, "menu:notices.startup.gateway", {
                url: this.config.distributed.gatewayPublicUrl,
              }),
            ]
          : []),
        ...(this.config.distributed.gatewayWsUrl
          ? [
              this.t(locale, "menu:notices.startup.gateway_ws", {
                url: this.config.distributed.gatewayWsUrl,
              }),
            ]
          : []),
        this.t(locale, "menu:notices.startup.browser", {
          status: browserStatus,
        }),
        ...(availableUpdate
          ? [
              this.t(locale, "menu:notices.startup.update_available", {
                currentVersion: availableUpdate.currentVersion,
                latestVersion: availableUpdate.latestVersion,
              }),
              this.t(locale, "menu:notices.startup.update_command", {
                packageName: TELLYMCP_PACKAGE_NAME,
                latestVersion: availableUpdate.latestVersion,
              }),
            ]
          : []),
        this.t(locale, "menu:notices.startup.hint"),
      ].join("\n");

      try {
        await this.sendNotification({
          sessionId: primarySessionId,
          sessionLabel: "TellyMCP",
          recipient: recipientGroup.binding,
          message: startupMessage,
        });
      } catch (error) {
        this.logger.warn("Failed to deliver Telegram startup notification", {
          telegramChatId: recipientGroup.binding.telegramChatId,
          telegramUserId: recipientGroup.binding.telegramUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public async sendAdminGatewayRegistrationNotifications(input: {
    clientUuid: string;
    nodeId?: string;
    packageVersion?: string;
    totalSessions: number;
    isNewClient: boolean;
    newSessions: AdminGatewayRegistrationSessionRecord[];
  }): Promise<void> {
    if (!this.isTelegramEnabled()) {
      return;
    }

    if (!this.isAdminAuthEnabled()) {
      return;
    }

    const principals = await this.adminAuthStore.listAdminAuthorizedPrincipals();
    if (principals.length === 0) {
      this.logger.debug(
        "Skipping gateway registration admin notifications because no admins are authorized",
        {
          clientUuid: input.clientUuid,
        },
      );
      return;
    }

    const notifiedChats = new Set<string>();
    for (const principal of principals) {
      const dedupeKey = `${principal.telegramChatId}:${principal.telegramUserId}`;
      if (notifiedChats.has(dedupeKey)) {
        continue;
      }

      const locale = await this.resolveLocaleForTelegramUserId(
        principal.telegramUserId,
      );
      const lines = [
        this.t(
          locale,
          input.isNewClient
            ? "menu:notices.admin.gateway_client_registered_title"
            : "menu:notices.admin.gateway_session_registered_title",
        ),
        this.t(locale, "menu:notices.admin.gateway_client_uuid", {
          value: input.clientUuid,
        }),
        ...(input.nodeId
          ? [
              this.t(locale, "menu:notices.admin.gateway_node_id", {
                value: input.nodeId,
              }),
            ]
          : []),
        ...(input.packageVersion
          ? [
              this.t(locale, "menu:notices.admin.gateway_package_version", {
                value: input.packageVersion,
              }),
            ]
          : []),
        this.t(locale, "menu:notices.admin.gateway_session_count", {
          count: input.totalSessions,
        }),
        ...(input.newSessions.length > 0
          ? [
              "",
              this.t(locale, "menu:notices.admin.gateway_new_sessions"),
              ...input.newSessions.map((session) =>
                this.t(locale, "menu:notices.admin.gateway_session_item", {
                  label:
                    session.session_label?.trim() || session.local_session_id,
                  localSessionId: session.local_session_id,
                }),
              ),
            ]
          : []),
      ];

      try {
        await this.sendNotification({
          sessionId: `gateway-admin:${input.clientUuid}`,
          sessionLabel: "Gateway Admin",
          recipient: principal,
          message: lines.join("\n"),
        });
        notifiedChats.add(dedupeKey);
      } catch (error) {
        this.logger.warn("Failed to deliver gateway registration admin notification", {
          telegramChatId: principal.telegramChatId,
          telegramUserId: principal.telegramUserId,
          clientUuid: input.clientUuid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public async sendRequest(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.isTelegramEnabled()) {
      return this.sendRequestViaGateway(input);
    }

    this.ensureTelegramEnabledFor("send Telegram requests");
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

  public async sendRequestForGatewayBoundSession(
    input: HumanTransportRequest & { sourceClientUuid: string },
  ): Promise<{ externalMessageId?: string | number }> {
    const result = await this.sendRequest(input);
    const waiter = this.waiters.get(input.requestId);
    if (waiter) {
      waiter.sourceClientUuid = input.sourceClientUuid;
    }
    return result;
  }

  public async sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.isTelegramEnabled()) {
      this.logger.debug(
        "Telegram notification skipped because transport is disabled",
        {
          sessionId: input.sessionId,
          telegramChatId: input.recipient.telegramChatId,
          telegramUserId: input.recipient.telegramUserId,
        },
      );
      return {};
    }

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
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.t(locale, "menu:notices.project.new_member");

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.member_joined", {
          projectName: input.project_name,
          memberLabel,
        }),
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
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.t(locale, "menu:notices.project.member");

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.member_left", {
          projectName: input.project_name,
          memberLabel,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectDeletedEvent(input: {
    project_uuid: string;
    project_name: string;
  }): Promise<void> {
    const sessions = await this.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      if (session.activeProjectUuid === input.project_uuid) {
        await this.sessionStore.setSession({
          ...session,
          activeProjectUuid: undefined,
          activeProjectName: undefined,
          updatedAt: new Date().toISOString(),
        });
      }

      const binding = await this.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );

      await this.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.t(locale, "menu:notices.project.deleted", {
          projectName: input.project_name,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  private async computeSessionToolsHash(sessionId: string): Promise<string | null> {
    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim();
    if (!workspaceDir) {
      return null;
    }

    try {
      const content = await readFile(path.join(workspaceDir, "TOOLS.md"), "utf8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  }

  private async maybeNotifyToolsMismatchForSession(
    sessionId: string,
  ): Promise<void> {
    const session = await this.sessionStore.getSession(sessionId);
    const expectedGatewayHash = session?.lastNotifiedToolsHash?.trim();
    if (!session || !expectedGatewayHash) {
      return;
    }

    const localHash = await this.computeSessionToolsHash(sessionId);
    if (localHash === expectedGatewayHash) {
      return;
    }

    if (session.lastSeenToolsHash?.trim() === expectedGatewayHash) {
      return;
    }

    await this.handleToolsUpdatedEvent({
      local_session_id: sessionId,
      ...(session.label ? { session_label: session.label } : {}),
      ...(localHash ? { client_tools_hash: localHash } : {}),
      gateway_tools_hash: expectedGatewayHash,
      reason: localHash ? "outdated" : "missing",
      instruction:
        "Call refresh_tools_markdown for this session, then re-read the local TOOLS.md and apply it before continuing.",
    });
  }

  public async handleToolsUpdatedEvent(input: {
    local_session_id: string;
    session_label?: string;
    client_tools_hash?: string;
    gateway_tools_hash: string;
    reason: "missing" | "outdated";
    instruction: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.local_session_id);
    if (!session) {
      this.logger.warn("Skipping tools update event because local session is unavailable", {
        sessionId: input.local_session_id,
        reason: input.reason,
      });
      return;
    }

    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId: session.sessionId,
      telegramChatId: 0,
      telegramUserId: 0,
      sourceTelegramMessageId: 0,
      text: [
        "Gateway TOOLS.md has changed or is missing locally.",
        `Session: ${session.label ?? input.session_label ?? session.sessionId}`,
        `Reason: ${input.reason === "missing" ? "local TOOLS.md hash is missing" : "local TOOLS.md is outdated"}`,
        `Gateway tools hash: ${input.gateway_tools_hash}`,
        ...(input.client_tools_hash ? [`Local tools hash: ${input.client_tools_hash}`] : []),
        "",
        "# Action Required",
        "1. Call refresh_tools_markdown for this session.",
        "2. Re-read the local TOOLS.md.",
        "3. Apply the updated instructions before continuing any work.",
        "The task is not complete until the updated TOOLS.md has been read and applied.",
      ].join("\n"),
      receivedAt: new Date().toISOString(),
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    await this.nudgeSessionInbox(session.sessionId);

    const binding = await this.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      return;
    }

    await this.sendNotification({
      sessionId: session.sessionId,
      ...(session.label ? { sessionLabel: session.label } : {}),
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.changed",
        ),
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.session",
          {
            sessionName: session.label ?? input.session_label ?? session.sessionId,
          },
        ),
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.action_required",
        ),
      ].join("\n"),
    });

    await this.sessionStore.setSession({
      ...session,
      lastNotifiedToolsHash: input.gateway_tools_hash,
      updatedAt: new Date().toISOString(),
    });
  }

  public async handleGatewayVersionCompatibilityEvent(input: {
    local_session_id: string;
    session_label?: string;
    compatibility: "warn" | "reject";
    gateway_package_version: string;
    gateway_protocol_version: string;
    gateway_capabilities: string[];
    client_package_version: string;
    client_protocol_version: string;
    client_capabilities: string[];
    reasons: string[];
    instruction: string;
  }): Promise<void> {
    const session = await this.sessionStore.getSession(input.local_session_id);
    if (!session) {
      this.logger.warn(
        "Skipping gateway version compatibility event because local session is unavailable",
        {
          sessionId: input.local_session_id,
          compatibility: input.compatibility,
        },
      );
      return;
    }

    const title =
      input.compatibility === "reject"
        ? "Gateway/client protocol mismatch blocks transport."
        : "Gateway/client version mismatch detected.";
    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId: session.sessionId,
      telegramChatId: 0,
      telegramUserId: 0,
      sourceTelegramMessageId: 0,
      text: [
        title,
        `Session: ${session.label ?? input.session_label ?? session.sessionId}`,
        `Compatibility: ${input.compatibility}`,
        `Client package: ${input.client_package_version}`,
        `Client protocol: ${input.client_protocol_version}`,
        `Gateway package: ${input.gateway_package_version}`,
        `Gateway protocol: ${input.gateway_protocol_version}`,
        `Client capabilities: ${input.client_capabilities.join(", ") || "none"}`,
        `Gateway capabilities: ${input.gateway_capabilities.join(", ") || "none"}`,
        ...(input.reasons.length > 0
          ? ["", "# Reasons", ...input.reasons.map((reason) => `- ${reason}`)]
          : []),
        "",
        "# Action Required",
        input.instruction,
        ...(input.compatibility === "reject"
          ? [
              "Do not continue collaboration, delivery, or live relay work until this client is upgraded.",
            ]
          : [
              "Upgrade the older side soon and verify the updated TOOLS.md before continuing sensitive work.",
            ]),
      ].join("\n"),
      receivedAt: new Date().toISOString(),
    };

    await this.inboxStore.createInboxMessage(inboxMessage);
    await this.nudgeSessionInbox(session.sessionId);

    const binding = await this.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      return;
    }

    await this.sendNotification({
      sessionId: session.sessionId,
      ...(session.label ? { sessionLabel: session.label } : {}),
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        await this.tForTelegramUserId(
          binding.telegramUserId,
          input.compatibility === "reject"
            ? "menu:notices.version.reject"
            : "menu:notices.version.warn",
        ),
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.session",
          {
            sessionName: session.label ?? input.session_label ?? session.sessionId,
          },
        ),
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.client",
          {
            packageVersion: input.client_package_version,
            protocolVersion: input.client_protocol_version,
          },
        ),
        await this.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.gateway",
          {
            packageVersion: input.gateway_package_version,
            protocolVersion: input.gateway_protocol_version,
          },
        ),
        input.instruction,
      ].join("\n"),
    });
  }

  public async handleLiveViewApprovalRequestEvent(
    input: LiveApprovalEventPayload,
  ): Promise<void> {
    const targetSession = await this.sessionStore.getSession(
      input.target_local_session_id,
    );
    if (!targetSession) {
      this.logger.warn("Skipping live approval request because target session is unavailable", {
        targetLocalSessionId: input.target_local_session_id,
        sourceLocalSessionId: input.source_local_session_id,
      });
      return;
    }

    const binding = await this.bindingStore.getBinding(targetSession.sessionId);
    if (!binding) {
      this.logger.warn("Skipping live approval request because target session is not paired", {
        sessionId: targetSession.sessionId,
        sourceLocalSessionId: input.source_local_session_id,
      });
      return;
    }
    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    const payloadKey = await this.createLiveApprovalMenuPayload({
      sessionId: targetSession.sessionId,
      sourceSessionId: input.source_session_id,
      sourceSessionLabel: input.source_session_label,
      sourceClientUuid: input.source_client_uuid,
      sourceLocalSessionId: input.source_local_session_id,
      targetSessionId: input.target_session_id,
      targetSessionLabel: input.target_session_label,
      targetClientUuid: input.target_client_uuid,
      targetLocalSessionId: input.target_local_session_id,
      ...(input.project_uuid ? { projectUuid: input.project_uuid } : {}),
      ...(input.project_name ? { projectName: input.project_name } : {}),
    });

    const sent = await this.sendChatMessage(
      binding.telegramChatId,
      [
        this.t(locale, "menu:live.approval.request_title"),
        "",
        ...(input.project_name
          ? [
              this.t(locale, "menu:live.approval.project", {
                projectName: input.project_name,
              }),
            ]
          : []),
        this.t(locale, "menu:live.approval.route", {
          sourceSessionName: input.source_session_label,
          targetSessionName: input.target_session_label,
        }),
        "",
        this.t(locale, "menu:live.approval.request_message", {
          sourceSessionName: input.source_session_label,
        }),
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text(`✅ ${this.t(locale, "menu:live.approval.approve")}`, `live-approval:approve:${payloadKey}`)
          .text(`❌ ${this.t(locale, "menu:live.approval.deny")}`, `live-approval:deny:${payloadKey}`),
      },
      {
        kind: "notification",
        sessionId: targetSession.sessionId,
      },
    );

    this.logger.info("Telegram live approval request delivered", {
      sessionId: targetSession.sessionId,
      telegramChatId: binding.telegramChatId,
      telegramUserId: binding.telegramUserId,
      messageId: sent.message_id,
      sourceLocalSessionId: input.source_local_session_id,
    });
  }

  public async handleLiveViewApprovalResolvedEvent(
    input: LiveApprovalEventPayload & { approved: boolean },
  ): Promise<void> {
    const sourceSession = await this.sessionStore.getSession(
      input.source_local_session_id,
    );
    if (!sourceSession) {
      this.logger.warn("Skipping live approval resolution because source session is unavailable", {
        sourceLocalSessionId: input.source_local_session_id,
        targetLocalSessionId: input.target_local_session_id,
      });
      return;
    }

    const binding = await this.bindingStore.getBinding(sourceSession.sessionId);
    if (!binding) {
      this.logger.warn("Skipping live approval resolution because source session is not paired", {
        sessionId: sourceSession.sessionId,
        targetLocalSessionId: input.target_local_session_id,
      });
      return;
    }
    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    if (!input.approved) {
      await this.sendNotification({
        sessionId: sourceSession.sessionId,
        ...(sourceSession.label ? { sessionLabel: sourceSession.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.t(locale, "menu:live.approval.denied"),
          ...(input.project_name
            ? [
                this.t(locale, "menu:live.approval.project", {
                  projectName: input.project_name,
                }),
              ]
            : []),
          this.t(locale, "menu:live.approval.route", {
            sourceSessionName: input.source_session_label,
            targetSessionName: input.target_session_label,
          }),
        ].join("\n"),
      });
      return;
    }

    const liveViewUrl = this.buildLiveViewUrlForSessionTarget({
      targetSessionId: input.target_session_id,
      targetClientUuid: input.target_client_uuid,
      targetLocalSessionId: input.target_local_session_id,
      sourceClientUuid: input.source_client_uuid,
    });
    if (!liveViewUrl) {
      throw new Error("Unable to build Live View URL for approved request.");
    }

    const sent = await this.sendChatMessage(
      binding.telegramChatId,
      [
        this.t(locale, "menu:live.approval.approved"),
        "",
        ...(input.project_name
          ? [
              this.t(locale, "menu:live.approval.project", {
                projectName: input.project_name,
              }),
            ]
          : []),
        this.t(locale, "menu:live.approval.route", {
          sourceSessionName: input.source_session_label,
          targetSessionName: input.target_session_label,
        }),
        "",
        this.t(locale, "menu:live.actions.choose_mode"),
      ].join("\n"),
      {
        reply_markup: this.buildLiveViewLaunchKeyboard(
          (mode) =>
            this.buildLiveViewUrlForSessionTarget({
              targetSessionId: input.target_session_id,
              targetClientUuid: input.target_client_uuid,
              targetLocalSessionId: input.target_local_session_id,
              sourceClientUuid: input.source_client_uuid,
              launchMode: mode,
            }),
          locale,
        ),
      },
      {
        kind: "notification",
        sessionId: sourceSession.sessionId,
      },
    );

    this.webAppLaunchRegistry.set(
      binding.telegramUserId,
      sourceSession.sessionId,
      this.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: binding.telegramChatId,
        telegramMessageId: sent.message_id,
      },
    );
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

  private async sendChatMessage(
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

  public async handleGatewayTransportReplyEvent(input: {
    request_id: string;
    answer: string;
    received_at: string;
  }): Promise<void> {
    const waiter = this.waiters.get(input.request_id);
    if (!waiter) {
      this.logger.debug("Gateway transport reply ignored because waiter was not found", {
        requestId: input.request_id,
      });
      return;
    }

    const reply: HumanTransportReply = {
      requestId: input.request_id,
      answer: input.answer,
      receivedAt: input.received_at,
    };

    this.logger.info("Gateway transport reply received", {
      requestId: input.request_id,
      telegramChatId: waiter.telegramChatId,
      telegramUserId: waiter.telegramUserId,
    });

    if (waiter.resolve) {
      waiter.resolve(reply);
      return;
    }

    waiter.reply = reply;
  }

  private clearWaiter(requestId: string): void {
    const waiter = this.waiters.get(requestId);
    if (waiter?.timeout) {
      clearTimeout(waiter.timeout);
    }
    this.waiters.delete(requestId);
  }

  private async sendRequestViaGateway(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }> {
    if (!this.config.distributed.gatewayPublicUrl) {
      throw new Error("Gateway is not configured for Telegram request proxying.");
    }

    const clientUuid = await this.maintenanceStore.getGatewayClientUuid();
    if (!clientUuid) {
      throw new Error("Gateway client UUID is unavailable for Telegram request proxying.");
    }

    this.waiters.set(input.requestId, {
      requestId: input.requestId,
      telegramChatId: input.recipient.telegramChatId,
      telegramUserId: input.recipient.telegramUserId,
      telegramMessageId: 0,
      sentAtMs: Date.now(),
    });

    try {
      const response = await this.callGatewayJson<{
        message_id?: number | string;
      }>("/transport/request", {
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        request_id: input.requestId,
        ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
        telegram_chat_id: input.recipient.telegramChatId,
        telegram_user_id: input.recipient.telegramUserId,
        question: input.question,
        ...(input.task ? { task: input.task } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.affectedFiles ? { affected_files: input.affectedFiles } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.recommendedOption
          ? { recommended_option: input.recommendedOption }
          : {}),
        ...(input.riskLevel ? { risk_level: input.riskLevel } : {}),
      ...(input.fallbackIfTimeout
          ? { fallback_if_timeout: input.fallbackIfTimeout }
          : {}),
      });

      const waiter = this.waiters.get(input.requestId);
      if (waiter && typeof response.message_id === "number") {
        waiter.telegramMessageId = response.message_id;
      }

      return typeof response.message_id === "undefined"
        ? {}
        : { externalMessageId: response.message_id };
    } catch (error) {
      this.clearWaiter(input.requestId);
      throw error;
    }
  }

  private createMainMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-main-menu", {
      fingerprint: async (ctx) => this.buildMainMenuFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showMainMenu(ctx)),
    })
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.live"), async (ctx) => {
        await this.showLiveViewLauncher(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.content"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:main.actions.open_content"),
        });
        await this.showBufferMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.browser"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:main.actions.open_browser"),
        });
        await this.showBrowserMenu(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.local"), async (ctx) => {
        await this.showLocalEntryPoint(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.collab"), async (ctx) => {
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
          await ctx.answerCallbackQuery({
            text: await this.tForContext(ctx, "menu:main.actions.open_inbox"),
          });
          await this.showInboxMenu(ctx);
        },
      )
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.storage"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:main.actions.open_storage"),
        });
        await this.showStorageMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.settings"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:main.actions.open_settings"),
        });
        await this.showSettingsMenu(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:main.buttons.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:main.actions.back_to_sessions"),
        });
        await this.showSessionsMenu(ctx);
      });
  }

  private createAdminMainMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-main-menu", {
      ...this.createMenuOptions((ctx) => this.showAdminMainMenu(ctx)),
    })
      .text(async (ctx) => this.tForContext(ctx, "menu:admin.buttons.clients"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:admin.actions.open_clients"),
        });
        await this.showAdminClientsMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:admin.buttons.tools"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:admin.actions.open_tools"),
        });
        await this.showAdminToolsMenu(ctx);
      });
  }

  private createAdminClientsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-clients-menu", {
      ...this.createMenuOptions((ctx) => this.showAdminClientsMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        let clients: AdminClientViewRecord[];
        try {
          clients = await this.listGatewayAdminClients();
        } catch {
          range.text(
            await this.tForContext(ctx, "menu:admin.clients.unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
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
            await this.tForContext(ctx, "menu:admin.clients.empty"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "menu:admin.clients.empty",
                ),
              });
            },
          );
          return range;
        }

        for (const client of clients) {
          const payloadKey = await this.createAdminClientMenuPayload(client);
          range
            .text(
              {
                text: this.buildAdminClientButtonLabel(client),
                payload: async () => payloadKey,
              },
              async (innerCtx) => {
                await this.handleAdminClientSelectCallback(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:admin.actions.back_to_admin"),
        });
        await this.showAdminMainMenu(ctx);
      });
  }

  private createAdminClientSessionsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-client-sessions-menu", {
      ...this.createMenuOptions((ctx) => this.showAdminClientSessionsMenu(ctx)),
    })
      .text(
        async (ctx) => this.tForContext(ctx, "menu:admin.client_sessions.buttons.collab"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
          });
          await this.showAdminClientSessionList(ctx, "collab");
        },
      )
      .text(
        async (ctx) => this.tForContext(ctx, "menu:admin.client_sessions.buttons.all"),
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: await this.tForContext(ctx, "menu:admin.actions.open_client_sessions"),
          });
          await this.showAdminClientSessionList(ctx, "all");
        },
      )
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:admin.actions.back_to_clients"),
        });
        await this.showAdminClientsMenu(ctx);
      });
  }

  private createAdminClientSessionDetailMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-client-session-detail-menu", {
      ...this.createMenuOptions((ctx) => this.showAdminClientSessionsMenu(ctx)),
    });
  }

  private createAdminToolsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-admin-tools-menu", {
      ...this.createMenuOptions((ctx) => this.showAdminToolsMenu(ctx)),
    })
      .text(async (ctx) => this.tForContext(ctx, "menu:admin.buttons.client_env"), async (ctx) => {
        await this.handleAdminClientEnvExport(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:admin.actions.back_to_admin"),
        });
        await this.showAdminMainMenu(ctx);
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
          await ctx.answerCallbackQuery({
            text: await this.tForContext(ctx, "menu:browser.actions.open_screenshots"),
          });
          await this.showScreenshotsMenu(ctx);
        },
      )
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:browser.actions.back_to_session_menu",
          ),
        });
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
          range.text(
            await this.tForContext(ctx, "common:menu.gateway_unavailable"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
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
              await this.tForContext(ctx, "menu:collab.labels.no_projects"),
              async (innerCtx) => {
                await innerCtx.answerCallbackQuery({
                  text: await this.tForContext(
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
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.create"), async (ctx) => {
        await this.beginProjectMode(ctx, "create");
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.tools"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:collab.actions.open_tools"),
        });
        await this.showCollabToolsMenu(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.join"), async (ctx) => {
        await this.beginProjectMode(ctx, "join");
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:collab.actions.back_to_session_menu",
          ),
        });
        await this.showMainMenu(ctx);
      });
  }

  private createCollabToolsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-collab-tools-menu",
      this.createMenuOptions((ctx) => this.showCollabToolsMenu(ctx)),
    )
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.broadcast"), async (ctx) => {
        await this.beginProjectBroadcast(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.history"), async (ctx) => {
        await this.handleCollabHistoryExport(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:collab.buttons.delete"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:collab.actions.open_delete"),
        });
        await this.showCollabDeleteMenu(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:collab.actions.back_to_collab"),
        });
        await this.showProjectsMenu(ctx);
      });
  }

  private createCollabDeleteMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-collab-delete-menu",
      {
        fingerprint: async (ctx) => this.buildProjectsFingerprint(ctx),
        ...this.createMenuOptions((ctx) => this.showCollabDeleteMenu(ctx)),
      },
    )
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const { session, projects } = await this.loadProjectsContext(ctx);
        if (!session || !projects) {
          range.text(
            await this.tForContext(ctx, "common:menu.gateway_unavailable"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(innerCtx, "menu:collab.actions.gateway_only"),
              show_alert: true,
            });
            },
          );
          return range;
        }

        if (projects.length === 0) {
          range.text(await this.tForContext(ctx, "menu:collab.labels.no_projects"), async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(innerCtx, "menu:collab.actions.no_projects"),
            });
          });
          return range;
        }

        for (const project of projects) {
          const isOwner = project.role === "owner";
          range
            .text(
              {
                text: `${isOwner ? "🗑" : "🔒"} ${project.name}`,
                payload: async () =>
                  this.createProjectDeleteMenuPayload(
                    session.sessionId,
                    project.project_uuid,
                    project.name,
                  ),
              },
              async (innerCtx) => {
                await this.handleProjectDeleteSelect(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:collab.actions.back_to_tools"),
        });
        await this.showCollabToolsMenu(ctx);
      });
  }

  private createLocalMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-local-menu",
      this.createMenuOptions((ctx) => this.showLocalMenu(ctx)),
    )
      .text(async (ctx) => this.tForContext(ctx, "menu:local.buttons.partner"), async (ctx) => {
        await this.showPartnerEntryPoint(ctx);
      })
      .text(
        async (ctx) => this.buildLinkButtonLabel(ctx),
        async (ctx) => {
          await this.handleLinkButton(ctx);
        },
      )
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:local.actions.back_to_session_menu",
          ),
        });
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
          range.text(
            await this.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const activeSessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!activeSessionId) {
          range.text(
            await this.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "common:errors.no_active_session",
                ),
                show_alert: true,
              });
            },
          );
          return range;
        }

        const sessionIds = (
          await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
        )
          .filter((sessionId) => sessionId !== activeSessionId)
          .sort();

        if (sessionIds.length === 0) {
          range.text(
            await this.tForContext(ctx, "menu:link.labels.no_partner_sessions"),
            async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "menu:link.actions.no_partner_sessions",
                ),
                show_alert: true,
              });
            },
          );
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
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:link.actions.back_to_session_menu",
          ),
        });
        await this.showMainMenu(ctx);
      });
  }

  private createPartnerMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-partner-menu",
      this.createMenuOptions((ctx) => this.showPartnerMenu(ctx)),
    )
      .text(async (ctx) => this.tForContext(ctx, "menu:partner.buttons.ask"), async (ctx) => {
        await this.beginPartnerNoteMode(ctx, "question");
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:partner.buttons.share"), async (ctx) => {
        await this.beginPartnerNoteMode(ctx, "share");
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:partner.buttons.unlink"), async (ctx) => {
        await this.handleLinkButton(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:partner.actions.back_to_session_menu",
          ),
        });
        await this.showMainMenu(ctx);
      });
  }

  private createBufferMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-buffer-menu",
      this.createMenuOptions((ctx) => this.showBufferMenu(ctx)),
    )
      .text(async (ctx) => this.tForContext(ctx, "menu:buffer.buttons.visible"), async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, { mode: "visible" });
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:buffer.buttons.full"), async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, { mode: "full" });
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:buffer.buttons.last_300"), async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, {
          mode: "lines",
          lines: 300,
        });
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:buffer.buttons.last_1000"), async (ctx) => {
        await this.sendActiveSessionBuffer(ctx, {
          mode: "lines",
          lines: 1000,
        });
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:local.actions.back_to_session_menu",
          ),
        });
        await this.showMainMenu(ctx);
      });
  }

  private createSettingsMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>(
      "telegram-settings-menu",
      this.createMenuOptions((ctx) => this.showSettingsMenu(ctx)),
    )
      .text(async (ctx) => this.tForContext(ctx, "menu:settings.buttons.info"), async (ctx) => {
        await this.showActiveSessionInfo(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:settings.buttons.rename"), async (ctx) => {
        await this.beginRenameActiveSession(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "menu:settings.buttons.unpair"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:settings.actions.confirm_unpair"),
        });
        await this.showUnpairConfirmMenu(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:local.actions.back_to_session_menu",
          ),
        });
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
      .text(async (ctx) => this.tForContext(ctx, "menu:settings.buttons.confirm_unpair"), async (ctx) => {
        await this.unpairActiveSession(ctx);
      })
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:settings.actions.back_to_settings",
          ),
        });
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
          range.text(
            await this.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.missing_telegram_context",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const sessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.no_active_session",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const inboxMessages = await this.inboxStore.listInboxMessages(
          sessionId,
          10,
        );

        if (inboxMessages.length === 0) {
          range.text(await this.tForContext(ctx, "menu:inbox.labels.empty"), async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(innerCtx, "menu:inbox.actions.empty"),
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
      .text(async (ctx) => this.tForContext(ctx, "common:menu.refresh"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:inbox.actions.refreshed"),
        });
        await this.showInboxMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:local.actions.back_to_session_menu",
          ),
        });
        await this.showMainMenu(ctx);
      });
  }

  private createStorageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-storage-menu", {
      fingerprint: async (ctx) => this.buildStorageFingerprint(ctx),
      ...this.createMenuOptions((ctx) => this.showStorageMenu(ctx)),
    })
      .dynamic(async (ctx) => {
        const range = new MenuRange<TelegramMenuContext>();
        const principal = this.getPrincipalFromContext(ctx);
        if (!principal) {
          range.text(
            await this.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.missing_telegram_context",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const sessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.no_active_session",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const entries = await this.listActiveSessionStorageEntries(sessionId);
        if (entries.length === 0) {
          range.text(await this.tForContext(ctx, "menu:storage.labels.empty"), async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(innerCtx, "menu:storage.actions.empty"),
            });
          });
          return range;
        }

        for (const entry of entries) {
          range
            .text(
              {
                text: this.formatStoragePreviewLabel(entry.filePath, entry.meta),
                payload: async () =>
                  this.createFileMenuPayload(sessionId, entry.filePath),
              },
              async (innerCtx) => {
                await this.handleStorageOpen(innerCtx);
              },
            )
            .row();
        }

        return range;
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.refresh"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:storage.actions.refreshed"),
        });
        await this.showStorageMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:local.actions.back_to_session_menu",
          ),
        });
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
          range.text(
            await this.tForContext(ctx, "common:menu.no_telegram_identity_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.missing_telegram_context",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const sessionId =
          await this.bindingStore.getActiveSessionIdForPrincipal(principal);
        if (!sessionId) {
          range.text(
            await this.tForContext(ctx, "common:menu.no_active_session_label"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "common:errors.no_active_session",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }

        const filePaths = await this.listActiveSessionScreenshots(sessionId);
        if (filePaths.length === 0) {
          range.text(
            await this.tForContext(ctx, "menu:screenshots.labels.empty"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "menu:screenshots.actions.empty",
              ),
            });
            },
          );
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
      .text(async (ctx) => this.tForContext(ctx, "common:menu.refresh"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:screenshots.actions.refreshed",
          ),
        });
        await this.showScreenshotsMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:browser.actions.back_to_browser_menu",
          ),
        });
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
            range.text(
              await this.tForContext(ctx, "common:menu.no_telegram_identity_label"),
              async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "common:errors.missing_telegram_context",
                ),
                show_alert: true,
              });
              },
            );
            return range;
          }

          const activeSessionId =
            await this.bindingStore.getActiveSessionIdForPrincipal(principal);
          const sessionIds = (
            await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
          ).sort();

          if (sessionIds.length === 0) {
            range.text(
              await this.tForContext(ctx, "menu:sessions.labels.no_linked_sessions"),
              async (innerCtx) => {
              await innerCtx.answerCallbackQuery({
                text: await this.tForContext(
                  innerCtx,
                  "menu:sessions.actions.no_linked_sessions",
                ),
                show_alert: true,
              });
              },
            );
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
          range.text(
            await this.tForContext(ctx, "menu:sessions.labels.unavailable"),
            async (innerCtx) => {
            await innerCtx.answerCallbackQuery({
              text: await this.tForContext(
                innerCtx,
                "menu:sessions.actions.unavailable",
              ),
              show_alert: true,
            });
            },
          );
          return range;
        }
      })
      .text(async (ctx) => this.tForContext(ctx, "common:menu.refresh"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:sessions.actions.refreshed"),
        });
        await this.showSessionsMenu(ctx);
      })
      .text(async (ctx) => this.tForContext(ctx, "menu:sessions.labels.tools"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:sessions.actions.open_tools"),
        });
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
          text: async (ctx) => this.tForContext(ctx, "common:menu.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleInboxMessageDelete(ctx);
        },
      )
      .text(async (ctx) => this.tForContext(ctx, "common:menu.close"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "common:menu.close"),
        });
        await ctx.deleteMessage();
      });
  }

  private createStorageMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-storage-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.createMenuOptions((ctx) => this.showStorageMenu(ctx)),
    })
      .text(
        {
          text: async (ctx) => this.tForContext(ctx, "common:menu.get"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleStorageGet(ctx);
        },
      )
      .text(
        {
          text: async (ctx) => this.tForContext(ctx, "menu:storage.buttons.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleStorageDelete(ctx);
        },
      )
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(ctx, "menu:storage.actions.back_to_storage"),
        });
        await this.showStorageMenu(ctx);
      });
  }

  private createScreenshotMessageMenu(): Menu<TelegramMenuContext> {
    return new Menu<TelegramMenuContext>("telegram-screenshot-message-menu", {
      fingerprint: (ctx) => readMenuPayloadKey(ctx) ?? "no-payload",
      ...this.createMenuOptions((ctx) => this.showScreenshotsMenu(ctx)),
    })
      .text(
        {
          text: async (ctx) => this.tForContext(ctx, "menu:storage.buttons.get"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleScreenshotGet(ctx);
        },
      )
      .text(
        {
          text: async (ctx) => this.tForContext(ctx, "menu:storage.buttons.delete"),
          payload: (ctx) => readMenuPayloadKey(ctx) ?? "missing",
        },
        async (ctx) => {
          await this.handleScreenshotDelete(ctx);
        },
      )
      .row()
      .text(async (ctx) => this.tForContext(ctx, "common:menu.back"), async (ctx) => {
        await ctx.answerCallbackQuery({
          text: await this.tForContext(
            ctx,
            "menu:screenshots.actions.back_to_screenshots",
          ),
        });
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

    const principal = this.getPrincipalFromContext(ctx);
    const authToken = text ? parseAdminAuthCommand(text) : null;
    if (this.isAdminAuthEnabled() && principal && authToken) {
      await this.handleAdminAuthCommand(ctx, principal, authToken);
      return;
    }

    if (this.isAdminBotProfile()) {
      const handled = await this.handleGatewayTopLevelMessage(ctx, text);
      if (handled) {
        return;
      }
    }

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

  private async handleGatewayTopLevelMessage(
    ctx: TelegramMenuContext,
    text: string | null,
  ): Promise<boolean> {
    const principal = this.getPrincipalFromContext(ctx);

    if (text && isGatewayLinkCommand(text)) {
      await this.showAdminClientsMenu(ctx);
      return true;
    }

    if (text && isGatewayAdminCommand(text)) {
      await this.showAdminMainMenu(ctx);
      return true;
    }

    if (text && isMenuEntryCommand(text)) {
      const isAdminAuthorized =
        await this.isPrincipalAdminAuthorized(principal);
      const activeSessionId = principal
        ? await this.bindingStore.getActiveSessionIdForPrincipal(principal)
        : null;
      const boundSessionIds = principal
        ? await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
        : [];
      const hasLinkedSessions =
        Boolean(activeSessionId) || boundSessionIds.length > 0;

      this.logger.info("Gateway /menu routing evaluated", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        isAdminAuthorized,
        activeSessionId,
        boundSessionCount: boundSessionIds.length,
        boundSessionIds,
      });

      if (hasLinkedSessions) {
        this.clearPendingInteractionsForContext(ctx);
        await this.showSessionsMenu(ctx);
      } else if (isAdminAuthorized) {
        await this.showAdminMainMenu(ctx);
      } else {
        this.clearPendingInteractionsForContext(ctx);
        await this.showSessionsMenu(ctx);
      }
      return true;
    }

    if (text && isHelpCommand(text)) {
      const isAdminAuthorized =
        await this.isPrincipalAdminAuthorized(principal);
      const activeSessionId = principal
        ? await this.bindingStore.getActiveSessionIdForPrincipal(principal)
        : null;
      const boundSessionIds = principal
        ? await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
        : [];
      const hasLinkedSessions =
        Boolean(activeSessionId) || boundSessionIds.length > 0;
      if (hasLinkedSessions) {
        this.clearPendingInteractionsForContext(ctx);
        await this.showHelp(ctx);
      } else if (isAdminAuthorized) {
        await this.showAdminMainMenu(
          ctx,
          await this.tForContext(ctx, "menu:admin.screen.help"),
        );
      } else {
        await this.showHelp(ctx);
      }
      return true;
    }

    return false;
  }

  private resolveGatewayTelegramSourceLabel(
    ctx: TelegramMenuContext,
  ): string {
    const firstName = ctx.from?.first_name?.trim();
    const lastName = ctx.from?.last_name?.trim();
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const username = ctx.from?.username?.trim();
    if (displayName) {
      return displayName;
    }
    if (username) {
      return `@${username.replace(/^@/u, "")}`;
    }
    return `Telegram user ${ctx.from?.id ?? "unknown"}`;
  }

  private inferGatewayInboxKind(text: string): PartnerNoteKind {
    return /\?\s*$/u.test(text.trim()) ? "question" : "request";
  }

  private buildGatewayInboxSummary(text: string): string {
    const summary =
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? "Telegram message";
    return summary.length > 140 ? `${summary.slice(0, 137).trimEnd()}...` : summary;
  }

  private async routeTelegramInboxToRelaySession(input: {
    ctx: TelegramMenuContext;
    principal: { telegramChatId: number; telegramUserId: number };
    relayTarget: { clientUuid: string; localSessionId: string; sourceClientUuid?: string };
    sourceSessionId: string;
    messageText: string;
    attachments: StoredAttachmentRecord[];
  }): Promise<void> {
    const sourceActorLabel = this.resolveGatewayTelegramSourceLabel(input.ctx);
    const output = await this.callGatewayJson<SendPartnerNoteOutput>(
      "/relay/inbox",
      {
        client_uuid: "gateway-telegram",
        local_session_id: `telegram-user-${input.principal.telegramUserId}`,
        source_actor_label: sourceActorLabel,
        target_client_uuid: input.relayTarget.clientUuid,
        target_local_session_id: input.relayTarget.localSessionId,
        kind: this.inferGatewayInboxKind(input.messageText),
        summary: this.buildGatewayInboxSummary(input.messageText),
        message: input.messageText,
        requires_reply: false,
        artifact_refs: input.attachments.map((attachment) => ({
          file_path: attachment.filePath,
          ...(attachment.relativePath
            ? { relative_path: attachment.relativePath }
            : {}),
          original_name: path.basename(attachment.relativePath || attachment.filePath),
          ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
          ...(typeof attachment.sizeBytes === "number"
            ? { size_bytes: attachment.sizeBytes }
            : {}),
          ...(attachment.storageRef ? { storage_ref: attachment.storageRef } : {}),
        })),
      },
    );

    this.logger.info("Telegram message routed to gateway relay session", {
      sessionId: input.sourceSessionId,
      targetClientUuid: input.relayTarget.clientUuid,
      targetLocalSessionId: input.relayTarget.localSessionId,
      shareId: output.share_id,
      deliveryStatus: output.delivery_status,
      chatId: input.principal.telegramChatId,
      userId: input.principal.telegramUserId,
    });
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

    if (pairCode.targetClientUuid && pairCode.targetLocalSessionId) {
      const principal = {
        telegramChatId: chatId,
        telegramUserId: fromUserId,
      };

      const session = await this.bindRelaySessionToPrincipal({
        principal,
        ctx,
        payload: {
          sessionId: pairCode.sessionId,
          targetSessionId: pairCode.targetLocalSessionId,
          targetSessionLabel:
            pairCode.sessionLabel ?? pairCode.targetLocalSessionId,
          targetClientUuid: pairCode.targetClientUuid,
          targetLocalSessionId: pairCode.targetLocalSessionId,
        },
      });

      this.logger.info("Gateway relay session linked via pairing code", {
        code,
        sessionId: session.sessionId,
        targetClientUuid: pairCode.targetClientUuid,
        targetLocalSessionId: pairCode.targetLocalSessionId,
        telegramChatId: chatId,
        telegramUserId: fromUserId,
      });

      await this.showSessionsMenu(
        ctx,
        "Pairing complete. Choose the active session from the menu.",
      );
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

  private async handleAdminAuthCommand(
    ctx: TelegramMenuContext,
    principal: { telegramChatId: number; telegramUserId: number },
    token: string,
  ): Promise<void> {
    const expected = this.config.telegram.adminToken?.trim();
    if (!expected) {
      await this.replyText(ctx, await this.tForContext(ctx, "menu:admin.auth.disabled"), {
        kind: "transport",
      });
      return;
    }

    if (token !== expected) {
      this.logger.warn("Telegram admin auth rejected", {
        chatId: principal.telegramChatId,
        userId: principal.telegramUserId,
      });
      await this.replyText(ctx, await this.tForContext(ctx, "menu:admin.auth.invalid"), {
        kind: "transport",
      });
      return;
    }

    await this.adminAuthStore.setAdminAuthorized(principal);
    this.logger.info("Telegram admin auth granted", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
    });
    await this.showAdminMainMenu(
      ctx,
      await this.tForContext(ctx, "menu:admin.auth.success"),
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

    if (matched.sourceClientUuid && this.config.distributed.gatewayPublicUrl) {
      try {
        await this.callGatewayJson("/transport/reply", {
          client_uuid: matched.sourceClientUuid,
          request_id: matched.requestId,
          answer: reply.answer,
          received_at: reply.receivedAt,
        });
      } catch (error) {
        this.logger.error("Failed to forward gateway transport reply to client", {
          requestId: matched.requestId,
          sourceClientUuid: matched.sourceClientUuid,
          chatId,
          userId: fromUserId,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return false;
      }

      this.clearWaiter(matched.requestId);
      return true;
    }

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
    const relayTarget = parseLiveRelaySessionId(sessionId);
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

    if (relayTarget) {
      try {
        await this.routeTelegramInboxToRelaySession({
          ctx,
          principal,
          relayTarget,
          sourceSessionId: sessionId,
          messageText: normalizedText,
          attachments,
        });
      } catch (error) {
        this.logger.error("Failed to route Telegram message to gateway relay session", {
          sessionId,
          targetClientUuid: relayTarget.clientUuid,
          targetLocalSessionId: relayTarget.localSessionId,
          chatId,
          userId: fromUserId,
          messageId: message.message_id,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        await this.replyText(
          ctx,
          await this.tForContext(ctx, "menu:system.gateway_relay_inbox_failed"),
          { kind: "transport", sessionId },
        );
        return;
      }

      await this.replyText(
        ctx,
        await this.tForContext(ctx, "menu:system.gateway_relay_inbox_sent", {
          sessionName: session?.label ?? relayTarget.localSessionId,
        }),
        { kind: "transport", sessionId },
      );
      return;
    }

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
          ? await this.tForContext(ctx, "menu:handoff.uploaded_to_session", {
              label: currentTarget.targetSessionLabel,
            })
          : await this.tForContext(ctx, "menu:handoff.uploaded_to_partner", {
              label: currentTarget.targetSessionLabel,
            }),
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
          ? await this.tForContext(ctx, "menu:handoff.delivered_one", {
              label: session.label,
            })
          : await this.tForContext(ctx, "menu:handoff.delivered_many", {
              label: session.label,
              count: attachments.length,
            })
        : attachments.length === 1
          ? await this.tForContext(ctx, "menu:handoff.delivered_one", {
              label: sessionId,
            })
          : await this.tForContext(ctx, "menu:handoff.delivered_many", {
              label: sessionId,
              count: attachments.length,
            }),
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

  private startTmuxPromptScan(): void {
    if (!this.config.tmux.promptScanEnabled) {
      return;
    }

    this.clearTmuxPromptScanTimer();

    const intervalMs = this.config.tmux.promptScanIntervalSeconds * 1000;
    const timer = setInterval(() => {
      void this.runTmuxPromptScanCycle().catch((error) => {
        this.logger.warn("tmux prompt scan cycle failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    this.tmuxPromptScanTimer = timer;

    this.logger.info("tmux prompt scan scheduled", {
      intervalSeconds: this.config.tmux.promptScanIntervalSeconds,
      cooldownSeconds: this.config.tmux.promptScanCooldownSeconds,
      strategy: this.config.tmux.promptScanStrategy,
      minScore: this.config.tmux.promptScanMinScore,
    });

    void this.runTmuxPromptScanCycle().catch((error) => {
      this.logger.warn("initial tmux prompt scan failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
  }

  private clearTmuxPromptScanTimer(): void {
    if (this.tmuxPromptScanTimer) {
      clearInterval(this.tmuxPromptScanTimer);
      this.tmuxPromptScanTimer = undefined;
    }
  }

  private async runTmuxPromptScanCycle(): Promise<void> {
    if (!this.config.tmux.promptScanEnabled || this.tmuxPromptScanInFlight) {
      return;
    }

    this.tmuxPromptScanInFlight = true;
    try {
      const sessions = await this.sessionStore.listSessions();
      for (const session of sessions) {
        await this.scanTmuxPromptForSession(session);
      }
    } finally {
      this.tmuxPromptScanInFlight = false;
    }
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
          void this.sessionStore.getSession(sessionId).then((session) => {
            if (!session?.tmuxTarget) {
              return;
            }

            return this.notifyTmuxUnavailable(sessionId, session, error);
          });
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

    let tmuxTarget = session.tmuxTarget;

    try {
      await sendTmuxLiteralLine(this.config.tmux, tmuxTarget, input.message);
    } catch (error) {
      if (isTmuxTargetInvalidError(error)) {
        const recoveredTarget = await this.tryRecoverTmuxTarget(
          sessionId,
          session,
        );

        if (recoveredTarget) {
          tmuxTarget = recoveredTarget;
          await sendTmuxLiteralLine(
            this.config.tmux,
            recoveredTarget,
            input.message,
          );
        } else {
          await this.notifyTmuxTargetInvalid(sessionId, session, error);
          throw error;
        }
      } else {
        throw error;
      }
    }

    const lastTmuxNudgeAt = new Date(nowMs).toISOString();
    await this.sessionStore.setSession({
      ...session,
      tmuxTarget,
      ...(tmuxTarget.startsWith("%")
        ? { tmuxPaneId: tmuxTarget }
        : session.tmuxPaneId
          ? { tmuxPaneId: session.tmuxPaneId }
          : {}),
      lastTmuxNudgeAt,
    });
    this.tmuxNudgeFailureNoticeAt.delete(sessionId);

    this.logger.info("tmux nudge sent", {
      sessionId,
      reason: input.reason,
      message: input.message,
      tmuxSessionName: session.tmuxSessionName,
      tmuxTarget,
      inboxCount,
      lastTmuxNudgeAt,
    });
  }

  private async tryRecoverTmuxTarget(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
  ): Promise<string | null> {
    const recoveredTarget = await resolveTmuxTargetFromHint(this.config.tmux, {
      tmuxSessionName: session.tmuxSessionName,
      tmuxWindowName: session.tmuxWindowName,
      tmuxWindowIndex: session.tmuxWindowIndex,
      tmuxPaneId: session.tmuxPaneId,
      tmuxPaneIndex: session.tmuxPaneIndex,
      tmuxTarget: session.tmuxTarget,
    });

    if (!recoveredTarget || recoveredTarget === session.tmuxTarget) {
      return recoveredTarget;
    }

    await this.sessionStore.setSession({
      ...session,
      tmuxTarget: recoveredTarget,
      tmuxPaneId: recoveredTarget,
      updatedAt: new Date().toISOString(),
    });

    this.logger.warn("tmux target auto-recovered", {
      sessionId,
      previousTmuxTarget: session.tmuxTarget,
      recoveredTmuxTarget: recoveredTarget,
      tmuxSessionName: session.tmuxSessionName,
      tmuxWindowName: session.tmuxWindowName,
      tmuxWindowIndex: session.tmuxWindowIndex,
      tmuxPaneIndex: session.tmuxPaneIndex,
    });

    return recoveredTarget;
  }

  private async notifyTmuxTargetInvalid(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
    error: unknown,
  ): Promise<void> {
    const binding = await this.bindingStore.getBinding(sessionId);
    if (!binding) {
      return;
    }

    const nowMs = Date.now();
    const lastNoticeAt = this.tmuxNudgeFailureNoticeAt.get(sessionId);
    if (
      lastNoticeAt &&
      nowMs - lastNoticeAt < TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS
    ) {
      return;
    }

    this.tmuxNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const tmuxTarget = session.tmuxTarget ?? "unknown";
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    try {
      await this.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.t(locale, "menu:notices.tmux.target_invalid_title", {
            sessionName: sessionLabel,
          }),
          this.t(locale, "menu:notices.tmux.target_invalid_target", {
            tmuxTarget,
          }),
          this.t(locale, "menu:system.error_prefix", {
            message: errorMessage,
          }),
          this.t(locale, "menu:system.tmux_recreated_hint"),
          this.t(locale, "menu:notices.tmux.target_invalid_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.logger.warn("Failed to deliver tmux target failure notification", {
        sessionId,
        tmuxTarget,
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
        notifyError:
          notifyError instanceof Error
            ? (notifyError.stack ?? notifyError.message)
            : String(notifyError),
      });
    }
  }

  private async notifyTmuxUnavailable(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
    error: unknown,
  ): Promise<void> {
    const binding = await this.bindingStore.getBinding(sessionId);
    if (!binding) {
      return;
    }

    const nowMs = Date.now();
    const lastNoticeAt = this.tmuxNudgeFailureNoticeAt.get(sessionId);
    if (
      lastNoticeAt &&
      nowMs - lastNoticeAt < TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS
    ) {
      return;
    }

    this.tmuxNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const tmuxTarget = session.tmuxTarget ?? "unknown";
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    try {
      await this.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.t(locale, "menu:notices.tmux.unavailable_title", {
            sessionName: sessionLabel,
          }),
          this.t(locale, "menu:notices.tmux.unavailable_body"),
          this.t(locale, "menu:notices.tmux.unavailable_target", {
            tmuxTarget,
          }),
          this.t(locale, "menu:system.error_prefix", {
            message: errorMessage,
          }),
          this.t(locale, "menu:notices.tmux.unavailable_reason"),
          this.t(locale, "menu:notices.tmux.unavailable_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.logger.warn("Failed to deliver tmux unavailable notification", {
        sessionId,
        tmuxTarget,
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
        notifyError:
          notifyError instanceof Error
            ? (notifyError.stack ?? notifyError.message)
            : String(notifyError),
      });
    }
  }

  private async scanTmuxPromptForSession(
    session: Awaited<ReturnType<SessionStore["listSessions"]>>[number],
  ): Promise<void> {
    if (!session.tmuxTarget) {
      this.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    const binding = await this.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      this.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    let tmuxTarget = session.tmuxTarget;
    let capture: string;

    try {
      capture = await this.captureTmuxPromptBuffer(session);
    } catch (error) {
      if (isTmuxUnavailableError(error)) {
        this.logger.debug("tmux prompt scan skipped because tmux is unavailable", {
          sessionId: session.sessionId,
          tmuxTarget,
        });
        return;
      }

      if (isTmuxTargetInvalidError(error)) {
        const recoveredTarget = await this.tryRecoverTmuxTarget(
          session.sessionId,
          session,
        );

        if (!recoveredTarget) {
          this.logger.debug("tmux prompt scan skipped because target is invalid", {
            sessionId: session.sessionId,
            tmuxTarget,
          });
          return;
        }

        tmuxTarget = recoveredTarget;
        capture = await this.captureTmuxPromptBuffer({
          ...session,
          tmuxTarget: recoveredTarget,
          tmuxPaneId: recoveredTarget.startsWith("%")
            ? recoveredTarget
            : session.tmuxPaneId,
        });
      } else {
        this.logger.warn("tmux prompt scan capture failed", {
          sessionId: session.sessionId,
          tmuxTarget,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        return;
      }
    }

    const detection = detectTmuxInteractivePrompt(capture, {
      strategy: this.config.tmux.promptScanStrategy,
      minScore: this.config.tmux.promptScanMinScore,
    });

    if (!detection) {
      this.logger.debug("tmux prompt scan found no interactive prompt", {
        sessionId: session.sessionId,
        tmuxTarget,
        strategy: this.config.tmux.promptScanStrategy,
        minScore: this.config.tmux.promptScanMinScore,
      });
      this.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    if (!this.shouldSendTmuxPromptNotice(session.sessionId, detection)) {
      return;
    }

    await this.notifyTmuxPromptDetected(session, binding, detection, tmuxTarget);
  }

  private async captureTmuxPromptBuffer(session: {
    sessionId: string;
    tmuxTarget?: string | undefined;
    tmuxPaneId?: string | undefined;
  }): Promise<string> {
    const target = session.tmuxTarget;
    if (!target) {
      throw new Error("tmux target is not configured");
    }

    if (this.config.tmux.captureMode === "visible") {
      return captureVisibleTmuxPane(
        this.config.tmux,
        target,
        this.config.tmux.captureLines,
        this.config.webapp.visibleScreens,
      );
    }

    return captureTmuxPaneRange(
      this.config.tmux,
      target,
      `-${this.config.tmux.captureLines}`,
      false,
    );
  }

  private shouldSendTmuxPromptNotice(
    sessionId: string,
    detection: TmuxPromptDetection,
  ): boolean {
    const existing = this.tmuxPromptNoticeState.get(sessionId);
    const nowMs = Date.now();
    const cooldownMs = this.config.tmux.promptScanCooldownSeconds * 1000;

    if (
      existing &&
      existing.fingerprint === detection.fingerprint &&
      nowMs - existing.sentAtMs < cooldownMs
    ) {
      this.logger.debug("tmux prompt detected but notification is on cooldown", {
        sessionId,
        fingerprint: detection.fingerprint,
        score: detection.score,
        reasons: detection.reasons,
        cooldownSeconds: this.config.tmux.promptScanCooldownSeconds,
      });
      return false;
    }

    this.tmuxPromptNoticeState.set(sessionId, {
      fingerprint: detection.fingerprint,
      sentAtMs: nowMs,
    });
    return true;
  }

  private async notifyTmuxPromptDetected(
    session: Awaited<ReturnType<SessionStore["listSessions"]>>[number],
    binding: Awaited<ReturnType<SessionBindingStore["getBinding"]>>,
    detection: TmuxPromptDetection,
    tmuxTarget: string,
  ): Promise<void> {
    if (!binding) {
      return;
    }

    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );
    const sessionLabel = session.label ?? session.sessionId;
    const excerpt = detection.matchedLines
      .slice(-TMUX_PROMPT_SCAN_MATCHED_LINES_LIMIT)
      .join("\n");

    await this.sendNotification({
      sessionId: session.sessionId,
      sessionLabel: "TellyMCP",
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        this.t(locale, "menu:notices.tmux.prompt_detected_title", {
          sessionName: sessionLabel,
        }),
        this.t(locale, "menu:notices.tmux.prompt_detected_score", {
          score: detection.score,
        }),
        this.t(locale, "menu:notices.tmux.prompt_detected_target", {
          tmuxTarget,
        }),
        this.t(locale, "menu:notices.tmux.prompt_detected_hint"),
        this.t(locale, "menu:notices.tmux.prompt_detected_excerpt"),
        excerpt,
      ].join("\n"),
    });

    try {
      await this.sendLiveViewLauncherMessage({
        principal: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        sessionId: session.sessionId,
        sessionName: sessionLabel,
        locale,
      });
    } catch (error) {
      this.logger.warn("Failed to deliver tmux prompt live launcher", {
        sessionId: session.sessionId,
        tmuxTarget,
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }

    this.logger.info("tmux prompt detected", {
      sessionId: session.sessionId,
      tmuxTarget,
      score: detection.score,
      strategy: this.config.tmux.promptScanStrategy,
      minScore: this.config.tmux.promptScanMinScore,
      reasons: detection.reasons,
      fingerprint: detection.fingerprint,
      matchedLines: detection.matchedLines,
      excerpt,
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
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
      this.t(locale, "menu:main.screen.title", { sessionName }),
      "",
      this.t(locale, "menu:main.screen.inbox_messages", { count: inboxCount }),
      ...(projectName
        ? [this.t(locale, "menu:main.screen.project", { projectName })]
        : []),
      ...(session?.linkedSessionId
        ? [
            this.t(locale, "menu:main.screen.partner", {
              partnerName: escapeHtml(
                linkedSession?.label ?? session.linkedSessionId,
              ),
            }),
            "",
            this.t(locale, "menu:main.screen.partner_hint"),
          ]
        : ["", this.t(locale, "menu:main.screen.link_hint")]),
    ].join("\n");
  }

  private async showAdminMainMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildAdminMainMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.adminMainMenu,
    );
  }

  private async buildAdminMainMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    let clients: AdminClientViewRecord[] | null = null;
    try {
      clients = await this.listGatewayAdminClients();
    } catch (error) {
      this.logger.warn("Failed to load gateway clients for admin main menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [
      this.t(locale, "menu:admin.screen.title"),
      "",
      ...(clients
        ? [
            this.t(locale, "menu:admin.screen.gateway_clients", {
              count: clients.length,
            }),
            this.t(locale, "menu:admin.screen.gateway_clients_connected", {
              count: clients.filter((client) => client.is_connected).length,
            }),
            this.t(locale, "menu:admin.screen.gateway_clients_registered", {
              count: clients.filter((client) => client.is_registered).length,
            }),
          ]
        : [this.t(locale, "menu:admin.screen.gateway_clients_unavailable")]),
      "",
      this.t(locale, "menu:admin.screen.hint"),
    ].join("\n");
  }

  private async showAdminClientsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildAdminClientsMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.adminClientsMenu,
    );
  }

  private async showAdminClientSessionsMenu(
    ctx: TelegramMenuContext,
    client?: AdminClientViewRecord,
  ): Promise<void> {
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await this.showAdminClientsMenu(ctx);
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    if (client) {
      this.adminClientViewByPrincipal.set(principalKey, client);
    }

    const selectedClient = this.adminClientViewByPrincipal.get(principalKey);
    if (!selectedClient) {
      await this.showAdminClientsMenu(
        ctx,
        await this.tForContext(ctx, "menu:admin.client_sessions.no_client_selected"),
      );
      return;
    }

    const text = await this.buildAdminClientSessionsMenuText(ctx, selectedClient);
    await this.renderMenuHtmlScreen(
      ctx,
      text,
      { kind: "menu" },
      this.adminClientSessionsMenu,
    );
  }

  private async showAdminClientSessionDetail(
    ctx: TelegramMenuContext,
    input: {
      sessionId: string;
      targetSessionId: string;
      targetSessionLabel: string;
      targetClientUuid: string;
      targetLocalSessionId: string;
      projectUuid?: string;
      projectName?: string;
    },
    payloadKey: string,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const lines = [
      this.t(locale, "menu:admin.client_session_detail.title"),
      "",
      this.t(locale, "menu:admin.client_session_detail.session", {
        sessionName: escapeHtml(input.targetSessionLabel),
      }),
      `ID: <code>${escapeHtml(input.targetLocalSessionId)}</code>`,
      ...(input.projectName
        ? [
            this.t(locale, "menu:admin.client_session_detail.project", {
              projectName: escapeHtml(input.projectName),
            }),
          ]
        : []),
    ];

    const keyboard = new InlineKeyboard();
    keyboard.text(
      this.t(locale, "menu:admin.client_session_detail.bind"),
      `admin-client-session-bind:${payloadKey}`,
    );
    if (this.buildLiveViewUrlForSessionTarget({
      targetSessionId: input.targetSessionId,
      targetClientUuid: input.targetClientUuid,
      targetLocalSessionId: input.targetLocalSessionId,
    })) {
      keyboard.text("🖥 Live", `admin-client-session-live:${payloadKey}`).row();
    } else {
      keyboard.row();
    }
    keyboard.text(
      this.t(locale, "menu:admin.client_session_detail.back_to_sessions"),
      "admin-client-sessions-back",
    );

    if (ctx.callbackQuery?.message) {
      await this.editText(
        ctx,
        lines.join("\n"),
        { kind: "menu", sessionId: input.targetLocalSessionId },
        { parse_mode: "HTML", reply_markup: keyboard },
      );
      return;
    }

    await this.replyText(
      ctx,
      lines.join("\n"),
      { kind: "menu", sessionId: input.targetLocalSessionId },
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  }

  private async buildAdminClientsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    let clients: AdminClientViewRecord[];
    try {
      clients = await this.listGatewayAdminClients();
    } catch (error) {
      this.logger.warn("Failed to load gateway clients for admin clients menu", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [
        this.t(locale, "menu:admin.clients.title"),
        "",
        this.t(locale, "menu:admin.clients.unavailable"),
      ].join("\n");
    }
    const lines = [this.t(locale, "menu:admin.clients.title"), ""];

    if (clients.length === 0) {
      lines.push(this.t(locale, "menu:admin.clients.empty"));
      return lines.join("\n");
    }

    lines.push(
      this.t(locale, "menu:admin.clients.connected_count", {
        count: clients.filter((client) => client.is_connected).length,
      }),
    );
    lines.push(
      this.t(locale, "menu:admin.clients.registered_count", {
        count: clients.filter((client) => client.is_registered).length,
      }),
    );
    lines.push("");
    lines.push(this.t(locale, "menu:admin.clients.legend"));

    return lines.join("\n");
  }

  private buildAdminClientTitle(client: AdminClientViewRecord): string {
    const displayName = client.telegram_display_name?.trim() || "";
    const telegramUsername = client.telegram_username?.trim().replace(/^@/u, "") || "";
    const botUsername = client.bot_username?.trim().replace(/^@/u, "") || "";
    const clientLabel = client.client_label?.trim() || "";
    const namespace = client.namespace?.trim() || "";
    const nodeId = client.node_id?.trim() || "";
    const runtimeLabel =
      [namespace, nodeId].filter(Boolean).join("/") || nodeId || "";
    const fallback = (clientLabel || runtimeLabel || client.client_uuid).trim();

    const identityParts = [
      displayName || null,
      !displayName && telegramUsername ? `@${telegramUsername}` : null,
      !displayName && !telegramUsername && clientLabel ? clientLabel : null,
      !displayName && !telegramUsername && !clientLabel && runtimeLabel
        ? runtimeLabel
        : null,
      botUsername ? `🤖@${botUsername}` : null,
    ].filter(Boolean);

    return identityParts.length > 0 ? identityParts.join(" · ") : fallback;
  }

  private buildAdminClientButtonLabel(client: AdminClientViewRecord): string {
    const markers = [
      client.is_connected ? "🟢" : null,
      client.is_registered ? "🗂" : null,
    ]
      .filter(Boolean)
      .join("");
    const prefix = markers ? `${markers} ` : "";
    return `${prefix}${this.buildAdminClientTitle(client)}`.slice(0, 56);
  }

  private buildAdminClientSessionButtonLabel(
    session: Pick<
      AdminClientSessionViewRecord,
      "label" | "local_session_id" | "project_name"
    >,
  ): string {
    const sessionName = (session.label?.trim() || session.local_session_id).trim();
    const projectName = session.project_name?.trim() || null;
    return projectName
      ? `${sessionName} · ${projectName}`.slice(0, 56)
      : sessionName.slice(0, 56);
  }

  private async buildAdminClientSessionsMenuText(
    ctx: TelegramMenuContext,
    client: AdminClientViewRecord,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const clientTitle = this.buildAdminClientTitle(client);
    return [
      this.t(locale, "menu:admin.client_sessions.title"),
      "",
      this.t(locale, "menu:admin.client_sessions.client", {
        client: escapeHtml(clientTitle),
      }),
      "",
      this.t(locale, "menu:admin.client_sessions.choose_scope"),
    ].join("\n");
  }

  private async listGatewayAdminClientSessions(
    clientUuid: string,
    scope: "collab" | "all",
  ): Promise<AdminClientSessionViewRecord[]> {
    const collabSessions = await this.listGatewayClientSessions(clientUuid);

    if (scope === "collab") {
      return collabSessions.map((session) => ({
        ...session,
        is_collab: true,
      }));
    }

    const connectedClients = await this.listGatewayConnectedClients();
    const connectedClient = connectedClients.find(
      (client) => client.client_uuid === clientUuid,
    );

    const merged = new Map<string, AdminClientSessionViewRecord>();

    for (const session of collabSessions) {
      merged.set(session.local_session_id, {
        ...session,
        is_collab: true,
      });
    }

    for (const sessionTool of connectedClient?.session_tools ?? []) {
      const key = sessionTool.local_session_id;
      const existing = merged.get(key);

      merged.set(key, {
        session_uuid: existing?.session_uuid ?? key,
        client_uuid: clientUuid,
        local_session_id: key,
        label: existing?.label ?? sessionTool.session_label ?? key,
        status: existing?.status ?? "connected",
        ...(existing?.project_uuid ? { project_uuid: existing.project_uuid } : {}),
        ...(existing?.project_name ? { project_name: existing.project_name } : {}),
        ...(existing?.updated_at ? { updated_at: existing.updated_at } : {}),
        is_connected: true,
        is_collab: existing?.is_collab ?? false,
      });
    }

    return Array.from(merged.values()).sort((left, right) =>
      (left.label ?? left.local_session_id).localeCompare(
        right.label ?? right.local_session_id,
      ),
    );
  }

  private buildAdminClientSessionViewButtonLabel(
    session: AdminClientSessionViewRecord,
  ): string {
    const markers = [
      session.is_connected ? "🟢" : null,
      session.is_collab ? "👥" : null,
    ]
      .filter(Boolean)
      .join("");
    const prefix = markers ? `${markers} ` : "";
    return `${prefix}${this.buildAdminClientSessionButtonLabel(session)}`.slice(0, 56);
  }

  private async showAdminClientSessionList(
    ctx: TelegramMenuContext,
    scope: "collab" | "all",
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await this.showAdminClientsMenu(ctx);
      return;
    }

    const client = this.adminClientViewByPrincipal.get(buildPrincipalKey(principal));
    if (!client) {
      await this.showAdminClientsMenu(
        ctx,
        await this.tForContext(ctx, "menu:admin.client_sessions.no_client_selected"),
      );
      return;
    }

    let sessions: AdminClientSessionViewRecord[];
    try {
      sessions = await this.listGatewayAdminClientSessions(client.client_uuid, scope);
    } catch (error) {
      this.logger.warn("Failed to load admin client session list", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        clientUuid: client.client_uuid,
        scope,
        error: error instanceof Error ? error.message : String(error),
      });
      const text = [
        this.t(locale, "menu:admin.client_sessions.title"),
        "",
        this.t(locale, "menu:admin.client_sessions.unavailable"),
      ].join("\n");
      const replyMarkup = new InlineKeyboard().text(
        this.t(locale, "menu:admin.client_sessions.back_to_scope"),
        "admin-client-session-list-back",
      );
      if (ctx.callbackQuery?.message) {
        await this.editText(ctx, text, { kind: "menu" }, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } else {
        await this.replyText(
          ctx,
          text,
          { kind: "menu" },
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
      }
      return;
    }

    const titleKey =
      scope === "all"
        ? "menu:admin.client_sessions.scope_all"
        : "menu:admin.client_sessions.scope_collab";

    const lines = [
      this.t(locale, "menu:admin.client_sessions.title"),
      "",
      this.t(locale, titleKey),
      this.t(locale, "menu:admin.client_sessions.client", {
        client: escapeHtml(this.buildAdminClientTitle(client)),
      }),
      "",
    ];

    if (sessions.length === 0) {
      lines.push(
        this.t(
          locale,
          scope === "all"
            ? "menu:admin.client_sessions.empty_all"
            : "menu:admin.client_sessions.empty",
        ),
      );
    } else {
      lines.push(this.t(locale, "menu:admin.client_sessions.choose"));
    }

    const keyboard = new InlineKeyboard();
    for (const session of sessions) {
      const payloadKey = await this.createAdminClientSessionMenuPayload(session);
      keyboard
        .text(
          this.buildAdminClientSessionViewButtonLabel(session),
          `admin-client-session-open:${payloadKey}`,
        )
        .row();
    }
    keyboard.text(
      this.t(locale, "menu:admin.client_sessions.back_to_scope"),
      "admin-client-session-list-back",
    );

    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      await this.editText(ctx, text, { kind: "menu" }, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    }
    await this.replyText(
      ctx,
      text,
      { kind: "menu" },
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
  }

  private async showAdminToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildAdminToolsMenuText(ctx);
    const intro = introText ? escapeHtml(introText) : null;
    await this.renderMenuHtmlScreen(
      ctx,
      intro ? `${intro}\n\n${text}` : text,
      { kind: "menu" },
      this.adminToolsMenu,
    );
  }

  private async buildAdminToolsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    return [
      this.t(locale, "menu:admin.tools.title"),
      "",
      this.t(locale, "menu:admin.tools.client_env_help"),
    ].join("\n");
  }

  private buildClientEnvFromGatewayConfig(): string {
    const gatewayPublicUrl = this.config.distributed.gatewayPublicUrl ?? "";
    const gatewayWsUrl =
      this.config.distributed.gatewayWsUrl?.trim() ||
      (gatewayPublicUrl
        ? gatewayPublicUrl.replace(/^http/u, "ws").replace(/\/gateway$/u, "/gateway/ws")
        : "");
    const webappPublicUrl =
      this.config.webapp.publicUrl?.trim() ||
      (gatewayPublicUrl
        ? gatewayPublicUrl.replace(/\/gateway$/u, "/webapp")
        : "");
    const tokenBindingSecret =
      typeof process.env.TOKEN_BINDING_SECRET === "string"
        ? process.env.TOKEN_BINDING_SECRET.trim()
        : "";
    const nodeId =
      typeof process.env.NODE_ID === "string" && process.env.NODE_ID.trim()
        ? process.env.NODE_ID.trim()
        : "client";
    const namespace =
      typeof process.env.NAMESPACE === "string" && process.env.NAMESPACE.trim()
        ? process.env.NAMESPACE.trim()
        : "mcp";

    return [
      "# TellyMCP client node",
      "",
      "TELEGRAM_BOT_TOKEN=",
      "TELEGRAM_BOT_USERNAME=",
      "# DEBUG_LANGUAGE=ru",
      "PROJECT_NAME=",
      "",
      "REDIS_HOST=127.0.0.1",
      "REDIS_PORT=6379",
      "REDIS_DB=1",
      "",
      `MODE=${this.config.mode}`,
      `PAIR_CODE_TTL_SECONDS=${this.config.pairCodeTtlSeconds}`,
      "",
      "MCP_HTTP_HOST=127.0.0.1",
      "MCP_HTTP_PORT=8787",
      `MCP_HTTP_PATH=${this.config.mcp.httpPath}`,
      "# MCP_HTTP_BEARER_TOKEN=",
      `MCP_HTTP_ENABLE_DEBUG_ROUTES=${String(this.config.mcp.enableDebugRoutes)}`,
      `MCP_HTTP_ENABLE_PRUNE_ROUTE=${String(this.config.mcp.enablePruneRoute)}`,
      "",
      "DISTRIBUTED_MODE=client",
      `GATEWAY_PUBLIC_URL=${gatewayPublicUrl}`,
      `GATEWAY_WS_URL=${gatewayWsUrl}`,
      `GATEWAY_WS_PATH=${this.config.distributed.gatewayWsPath}`,
      "# GATEWAY_TOKEN=",
      `GATEWAY_TOKEN=${this.config.distributed.gatewayToken ?? ""}`,
      `GATEWAY_AUTH_TOKEN=${this.config.distributed.gatewayAuthToken ?? ""}`,
      "",
      `WEBAPP_ENABLED=${String(this.config.webapp.enabled)}`,
      `WEBAPP_BASE_PATH=${this.config.webapp.basePath}`,
      `WEBAPP_PUBLIC_URL=${webappPublicUrl}`,
      `WEBAPP_INITDATA_TTL_SECONDS=${this.config.webapp.initDataTtlSeconds}`,
      `WEBAPP_SESSION_TTL_SECONDS=${this.config.webapp.sessionTtlSeconds}`,
      `WEBAPP_LAUNCH_MODE=${this.config.webapp.launchMode}`,
      `WEBAPP_VISIBLE_SCREENS=${this.config.webapp.visibleScreens}`,
      `WEBAPP_POLL_INTERVAL_MS=${this.config.webapp.pollIntervalMs}`,
      `WEBAPP_ACTION_COOLDOWN_MS=${this.config.webapp.actionCooldownMs}`,
      "",
      "MCP_XCHANGE_DIR=.mcp-xchange",
      "",
      `TMUX_NUDGE_ENABLED=${String(this.config.tmux.nudgeEnabled)}`,
      `TMUX_NUDGE_DEBOUNCE_SECONDS=${this.config.tmux.nudgeDebounceSeconds}`,
      `TMUX_NUDGE_COOLDOWN_SECONDS=${this.config.tmux.nudgeCooldownSeconds}`,
      `TMUX_NUDGE_MESSAGE=${this.config.tmux.nudgeMessage}`,
      `TMUX_PARTNER_NUDGE_MESSAGE=${this.config.tmux.partnerNudgeMessage}`,
      `TMUX_CAPTURE_MODE=${this.config.tmux.captureMode}`,
      `TMUX_CAPTURE_LINES=${this.config.tmux.captureLines}`,
      `TMUX_PROMPT_SCAN_ENABLED=${String(this.config.tmux.promptScanEnabled)}`,
      `TMUX_PROMPT_SCAN_INTERVAL_SECONDS=${this.config.tmux.promptScanIntervalSeconds}`,
      `TMUX_PROMPT_SCAN_COOLDOWN_SECONDS=${this.config.tmux.promptScanCooldownSeconds}`,
      `TMUX_PROMPT_SCAN_STRATEGY=${this.config.tmux.promptScanStrategy}`,
      `TMUX_PROMPT_SCAN_MIN_SCORE=${this.config.tmux.promptScanMinScore}`,
      "# TMUX_SOCKET_PATH=",
      "",
      `BROWSER_ENABLED=${String(this.config.browser.enabled)}`,
      `BROWSER_HEADLESS=${String(this.config.browser.headless)}`,
      `BROWSER_DEVTOOLS=${String(this.config.browser.devtools)}`,
      `BROWSER_ADDRESS=${this.config.browser.address ?? "http://localhost:5173"}`,
      `BROWSER_TIMEOUT_MS=${this.config.browser.timeoutMs}`,
      `BROWSER_MAX_EVENTS=${this.config.browser.maxEvents}`,
      `BROWSER_WAIT_UNTIL=${this.config.browser.waitUntil}`,
      ...(this.config.browser.executablePath
        ? [`BROWSER_EXECUTABLE_PATH=${this.config.browser.executablePath}`]
        : ["# BROWSER_EXECUTABLE_PATH="]),
      ...(this.config.browser.channel
        ? [`BROWSER_CHANNEL=${this.config.browser.channel}`]
        : ["# BROWSER_CHANNEL=chrome"]),
      `BROWSER_SLOW_MO_MS=${this.config.browser.slowMoMs}`,
      "",
      `TELEGRAM_POLL_INTERVAL_MS=${this.config.telegram.pollIntervalMs}`,
      `TELEGRAM_DEFAULT_TIMEOUT_SECONDS=${this.config.telegram.defaultTimeoutSeconds}`,
      `TELEGRAM_MAX_CONTEXT_CHARS=${this.config.telegram.maxContextChars}`,
      `TELEGRAM_MAX_QUESTION_CHARS=${this.config.telegram.maxQuestionChars}`,
      `TELEGRAM_MAX_MESSAGE_CHARS=${this.config.telegram.maxMessageChars}`,
      `TELEGRAM_INBOX_BATCH_SIZE=${this.config.telegram.inboxBatchSize}`,
      `TELEGRAM_MENU_PAYLOAD_TTL_SECONDS=${this.config.telegram.menuPayloadTtlSeconds}`,
      "",
      "# PROXY_USE=http",
      "# HTTP_PROXY=",
      "# SOCKS5_PROXY=",
      "",
      `NAMESPACE=${namespace}`,
      `NODE_ID=${this.isAdminBotProfile() ? "client" : nodeId}`,
      "ENABLE_LOGFEED=0",
      `LOG_LEVEL=${this.config.logging.level}`,
      `LOG_FILE_ENABLED=${String(this.config.logging.fileEnabled)}`,
      `LOG_FILE_PATH=${this.config.logging.filePath}`,
      ...(tokenBindingSecret
        ? ["", `TOKEN_BINDING_SECRET=${tokenBindingSecret}`]
        : []),
      "",
    ].join("\n");
  }

  private async handleAdminClientEnvExport(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const content = this.buildClientEnvFromGatewayConfig();
    await this.replyDocumentWithRetry(
      ctx,
      new InputFile(Buffer.from(content, "utf8"), ".env-client"),
      {
        caption: this.t(locale, "menu:admin.tools.client_env_caption"),
      },
      { kind: "menu" },
    );
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.tools.client_env_sent"),
      });
    }
  }

  private async getTmuxStatusLine(locale: SupportedLocale): Promise<string> {
    return this.t(locale, "menu:main.screen.tmux_mode_direct");
  }

  private async buildMainMenuFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const count = await this.inboxStore.countInboxMessages(sessionId);
    const session = await this.sessionStore.getSession(sessionId);
    return `${locale}:${sessionId}:${count}:${session?.linkedSessionId ?? "none"}`;
  }

  private async buildInboxFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const messages = await this.inboxStore.listInboxMessages(sessionId, 10);
    return `${locale}:${sessionId}:${messages.map((message) => message.id).join(",")}`;
  }

  private async buildStorageFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const entries = await this.listActiveSessionStorageEntries(sessionId);
    return `${locale}:${sessionId}:${entries.map((entry) => entry.filePath).join(",")}`;
  }

  private async buildScreenshotsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return `${locale}:no-active-session`;
    }

    const files = await this.listActiveSessionScreenshots(sessionId);
    return `${locale}:${sessionId}:${files.join(",")}`;
  }

  private async buildSessionsFingerprint(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    try {
      const locale = await this.resolveLocaleForContext(ctx);
      const principal = this.getPrincipalFromContext(ctx);
      if (!principal) {
        return `${locale}:no-principal`;
      }

      const activeSessionId =
        await this.bindingStore.getActiveSessionIdForPrincipal(principal);
      const sessionIds = (
        await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
      ).sort();

      return `${locale}:${activeSessionId ?? "none"}:${sessionIds.join(",")}`;
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return `${locale}:no-principal`;
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return `${locale}:no-active-session`;
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const sessionIds = (
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
    )
      .filter((sessionId) => sessionId !== activeSessionId)
      .sort();

    return `${locale}:${activeSessionId}:${session?.linkedSessionId ?? "none"}:${sessionIds.join(",")}`;
  }

  private async buildInboxButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "menu:inbox.button");
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.t(locale, "menu:inbox.button");
    }

    const count = await this.inboxStore.countInboxMessages(sessionId);
    return count > 0
      ? this.t(locale, "menu:inbox.button_count", { count })
      : this.t(locale, "menu:inbox.button");
  }

  private async buildScreenshotsButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "menu:browser.buttons.screenshots");
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.t(locale, "menu:browser.buttons.screenshots");
    }

    const count = (await this.listActiveSessionScreenshots(sessionId)).length;
    return count > 0
      ? this.t(locale, "menu:browser.buttons.screenshots_count", { count })
      : this.t(locale, "menu:browser.buttons.screenshots");
  }

  private async buildLinkButtonLabel(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "menu:local.buttons.link");
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.t(locale, "menu:local.buttons.link");
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      return this.t(locale, "menu:local.buttons.link");
    }

    const linkedSession = await this.sessionStore.getSession(
      session.linkedSessionId,
    );
    return linkedSession?.label
      ? this.t(locale, "menu:link.buttons.unlink_with_name", {
          sessionName: linkedSession.label,
        })
      : this.t(locale, "menu:link.buttons.unlink");
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

  private async createAdminClientMenuPayload(
    client: AdminClientViewRecord,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "admin-client",
        sessionId: client.client_uuid,
        targetClientUuid: client.client_uuid,
        title: this.buildAdminClientTitle(client),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + this.config.telegram.menuPayloadTtlSeconds * 1000,
        ).toISOString(),
      },
      this.config.telegram.menuPayloadTtlSeconds,
    );

    return key;
  }

  private async createAdminClientSessionMenuPayload(
    session: AdminClientSessionViewRecord,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "admin-client-session",
        sessionId: session.local_session_id,
        targetSessionId: session.session_uuid || session.local_session_id,
        targetClientUuid: session.client_uuid,
        targetLocalSessionId: session.local_session_id,
        title: session.label ?? session.local_session_id,
        ...(session.project_uuid ? { projectUuid: session.project_uuid } : {}),
        ...(session.project_name ? { projectName: session.project_name } : {}),
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

  private async createProjectDeleteMenuPayload(
    sessionId: string,
    projectUuid: string,
    title: string,
  ): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "project-delete-entry",
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

  private async createLiveApprovalMenuPayload(input: {
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  }): Promise<string> {
    const key = createMenuPayloadKey();
    const now = new Date();
    await this.menuPayloadStore.createMenuPayload(
      {
        key,
        kind: "live-approval",
        sessionId: input.sessionId,
        sourceSessionId: input.sourceSessionId,
        sourceSessionLabel: input.sourceSessionLabel,
        sourceClientUuid: input.sourceClientUuid,
        sourceLocalSessionId: input.sourceLocalSessionId,
        targetSessionId: input.targetSessionId,
        title: input.targetSessionLabel,
        targetClientUuid: input.targetClientUuid,
        targetLocalSessionId: input.targetLocalSessionId,
        ...(input.projectUuid ? { projectUuid: input.projectUuid } : {}),
        ...(input.projectName ? { projectName: input.projectName } : {}),
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
    const files = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, files);
    const uploadFiles = metas
      .filter((meta) => meta.source === "telegram-upload")
      .map((meta) => meta.filePath)
      .filter((filePath) => files.includes(filePath));

    return uploadFiles.sort((left, right) => right.localeCompare(left));
  }

  private async listActiveSessionStorageEntries(sessionId: string): Promise<
  Array<{
      filePath: string;
      meta: TelegramXchangeFileMeta | null;
    }>
  > {
    const filePaths = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, filePaths);
    const metaByPath = new Map(metas.map((meta) => [meta.filePath, meta] as const));
    return filePaths.map((filePath) => ({
      filePath,
      meta: metaByPath.get(filePath) ?? null,
    }));
  }

  private async listActiveSessionScreenshots(
    sessionId: string,
  ): Promise<string[]> {
    const files = await this.listSessionFilesystemXchangeFiles(sessionId);
    const metas = await this.listReconciledSessionXchangeMetas(sessionId, files);
    const screenshots = metas
      .filter((meta) => meta.source === "browser-screenshot")
      .map((meta) => meta.filePath)
      .filter((filePath) => files.includes(filePath));

    return screenshots.sort((left, right) => right.localeCompare(left));
  }

  private async listSessionFilesystemXchangeFiles(
    sessionId: string,
  ): Promise<string[]> {
    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = session?.cwd?.trim() || "";
    const resolvedWorkspaceDir = workspaceDir || process.cwd();
    const files = await listXchangeFiles(
      this.config.tmux,
      resolvedWorkspaceDir,
      this.config.exchange.dir,
    );
    return files.sort((left, right) => right.localeCompare(left));
  }

  private async listReconciledSessionXchangeMetas(
    sessionId: string,
    existingFiles: string[],
  ): Promise<TelegramXchangeFileMeta[]> {
    const metas = await this.xchangeFileMetaStore.listXchangeFileMetas(sessionId);
    if (metas.length === 0) {
      return [];
    }

    const existingSet = new Set(existingFiles);
    const staleMetas = metas.filter((meta) => !existingSet.has(meta.filePath));

    for (const meta of staleMetas) {
      await this.xchangeFileMetaStore.deleteXchangeFileMeta(
        sessionId,
        meta.filePath,
      );
    }

    return metas.filter((meta) => existingSet.has(meta.filePath));
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
    const locale = await this.resolveLocaleForContext(ctx);

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:handoff.prompt_title"),
    });
    const sent = await this.replyText(
      ctx,
      [
        this.t(locale, "menu:handoff.prompt_title"),
        "",
        this.t(locale, "menu:handoff.route", {
          sourceSessionName: session?.label ?? input.sessionId,
          targetSessionName: input.targetSessionLabel,
        }),
        this.t(locale, "menu:handoff.recipient", {
          label: input.targetSessionLabel,
        }),
        this.t(locale, "menu:handoff.file", {
          fileName,
        }),
        "",
        this.t(locale, "menu:handoff.prompt_body"),
        this.t(locale, "menu:handoff.prompt_hint"),
      ].join("\n"),
      { kind: "menu", sessionId: input.sessionId },
      {
        reply_markup: new InlineKeyboard().text(
          this.t(locale, "menu:handoff.cancel"),
          "file-handoff-cancel",
        ),
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (session?.linkedSessionId) {
      await this.unlinkSessions(sessionId, session.linkedSessionId);
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:link.actions.unlinked"),
      });
      await this.showMainMenu(ctx, this.t(locale, "menu:link.actions.unlinked"));
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:link.actions.choose_partner"),
    });
    await this.showLinkMenu(ctx);
  }

  private async showPartnerEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:partner.screen.use_link_first"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: await this.tForContext(ctx, "menu:partner.actions.open_partner_menu"),
    });
    await this.showPartnerMenu(ctx);
  }

  private async showPartnerFiles(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:partner.screen.use_link_first"),
        show_alert: true,
      });
      return;
    }

    const linkedSession = await this.sessionStore.getSession(session.linkedSessionId);
    const files = await this.listActiveSessionFiles(sessionId);
    const lines = [
      this.t(locale, "menu:handoff.choose_title"),
      "",
      this.t(locale, "menu:handoff.choose_recipient", {
        label: linkedSession?.label ?? session.linkedSessionId,
      }),
      "",
      files.length > 0
        ? this.t(locale, "menu:handoff.choose_local")
        : this.t(locale, "menu:handoff.no_files"),
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

    keyboard.text(await this.tForContext(ctx, "common:menu.back"), "partner-back");

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
    await ctx.answerCallbackQuery({
      text: await this.tForContext(ctx, "menu:local.actions.open_local"),
    });
    await this.showLocalMenu(ctx);
  }

  private async showProjectsEntryPoint(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    if (!this.config.distributed.gatewayPublicUrl) {
      await ctx.answerCallbackQuery({
        text: await this.tForContext(ctx, "menu:collab.actions.gateway_only"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: await this.tForContext(ctx, "menu:collab.actions.open_collab"),
    });
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

  private async handleStorageOpen(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );

    await ctx.answerCallbackQuery({ text: "Storage entry opened." });
    await this.editText(
      ctx,
      this.formatStorageDetail(payload.sessionId, payload.filePath, meta),
      {
        kind: "menu",
        sessionId: payload.sessionId,
      },
      { reply_markup: this.storageMessageMenu },
    );
  }

  private async handleStorageGet(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is invalid or expired.",
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

    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );
    let ensured: {
      session: Awaited<ReturnType<SessionStore["getSession"]>>;
      filePath: string;
    };
    try {
      ensured = await this.ensureStoredXchangeFile(
        payload.sessionId,
        payload.filePath,
        meta?.source ?? "telegram-upload",
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text:
          error instanceof Error
            ? error.message
            : "Storage file is not available locally.",
        show_alert: true,
      });
      await this.showStorageMenu(
        ctx,
        "Storage entry is stale or missing locally. You can delete it from Storage.",
      );
      return;
    }

    await this.sendDocumentToChat(
      chatId,
      ensured.filePath,
      `Storage: ${this.formatFilePreviewLabel(ensured.filePath, meta)}`,
    );

    await ctx.answerCallbackQuery({ text: "Storage file sent." });
    await this.showStorageMenu(ctx, "Storage file sent to Telegram.");
  }

  private async handleStorageDelete(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is missing.",
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (!payload || payload.kind !== "file-entry" || !payload.filePath) {
      await ctx.answerCallbackQuery({
        text: "Storage payload is invalid or expired.",
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(payload.sessionId);
    const meta = await this.xchangeFileMetaStore.getXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );

    let deleted = false;
    try {
      deleted = await deleteXchangeFile(
        this.config.tmux,
        session?.cwd?.trim() || process.cwd(),
        this.config.exchange.dir,
        payload.filePath,
      );
    } catch {
      deleted = false;
    }

    await this.objectStore.deleteStoredFile({
      storageRef: meta?.storageRef,
      vfsNodeId: meta?.vfsNodeId,
    });
    await this.xchangeFileMetaStore.deleteXchangeFileMeta(
      payload.sessionId,
      payload.filePath,
    );

    await ctx.answerCallbackQuery({
      text: deleted ? "Storage entry deleted." : "Storage metadata deleted.",
    });
    await this.showStorageMenu(
      ctx,
      deleted
        ? "Storage entry deleted."
        : "Stale storage metadata deleted.",
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

    await this.maybeNotifyToolsMismatchForSession(payload.sessionId);

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

  private formatStoragePreviewLabel(
    filePath: string,
    meta?: TelegramXchangeFileMeta | null,
  ): string {
    const base = this.formatFilePreviewLabel(filePath, meta);
    const prefix =
      meta?.source === "browser-screenshot"
        ? "📸 "
        : meta?.source === "partner-artifact"
          ? "🤝 "
          : "📄 ";
    return `${prefix}${base}`.slice(0, 56);
  }

  private formatStorageDetail(
    sessionId: string,
    filePath: string,
    meta?: TelegramXchangeFileMeta | null,
  ): string {
    return [
      "📦 Storage entry",
      "",
      `Session: ${sessionId}`,
      `File: ${this.formatFilePreviewLabel(filePath, meta)}`,
      ...(meta?.source ? [`Source: ${meta.source}`] : []),
      ...(meta?.uploadedAt ? [`Saved: ${meta.uploadedAt}`] : []),
      ...(meta?.relativePath ? [`Relative: ${meta.relativePath}`] : []),
      ...(meta?.mimeType ? [`MIME: ${meta.mimeType}`] : []),
      ...(typeof meta?.sizeBytes === "number"
        ? [`Size: ${meta.sizeBytes} bytes`]
        : []),
      `Path: ${filePath}`,
      ...(meta?.caption ? ["", "Caption:", meta.caption] : []),
    ].join("\n");
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
    source: TelegramXchangeFileMeta["source"],
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
    const fileUrl = `https://api.telegram.org/file/bot${this.getRequiredBotToken(
      "download Telegram files",
    )}/${telegramFile.file_path}`;
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

  private async resolveLocaleForContext(
    ctx: TelegramMenuContext,
  ): Promise<SupportedLocale> {
    if (this.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.config.telegram.debugLanguage);
    }

    const telegramUserId = ctx.from?.id;
    const telegramLanguageCode = ctx.from?.language_code;
    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  private async resolveLocaleForTelegramUserId(
    telegramUserId?: number,
    telegramLanguageCode?: string | null | undefined,
  ): Promise<SupportedLocale> {
    if (this.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.config.telegram.debugLanguage);
    }

    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  private async tForContext(
    ctx: TelegramMenuContext,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(await this.resolveLocaleForContext(ctx), key, options);
  }

  private async tForTelegramUserId(
    telegramUserId: number | undefined,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(await this.resolveLocaleForTelegramUserId(telegramUserId), key, options);
  }

  private t(
    locale: SupportedLocale,
    key: string,
    options?: Record<string, unknown>,
  ): string {
    return translate(locale, key, options);
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
        await this.tForContext(ctx, "menu:system.sessions_menu_unavailable"),
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

  private async showStorageMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildStorageMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.storageMenu,
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

  private async showCollabToolsMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildCollabToolsMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.collabToolsMenu,
    );
  }

  private buildCollabHistoryMarkdown(input: {
    locale?: SupportedLocale;
    sessionLabel: string;
    history: Array<{
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_name?: string;
      from_label: string;
      to_label: string;
      delivery_status?: string;
    }>;
  }): string {
    const locale = input.locale ?? "en";
    const lines = [
      this.t(locale, "menu:history.title"),
      "",
      this.t(locale, "menu:history.session", {
        sessionName: input.sessionLabel,
      }),
      `Generated at: ${new Date().toISOString()}`,
      "",
    ];

    if (input.history.length === 0) {
      lines.push(this.t(locale, "menu:history.empty"));
      lines.push("");
      return lines.join("\n");
    }

    lines.push("Last 5 events:");
    lines.push("");

    for (const item of input.history) {
      lines.push(`## ${item.kind}`);
      lines.push(`- Time: ${item.created_at}`);
      lines.push(`- Direction: ${item.direction}`);
      lines.push(`- Route: ${item.from_label} -> ${item.to_label}`);
      if (item.project_name) {
        lines.push(
          this.t(locale, "menu:history.project", {
            projectName: item.project_name,
          }),
        );
      }
      if (item.delivery_status) {
        lines.push(`- Status: ${item.delivery_status}`);
      }
      lines.push(`- Summary: ${item.summary || "(empty)"}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  private async handleCollabHistoryExport(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const { principal, session } = await this.loadProjectsContext(ctx);
    if (!this.config.distributed.gatewayPublicUrl || !principal || !session) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:collab.screen.unavailable"),
        show_alert: true,
      });
      return;
    }

    const history = await this.listGatewaySessionHistory(
      principal,
      session.sessionId,
    );
    const markdown = this.buildCollabHistoryMarkdown({
      locale,
      sessionLabel: session.label ?? session.sessionId,
      history,
    });
    const fileName = `collab-history-${slugifyFilenamePart(
      session.label ?? session.sessionId,
    ) || "session"}.md`;

    await this.replyDocumentWithRetry(
      ctx,
      new InputFile(Buffer.from(markdown, "utf8"), fileName),
      {
        caption: this.t(locale, "menu:history.caption", {
          sessionName: session.label ?? session.sessionId,
        }),
      },
      {
        kind: "menu",
        sessionId: session.sessionId,
      },
    );

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:collab.buttons.history"),
    });
  }

  private async showCollabDeleteMenu(
    ctx: TelegramMenuContext,
    introText?: string,
  ): Promise<void> {
    const text = await this.buildCollabDeleteMenuText(ctx);
    await this.renderMenuScreen(
      ctx,
      introText ? `${introText}\n\n${text}` : text,
      { kind: "menu" },
      this.collabDeleteMenu,
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
    const locale = await this.resolveLocaleForContext(ctx);
    await this.replyText(
      ctx,
      [
        this.t(locale, "menu:help.title"),
        "",
        this.t(locale, "menu:help.menu"),
        this.t(locale, "menu:help.help"),
        "",
        this.t(locale, "menu:help.how_it_works"),
        this.t(locale, "menu:help.step_choose"),
        this.t(locale, "menu:help.step_inbox"),
        this.t(locale, "menu:help.step_nudge"),
        this.t(locale, "menu:help.step_tools"),
      ].join("\n"),
      { kind: "menu" },
    );
  }

  private async showLiveViewLauncher(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:live.errors.identity_unavailable"),
        show_alert: true,
      });
      return;
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:live.errors.no_active_session"),
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
        text: this.t(locale, "menu:live.errors.webapp_disabled"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const actor = this.getGatewayActorFromContext(ctx);
    const sent = await this.sendLiveViewLauncherMessage({
      principal,
      sessionId: activeSessionId,
      sessionName: session?.label ?? activeSessionId,
      locale,
      ...(actor ? { actor } : {}),
    });
    if (!sent) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:live.errors.public_url_missing"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:live.actions.opening"),
    });
  }

  private buildLiveViewUrlForSessionTarget(input: {
    targetSessionId: string;
    targetClientUuid?: string | undefined;
    targetLocalSessionId?: string | undefined;
    sourceClientUuid?: string | undefined;
    launchMode?: WebAppLaunchMode | undefined;
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
    const url = new URL(`${baseUrl}/live/${encodeURIComponent(liveSessionId)}`);
    url.searchParams.set(
      "launchMode",
      input.launchMode ?? this.config.webapp.launchMode,
    );
    return url.toString();
  }

  private buildLiveViewLaunchKeyboard(
    getUrl: (mode: WebAppLaunchMode) => string | null,
    locale: SupportedLocale = "en",
  ): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const modes: Array<{ mode: WebAppLaunchMode; label: string }> = [
      {
        mode: "fullscreen",
        label: this.t(locale, "menu:live.buttons.fullscreen"),
      },
      {
        mode: "expand",
        label: this.t(locale, "menu:live.buttons.expand"),
      },
      {
        mode: "default",
        label: this.t(locale, "menu:live.buttons.default"),
      },
    ];

    for (const [index, { mode, label }] of modes.entries()) {
      const url = getUrl(mode);
      if (!url) {
        continue;
      }
      keyboard.webApp(label, url);
      if (index === 1) {
        keyboard.row();
      }
    }

    return keyboard;
  }

  private async sendLiveViewLauncherMessage(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sessionName: string;
    locale: SupportedLocale;
    actor?: GatewayActorProfile;
    allowForeignBinding?: boolean;
  }): Promise<{ message_id: number } | null> {
    if (
      !this.config.webapp.enabled ||
      (!this.config.webapp.publicUrl &&
        !this.config.distributed.gatewayPublicUrl)
    ) {
      return null;
    }

    const useGatewayRelay =
      this.config.distributed.mode === "client" &&
      Boolean(this.config.distributed.gatewayPublicUrl);
    const clientUuid = useGatewayRelay
      ? await this.ensureGatewayClientUuid(input.principal, input.actor)
      : null;
    const baseUrl = useGatewayRelay
      ? resolveGatewayWebAppBaseUrl(
          this.config.distributed.gatewayPublicUrl!,
          this.config.webapp.basePath,
        )
      : resolveWebAppPublicBaseUrl(this.config);
    if (!baseUrl) {
      return null;
    }

    const relayTarget = parseLiveRelaySessionId(input.sessionId);
    const allowForeignBinding =
      input.allowForeignBinding === true || Boolean(relayTarget);

    const liveSessionId =
      useGatewayRelay && clientUuid
        ? buildLiveRelaySessionId(clientUuid, input.sessionId)
        : input.sessionId;
    const url = new URL(`${baseUrl}/live/${encodeURIComponent(liveSessionId)}`);
    url.searchParams.set("launchMode", this.config.webapp.launchMode);

    const sent = await this.sendChatMessage(
      input.principal.telegramChatId,
      [
        this.t(input.locale, "menu:live.screen.launcher_title", {
          sessionName: input.sessionName,
        }),
        "",
        this.t(input.locale, "menu:live.actions.choose_mode"),
      ].join("\n"),
      {
        reply_markup: this.buildLiveViewLaunchKeyboard((mode) => {
          const modeUrl = new URL(url.toString());
          modeUrl.searchParams.set("launchMode", mode);
          return modeUrl.toString();
        }, input.locale),
      },
      {
        kind: "notification",
        sessionId: input.sessionId,
      },
    );

    this.webAppLaunchRegistry.set(
      input.principal.telegramUserId,
      input.sessionId,
      this.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: input.principal.telegramChatId,
        ...(allowForeignBinding
          ? { allowForeignBinding: true }
          : {}),
        telegramMessageId: sent.message_id,
      },
    );

    return sent;
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    const sessionIds = (
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
    ).sort();

    if (sessionIds.length === 0) {
      return this.t(locale, "menu:sessions.screen.no_linked_sessions");
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

    const lines = [this.t(locale, "menu:sessions.screen.title"), ""];
    if (lastWorkedSession) {
      lines.push(
        this.t(locale, "menu:sessions.screen.last_worked", {
          sessionName: escapeHtml(
            lastWorkedSession.label ?? lastWorkedSession.sessionId,
          ),
        }),
      );
      const formattedUpdatedAt = formatMenuTimestamp(
        lastWorkedSession.updatedAt,
      );
      if (formattedUpdatedAt) {
        lines.push(
          this.t(locale, "menu:sessions.screen.updated", {
            timestamp: escapeHtml(formattedUpdatedAt),
          }),
        );
      }
      lines.push("");
    }

    if (activeSessionId) {
      const activeSession = await this.sessionStore.getSession(activeSessionId);
      lines.push(
        this.t(locale, "menu:sessions.screen.current_active", {
          sessionName: escapeHtml(activeSession?.label ?? activeSessionId),
        }),
      );
      lines.push("");
    }

    lines.push(`<i>${escapeHtml(await this.getTmuxStatusLine(locale))}</i>`);
    lines.push("");
    return lines.join("\n");
  }

  private async buildInboxMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const total = await this.inboxStore.countInboxMessages(activeSessionId);

    return [
      this.t(locale, "menu:inbox.screen.title"),
      "",
      this.t(locale, "menu:inbox.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      this.t(locale, "menu:inbox.screen.stored_messages", {
        count: total,
      }),
      "",
      total > 0
        ? this.t(locale, "menu:inbox.screen.choose_message")
        : this.t(locale, "menu:inbox.screen.empty"),
    ].join("\n");
  }

  private async buildBufferMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);

    return [
      this.t(locale, "menu:buffer.screen.title"),
      "",
      this.t(locale, "menu:buffer.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      this.t(locale, "menu:buffer.screen.tmux_target", {
        tmuxTarget: session?.tmuxTarget ?? "not set",
      }),
      "",
      this.t(locale, "menu:buffer.screen.export_hint"),
      this.t(locale, "menu:buffer.screen.export_modes"),
    ].join("\n");
  }

  private async buildBrowserMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const screenshots = await this.listActiveSessionScreenshots(activeSessionId);

    return [
      this.t(locale, "menu:browser.screen.title"),
      "",
      this.t(locale, "menu:browser.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      this.t(locale, "menu:browser.screen.stored_screenshots", {
        count: screenshots.length,
      }),
      "",
      this.t(locale, "menu:browser.screen.choose_action"),
    ].join("\n");
  }

  private async buildSettingsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);

    return [
      this.t(locale, "menu:settings.screen.title"),
      "",
      this.t(locale, "menu:settings.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      "",
      this.t(locale, "menu:settings.screen.hint"),
    ].join("\n");
  }

  private async buildScreenshotsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const files = await this.listActiveSessionScreenshots(activeSessionId);

    return [
      this.t(locale, "menu:screenshots.screen.title"),
      "",
      this.t(locale, "menu:screenshots.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      this.t(locale, "menu:screenshots.screen.stored_screenshots", {
        count: files.length,
      }),
      "",
      files.length > 0
        ? this.t(locale, "menu:screenshots.screen.choose_screenshot")
        : this.t(locale, "menu:screenshots.screen.empty"),
    ].join("\n");
  }

  private async buildStorageMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const entries = await this.listActiveSessionStorageEntries(activeSessionId);

    return [
      this.t(locale, "menu:storage.screen.title"),
      "",
      this.t(locale, "menu:storage.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      this.t(locale, "menu:storage.screen.stored_files", {
        count: entries.length,
      }),
      "",
      entries.length > 0
        ? this.t(locale, "menu:storage.screen.choose_file")
        : this.t(locale, "menu:storage.screen.empty"),
    ].join("\n");
  }

  private async buildLinkMenuText(ctx: TelegramMenuContext): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    return [
      this.t(locale, "menu:link.screen.title"),
      "",
      this.t(locale, "menu:link.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      "",
      this.t(locale, "menu:link.screen.choose_partner"),
      this.t(locale, "menu:link.screen.hint"),
    ].join("\n");
  }

  private async buildPartnerMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    if (!session?.linkedSessionId) {
      return [
        this.t(locale, "menu:partner.screen.title"),
        "",
        this.t(locale, "menu:partner.screen.active_session", {
          sessionName: session?.label ?? activeSessionId,
        }),
        "",
        this.t(locale, "menu:partner.screen.no_partner"),
        this.t(locale, "menu:partner.screen.use_link_first"),
      ].join("\n");
    }

    const linkedSession = await this.sessionStore.getSession(
      session.linkedSessionId,
    );

    return [
      this.t(locale, "menu:partner.screen.title"),
      "",
      this.t(locale, "menu:partner.screen.active_session", {
        sessionName: session.label ?? activeSessionId,
      }),
      this.t(locale, "menu:partner.screen.linked_partner", {
        partnerName: linkedSession?.label ?? session.linkedSessionId,
      }),
      "",
      this.t(locale, "menu:partner.screen.prompt_hint"),
      this.t(locale, "menu:partner.screen.prompt_format"),
    ].join("\n");
  }

  private async buildLocalMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "menu:local.screen.unavailable");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "menu:local.screen.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);
    const linkedSession = session?.linkedSessionId
      ? await this.sessionStore.getSession(session.linkedSessionId)
      : null;

    return [
      this.t(locale, "menu:main.buttons.local"),
      "",
      this.t(locale, "menu:local.screen.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      linkedSession?.label
        ? this.t(locale, "menu:local.screen.link_status", {
            linkedSessionName: linkedSession.label,
          })
        : this.t(locale, "menu:local.screen.link_status_none"),
      "",
      this.t(locale, "menu:local.screen.hint_title"),
      this.t(locale, "menu:local.screen.hint_body"),
    ].join("\n");
  }

  private async buildProjectsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const { session, projects } = await this.loadProjectsContext(ctx);
    if (!this.config.distributed.gatewayPublicUrl) {
      return [
        this.t(locale, "menu:collab.screen.title"),
        "",
        this.t(locale, "menu:collab.screen.gateway_not_configured"),
        this.t(locale, "menu:collab.screen.use_local_instead"),
      ].join("\n");
    }

    if (!session || !projects) {
      return this.t(locale, "menu:collab.screen.unavailable");
    }

    return [
      this.t(locale, "menu:collab.screen.title"),
      "",
      this.t(locale, "menu:collab.screen.active_session", {
        sessionName: session.label ?? session.sessionId,
      }),
      session.activeProjectName
        ? this.t(locale, "menu:collab.screen.open_project", {
            projectName: session.activeProjectName,
          })
        : this.t(locale, "menu:collab.screen.open_project_none"),
      this.t(locale, "menu:collab.screen.project_count", {
        count: projects.length,
      }),
      "",
      this.t(locale, "menu:collab.screen.invite_hint"),
    ].join("\n");
  }

  private async buildCollabToolsMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal || !this.config.distributed.gatewayPublicUrl) {
      return this.t(locale, "menu:collab.screen.gateway_not_configured");
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(sessionId);
    const projects = await this.listGatewayProjects(principal);
    if (projects.length === 0) {
      return [
        this.t(locale, "menu:collab.screen.tools_title"),
        "",
        this.t(locale, "menu:collab.screen.active_session", {
          sessionName: session?.label ?? sessionId,
        }),
        "",
        this.t(locale, "menu:collab.screen.tools_empty"),
      ].join("\n");
    }

    const targets = await this.collectCollabBroadcastTargets(
      principal,
      sessionId,
    );
    const uniqueCount =
      targets.localTargetSessionIds.length + targets.remoteTargets.length;

    return [
      this.t(locale, "menu:collab.screen.tools_title"),
      "",
      this.t(locale, "menu:collab.screen.active_session", {
        sessionName: session?.label ?? sessionId,
      }),
      this.t(locale, "menu:collab.screen.tools_project_count", {
        count: projects.length,
      }),
      this.t(locale, "menu:collab.screen.tools_session_count", {
        count: uniqueCount,
      }),
      "",
      this.t(locale, "menu:collab.screen.tools_broadcast"),
      this.t(locale, "menu:collab.screen.tools_history"),
      this.t(locale, "menu:broadcast.collab_hint"),
    ].join("\n");
  }

  private async buildCollabDeleteMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const { session, projects } = await this.loadProjectsContext(ctx);
    if (!this.config.distributed.gatewayPublicUrl) {
      return this.t(locale, "menu:collab.screen.gateway_not_configured");
    }

    if (!session || !projects) {
      return this.t(locale, "menu:collab.screen.unavailable");
    }

    const ownerCount = projects.filter((project) => project.role === "owner").length;

    return [
      this.t(locale, "menu:project.delete_menu_title"),
      "",
      this.t(locale, "menu:project.active_session", {
        sessionName: session.label ?? session.sessionId,
      }),
      this.t(locale, "menu:project.total_count", {
        count: projects.length,
      }),
      this.t(locale, "menu:project.owner_count", {
        count: ownerCount,
      }),
      "",
      this.t(locale, "menu:project.delete_choose"),
      this.t(locale, "menu:project.delete_body"),
      this.t(locale, "menu:project.delete_owner_hint"),
    ].join("\n");
  }

  private async buildDeveloperMenuText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.t(locale, "menu:developer.screen.title"),
      "",
      this.t(locale, "menu:developer.screen.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.t(locale, "menu:developer.screen.broadcast_help"),
      this.t(locale, "menu:developer.screen.prune_help"),
    ].join("\n");
  }

  private async buildUnpairConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const activeSessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!activeSessionId) {
      return this.t(locale, "common:errors.no_active_session");
    }

    const session = await this.sessionStore.getSession(activeSessionId);

    return [
      this.t(locale, "menu:unpair.title"),
      "",
      this.t(locale, "menu:unpair.active_session", {
        sessionName: session?.label ?? activeSessionId,
      }),
      "",
      this.t(locale, "menu:unpair.body_1"),
      this.t(locale, "menu:unpair.body_2"),
    ].join("\n");
  }

  private async buildPruneConfirmText(
    ctx: TelegramMenuContext,
  ): Promise<string> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      return this.t(locale, "common:errors.no_telegram_identity");
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);

    return [
      this.t(locale, "menu:prune.title"),
      "",
      this.t(locale, "menu:prune.linked_sessions", {
        count: sessionIds.length,
      }),
      "",
      this.t(locale, "menu:prune.body_1"),
      this.t(locale, "menu:prune.body_2"),
    ].join("\n");
  }

  private async showActiveSessionInfo(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
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

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:session_info.opened"),
    });
    await this.replyText(
      ctx,
      [
        this.t(locale, "menu:session_info.title"),
        "",
        this.t(locale, "menu:session_info.label", {
          value: session?.label ?? sessionId,
        }),
        this.t(locale, "menu:session_info.session_id", {
          value: sessionId,
        }),
        this.t(locale, "menu:session_info.inbox_count", {
          count: inboxCount,
        }),
        this.t(locale, "menu:session_info.paired", {
          value: binding
            ? this.t(locale, "menu:session_info.yes")
            : this.t(locale, "menu:session_info.no"),
        }),
        this.t(locale, "menu:session_info.partner", {
          value:
            linkedSession?.label ??
            session?.linkedSessionId ??
            this.t(locale, "menu:session_info.not_linked"),
        }),
        this.t(locale, "menu:session_info.tmux_target", {
          value:
            session?.tmuxTarget ?? this.t(locale, "menu:session_info.not_set"),
        }),
        ...(session?.tmuxSessionName
          ? [
              this.t(locale, "menu:session_info.tmux_session", {
                value: session.tmuxSessionName,
              }),
            ]
          : []),
        ...(session?.tmuxWindowName
          ? [
              this.t(locale, "menu:session_info.tmux_window", {
                value: session.tmuxWindowName,
              }),
            ]
          : []),
        ...(session?.tmuxPaneId
          ? [
              this.t(locale, "menu:session_info.tmux_pane", {
                value: session.tmuxPaneId,
              }),
            ]
          : []),
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (session && this.config.distributed.gatewayPublicUrl) {
      const clientUuid = await this.maintenanceStore.getGatewayClientUuid();
      if (clientUuid) {
        await this.callGatewayJson("/sessions/unregister", {
          client_uuid: clientUuid,
          local_session_id: sessionId,
        });
      }
      await this.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.bindingStore.clearBinding(sessionId);

    this.logger.info("Telegram active session unpaired from menu", {
      sessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    this.clearPendingInteractionsForContext(ctx);

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:unpair.done", {
        sessionName: session?.label ?? sessionId,
      }),
    });
    await this.showSessionsMenu(
      ctx,
      this.t(locale, "menu:unpair.shown", {
        sessionName: session?.label ?? sessionId,
      }),
    );
  }

  private async beginRenameActiveSession(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingBroadcasts.delete(principalKey);
    this.pendingRenames.set(principalKey, { sessionId });
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:settings.actions.rename_prompt"),
    });
    await this.replyText(
      ctx,
      ["✏ Rename session", "", this.t(locale, "menu:settings.actions.rename_body")].join(
        "\n",
      ),
      { kind: "menu", sessionId },
    );
  }

  private async beginBroadcast(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionIds =
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal);
    if (sessionIds.length === 0) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:broadcast.no_linked_sessions"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingRenames.delete(principalKey);

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:broadcast.begin", {
        count: sessionIds.length,
      }),
    });
    const sent = await this.replyText(
      ctx,
      [
        this.t(locale, "menu:broadcast.title"),
        "",
        this.t(locale, "menu:broadcast.body", {
          count: sessionIds.length,
        }),
        this.t(locale, "menu:broadcast.hint"),
        this.t(locale, "menu:broadcast.cancel_hint"),
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
      scope: "linked",
      ...(sent ? { promptMessageId: sent.message_id } : {}),
      ...(ctx.callbackQuery?.message?.message_id
        ? { menuMessageId: ctx.callbackQuery.message.message_id }
        : {}),
    });
  }

  private async beginProjectBroadcast(ctx: TelegramMenuContext): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const projects = await this.listGatewayProjects(principal);
    if (projects.length === 0) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:broadcast.no_projects_first"),
        show_alert: true,
      });
      return;
    }

    const targets = await this.collectCollabBroadcastTargets(principal, sessionId);
    const totalTargets =
      targets.localTargetSessionIds.length + targets.remoteTargets.length;
    if (totalTargets === 0) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:broadcast.no_collab_targets"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    this.pendingRenames.delete(principalKey);

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:broadcast.collab_begin", {
        count: totalTargets,
      }),
    });
    const sent = await this.replyText(
      ctx,
      [
        this.t(locale, "menu:broadcast.collab_title"),
        "",
        this.t(locale, "menu:broadcast.collab_projects", {
          count: projects.length,
        }),
        this.t(locale, "menu:broadcast.collab_sessions", {
          count: totalTargets,
        }),
        "",
        this.t(locale, "menu:broadcast.collab_body"),
        this.t(locale, "menu:broadcast.collab_hint"),
        this.t(locale, "menu:broadcast.cancel_hint"),
      ].join("\n"),
      { kind: "menu", sessionId },
      {
        reply_markup: new InlineKeyboard().text(
          "Cancel",
          "broadcast-cancel",
        ),
      },
    );

    this.pendingBroadcasts.set(principalKey, {
      initiatedAt: new Date().toISOString(),
      scope: "project",
      sessionId,
      localTargetSessionIds: targets.localTargetSessionIds,
      remoteTargets: targets.remoteTargets,
      ...(sent ? { promptMessageId: sent.message_id } : {}),
      ...(ctx.callbackQuery?.message?.message_id
        ? { menuMessageId: ctx.callbackQuery.message.message_id }
        : {}),
    });
  }

  private async collectCollabBroadcastTargets(
    principal: { telegramChatId: number; telegramUserId: number },
    _sessionId: string,
  ): Promise<{
    localTargetSessionIds: string[];
    remoteTargets: PendingProjectBroadcastRemoteTarget[];
  }> {
    const currentClientUuid = await this.ensureGatewayClientUuid(principal);
    const projects = await this.listGatewayProjects(principal);
    const visibleLocalSessionIds = new Set(
      await this.bindingStore.listBoundSessionIdsForPrincipal(principal),
    );
    const localTargetSessionIds: string[] = [];
    const remoteTargets: PendingProjectBroadcastRemoteTarget[] = [];
    const seenLogicalTargets = new Set<string>();

    for (const project of projects) {
      const projectSessions = await this.listGatewayProjectSessions(
        principal,
        project.project_uuid,
      );

      for (const item of projectSessions) {
        const logicalTargetKey = `${item.client_uuid}:${item.local_session_id}`;
        if (seenLogicalTargets.has(logicalTargetKey)) {
          continue;
        }
        seenLogicalTargets.add(logicalTargetKey);

        const isVisibleLocalSession =
          item.client_uuid === currentClientUuid &&
          visibleLocalSessionIds.has(item.local_session_id);

        if (isVisibleLocalSession) {
          localTargetSessionIds.push(item.local_session_id);
          continue;
        }

        remoteTargets.push({
          sessionUuid: item.session_uuid,
          sessionLabel: item.label?.trim() || item.local_session_id,
          clientUuid: item.client_uuid,
          localSessionId: item.local_session_id,
          projectUuid: item.project_uuid,
          ...(project.name ? { projectName: project.name } : {}),
        });
      }
    }

    return {
      localTargetSessionIds: [...new Set(localTargetSessionIds)].sort(),
      remoteTargets,
    };
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingBroadcasts.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:broadcast.mode_not_active"),
        show_alert: true,
      });
      return;
    }

    this.pendingBroadcasts.delete(principalKey);
    await this.deletePendingBroadcastArtifacts(ctx, pending, {
      deleteMenuMessage: false,
    });
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:broadcast.cancelled"),
    });
    if (pending.scope === "project") {
      await this.showCollabToolsMenu(ctx);
      return;
    }
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

    const broadcastText = text.trim();
    if (
      pending.scope === "linked" &&
      (
        await this.bindingStore.listBoundSessionIdsForPrincipal(principal)
      ).length === 0
    ) {
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
    let remoteCount = 0;

    if (pending.scope === "project") {
      const parsed = this.parsePartnerNoteText(broadcastText);
      const sourceSession = pending.sessionId
        ? await this.sessionStore.getSession(pending.sessionId)
        : null;
      const sourceLabel = sourceSession?.label ?? pending.sessionId ?? "session";

      for (const sessionId of pending.localTargetSessionIds ?? []) {
        const inboxMessage: TelegramInboxMessage = {
          id: createInboxMessageId(),
          sessionId,
          telegramChatId: principal.telegramChatId,
          telegramUserId: principal.telegramUserId,
          sourceTelegramMessageId: ctx.message?.message_id ?? 0,
          text: [
            "Collab broadcast from Telegram user.",
            `Source session: ${sourceLabel}`,
            `Summary: ${parsed.summary}`,
            "",
            "Message:",
            parsed.message,
          ].join("\n"),
          receivedAt,
        };

        await this.inboxStore.createInboxMessage(inboxMessage);
        storedCount += 1;

        const session = await this.sessionStore.getSession(sessionId);
        try {
          this.scheduleTmuxNudgeForInboxMessage(sessionId, session);
        } catch (error) {
          this.logger.error("tmux nudge failed after project broadcast inbox capture", {
            sessionId,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
        }
      }

      for (const target of pending.remoteTargets ?? []) {
        await this.sendPartnerNote({
          session_id: pending.sessionId,
          target_session_id: target.sessionUuid,
          project_uuid: target.projectUuid,
          kind: "request",
          summary: parsed.summary,
          message: [
            "Collab broadcast from Telegram user.",
            ...(target.projectName ? [`Project: ${target.projectName}`] : []),
            `Source session: ${sourceLabel}`,
            "",
            "Message:",
            parsed.message,
          ].join("\n"),
          requires_reply: false,
        });
        remoteCount += 1;
      }
    } else {
      const sessionIds =
        await this.bindingStore.listBoundSessionIdsForPrincipal(principal);

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
    }

    this.pendingBroadcasts.delete(principalKey);
    await this.deletePendingBroadcastArtifacts(ctx, pending, {
      deleteMenuMessage: false,
    });
    this.logger.info("Telegram broadcast completed", {
      chatId: principal.telegramChatId,
      userId: principal.telegramUserId,
      scope: pending.scope,
      storedCount,
      remoteCount,
      sessionCount:
        storedCount + remoteCount,
      initiatedAt: pending.initiatedAt,
      text: redactSecrets(broadcastText),
    });
    await this.replyText(
      ctx,
      pending.scope === "project"
        ? [
            this.t(await this.resolveLocaleForContext(ctx), "menu:broadcast.completed_collab", {
              count: storedCount + remoteCount,
            }),
            this.t(await this.resolveLocaleForContext(ctx), "menu:broadcast.completed_collab_local", {
              count: storedCount,
            }),
            this.t(await this.resolveLocaleForContext(ctx), "menu:broadcast.completed_collab_remote", {
              count: remoteCount,
            }),
            this.t(await this.resolveLocaleForContext(ctx), "menu:broadcast.completed_collab_total", {
              count: storedCount + remoteCount,
            }),
          ].join("\n")
        : await this.tForContext(ctx, "menu:broadcast.completed_linked", {
            count: storedCount,
          }),
      {
        kind: "menu",
        ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
      },
    );
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!target && !session?.linkedSessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:partner.screen.use_link_first"),
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
      this.t(locale, "menu:partner.screen.default_partner");
    const sourceLabel = session?.label ?? sessionId;
    const isProjectTarget = Boolean(target?.projectUuid);
    const prompt = buildPartnerNotePromptText({
      kind,
      sourceLabel,
      targetLabel,
      isProjectTarget,
    });
    const kindLabel = prompt.kindLabel;

    await ctx.answerCallbackQuery({ text: `${kindLabel}.` });
    const sent = await this.replyText(
      ctx,
      prompt.text,
      { kind: "menu", sessionId },
      {
        reply_markup: new InlineKeyboard().text(
          this.t(locale, "menu:handoff.cancel"),
          "partner-note-cancel",
        ),
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingPartnerNotes.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:partner.actions.no_pending_note_input"),
        show_alert: true,
      });
      return;
    }

    this.pendingPartnerNotes.delete(principalKey);
    await this.deletePendingPartnerNotePrompt(ctx, pending);
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:partner.actions.cancel_note_input"),
    });
    await this.showPartnerMenu(ctx);
  }

  private async beginProjectMode(
    ctx: TelegramMenuContext,
    mode: "create" | "join",
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const sent = await this.replyText(
      ctx,
      mode === "create"
        ? [
            this.t(locale, "menu:project.create_prompt_title"),
            "",
            this.t(locale, "menu:project.create_prompt_body"),
            this.t(locale, "menu:project.prompt_cancel"),
          ].join("\n")
        : [
            this.t(locale, "menu:project.join_prompt_title"),
            "",
            this.t(locale, "menu:project.join_prompt_body"),
            this.t(locale, "menu:project.prompt_cancel"),
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
      text:
        mode === "create"
          ? this.t(locale, "menu:project.start_create")
          : this.t(locale, "menu:project.start_join"),
    });
  }

  private async handleProjectSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_missing"),
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
        text: this.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
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
        text: this.t(locale, "menu:project.not_found"),
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
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_members"),
    });
    await this.showProjectMembers(ctx, project);
  }

  private async handleProjectDeleteSelect(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_missing"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "project-delete-entry" ||
      !payload.sessionId ||
      !payload.projectUuid
    ) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_stale"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const projects = await this.listGatewayProjects(principal);
    const project = projects.find((item) => item.project_uuid === payload.projectUuid);
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (project.role !== "owner") {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.delete_only_owner"),
        show_alert: true,
      });
      return;
    }

    await this.handleProjectDeleteByUuid(ctx, payload.projectUuid);
  }

  private async leaveActiveProject(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.activeProjectUuid) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.no_active_project"),
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

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.left_current"),
    });
    await this.showProjectsMenu(
      ctx,
      this.t(locale, "menu:project.left_current_screen"),
    );
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
    const locale = await this.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );
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

    const lines = [
      this.t(locale, "menu:project.members_title", {
        projectName: escapeHtml(input.projectName),
      }),
      "",
      `UUID: ${input.projectUuid}`,
      `Invite: <code>${escapeHtml(input.inviteToken)}</code>`,
      "",
      this.t(locale, "menu:project.current_session", {
        sessionName: escapeHtml(session?.label ?? input.sessionId),
      }),
      this.t(locale, "menu:project.other_sessions", {
        count: selectableMembers.length,
      }),
      "",
      selectableMembers.length > 0
        ? options?.filePath
          ? this.t(locale, "menu:project.choose_file_target")
          : this.t(locale, "menu:project.choose_member_action")
        : this.t(locale, "menu:project.no_other_active"),
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
      .text(this.t(locale, "menu:project.leave"), `project-leave:${input.projectUuid}`)
      .text(this.t(locale, "menu:project.back_to_projects"), "project-back");

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
    const locale = await this.resolveLocaleForContext(ctx);
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
      this.config.distributed.gatewayPublicUrl && principal
        ? await this.ensureGatewayClientUuid(principal, actor)
        : null;

    const text = buildProjectMemberDetailText({
      projectName: input.projectName,
      sourceLabel: session?.label ?? input.sessionId,
      targetLabel: input.targetSessionLabel,
    });

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
    const keyboard = new InlineKeyboard()
      .text(this.t(locale, "menu:project.ask"), `project-member-note:question:${payloadKey}`)
      .text(this.t(locale, "menu:project.share_button"), `project-member-note:share:${payloadKey}`)
      .row();
    if (
      this.config.webapp.enabled &&
      this.config.distributed.gatewayPublicUrl &&
      sourceClientUuid &&
      input.targetClientUuid &&
      input.targetLocalSessionId
    ) {
      keyboard.text("🖥 Live", `project-member-live:${payloadKey}`).row();
    }
    keyboard.text(this.t(locale, "menu:project.back_to_members"), `project-members:${input.projectUuid}`);

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
    const locale = await this.resolveLocaleForContext(ctx);
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
      this.t(locale, "menu:project.file_title"),
      "",
      this.t(locale, "menu:project.file_project", {
        projectName: input.projectName,
      }),
      this.t(locale, "menu:project.file_recipient", {
        label: input.targetSessionLabel,
      }),
      "",
      files.length > 0
        ? this.t(locale, "menu:project.file_choose")
        : this.t(locale, "menu:project.file_none"),
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

    keyboard.text(this.t(locale, "menu:project.back_to_session"), `project-member-open:${await this.createProjectMemberMenuPayload(
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

  private async getLiveApprovalPayloadByKey(
    payloadKey: string,
  ): Promise<{
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  } | null> {
    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "live-approval" ||
      !payload.sessionId ||
      !payload.sourceSessionId ||
      !payload.sourceSessionLabel ||
      !payload.sourceClientUuid ||
      !payload.sourceLocalSessionId ||
      !payload.targetSessionId ||
      !payload.title ||
      !payload.targetClientUuid ||
      !payload.targetLocalSessionId
    ) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      sourceSessionId: payload.sourceSessionId,
      sourceSessionLabel: payload.sourceSessionLabel,
      sourceClientUuid: payload.sourceClientUuid,
      sourceLocalSessionId: payload.sourceLocalSessionId,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.title,
      targetClientUuid: payload.targetClientUuid,
      targetLocalSessionId: payload.targetLocalSessionId,
      ...(payload.projectUuid ? { projectUuid: payload.projectUuid } : {}),
      ...(payload.projectName ? { projectName: payload.projectName } : {}),
    };
  }

  private async getAdminClientSessionPayloadByKey(
    payloadKey: string,
  ): Promise<GatewayRelayBindingPayload | null> {
    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    if (
      !payload ||
      payload.kind !== "admin-client-session" ||
      !payload.sessionId ||
      !payload.targetSessionId ||
      !payload.targetClientUuid ||
      !payload.targetLocalSessionId
    ) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      targetSessionId: payload.targetSessionId,
      targetSessionLabel: payload.title ?? payload.targetLocalSessionId,
      targetClientUuid: payload.targetClientUuid,
      targetLocalSessionId: payload.targetLocalSessionId,
      ...(payload.projectUuid ? { projectUuid: payload.projectUuid } : {}),
      ...(payload.projectName ? { projectName: payload.projectName } : {}),
    };
  }

  private buildRelaySessionContext(
    input: GatewayRelayBindingPayload,
  ): SessionContext {
    const relaySessionId = buildLiveRelaySessionId(
      input.targetClientUuid,
      input.targetLocalSessionId,
    );
    const now = new Date().toISOString();
    return {
      sessionId: relaySessionId,
      label: input.targetSessionLabel,
      ...(input.projectUuid ? { activeProjectUuid: input.projectUuid } : {}),
      ...(input.projectName ? { activeProjectName: input.projectName } : {}),
      updatedAt: now,
    };
  }

  private async bindRelaySessionToPrincipal(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    ctx: TelegramMenuContext;
    payload: GatewayRelayBindingPayload;
  }): Promise<SessionContext> {
    const session = this.buildRelaySessionContext(input.payload);
    const existingSession = await this.sessionStore.getSession(session.sessionId);
    await this.sessionStore.setSession({
      ...(existingSession ?? session),
      ...session,
      ...(existingSession?.cwd ? { cwd: existingSession.cwd } : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions
        ? { decisions: existingSession.decisions }
        : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      ...(existingSession?.lastSeenToolsHash
        ? { lastSeenToolsHash: existingSession.lastSeenToolsHash }
        : {}),
      ...(existingSession?.lastNotifiedToolsHash
        ? { lastNotifiedToolsHash: existingSession.lastNotifiedToolsHash }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    await this.bindingStore.setBinding({
      sessionId: session.sessionId,
      telegramChatId: input.principal.telegramChatId,
      telegramUserId: input.principal.telegramUserId,
      ...(input.ctx.from?.username
        ? { telegramUsername: input.ctx.from.username }
        : {}),
      linkedAt: new Date().toISOString(),
    });
    await this.bindingStore.setActiveSessionIdForPrincipal(
      input.principal,
      session.sessionId,
    );
    return session;
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

  private async handleAdminClientSelectCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.menuPayloadStore.getMenuPayload(payloadKey);
    const clientUuid =
      payload?.kind === "admin-client" && payload.targetClientUuid
        ? payload.targetClientUuid
        : null;
    if (!clientUuid) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    let clients: AdminClientViewRecord[];
    try {
      clients = await this.listGatewayAdminClients();
    } catch (error) {
      this.logger.warn("Failed to resolve admin client selection", {
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
        clientUuid,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.clients.unavailable"),
        show_alert: true,
      });
      return;
    }

    const client = clients.find((item) => item.client_uuid === clientUuid);
    if (!client) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:admin.actions.open_client_sessions"),
    });
    await this.showAdminClientSessionsMenu(ctx, client);
  }

  private async handleAdminClientSessionOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey =
      this.extractCallbackSuffix(ctx, "admin-client-session-open:") ??
      readMenuPayloadKey(ctx);
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:admin.actions.open_client_session"),
    });
    await this.showAdminClientSessionDetail(ctx, payload, payloadKey);
  }

  private async handleAdminClientSessionLiveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(
      ctx,
      "admin-client-session-live:",
    );
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:live.errors.identity_unavailable"),
        show_alert: true,
      });
      return;
    }

    const getUrl = (mode: WebAppLaunchMode) =>
      this.buildLiveViewUrlForSessionTarget({
        targetSessionId: payload.targetSessionId,
        targetClientUuid: payload.targetClientUuid,
        targetLocalSessionId: payload.targetLocalSessionId,
        launchMode: mode,
      });
    const defaultUrl = getUrl(this.config.webapp.launchMode);
    if (!defaultUrl) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:live.errors.public_url_missing"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:live.actions.opening"),
    });

    const sent = await this.replyText(
      ctx,
      [
        this.t(locale, "menu:live.screen.launcher_title", {
          sessionName: payload.targetSessionLabel,
        }),
        "",
        this.t(locale, "menu:live.actions.choose_mode"),
      ].join("\n"),
      { kind: "menu", sessionId: payload.targetLocalSessionId },
      {
        reply_markup: this.buildLiveViewLaunchKeyboard(getUrl, locale),
      },
    );

    this.webAppLaunchRegistry.set(
      principal.telegramUserId,
      payload.targetLocalSessionId,
      this.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: principal.telegramChatId,
        allowForeignBinding: true,
        ...(sent && "message_id" in sent
          ? { telegramMessageId: sent.message_id }
          : {}),
      },
    );
  }

  private async handleAdminClientSessionBindCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(
      ctx,
      "admin-client-session-bind:",
    );
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getAdminClientSessionPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:admin.client_sessions.not_found"),
        show_alert: true,
      });
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const session = await this.bindRelaySessionToPrincipal({
      principal,
      ctx,
      payload,
    });

    this.logger.info("Gateway relay session linked to Telegram principal", {
      sessionId: session.sessionId,
      targetClientUuid: payload.targetClientUuid,
      targetLocalSessionId: payload.targetLocalSessionId,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:admin.client_session_detail.bound", {
        sessionName: payload.targetSessionLabel,
      }),
    });
    await this.showMainMenu(
      ctx,
      this.t(locale, "menu:admin.client_session_detail.bound", {
        sessionName: payload.targetSessionLabel,
      }),
    );
  }

  private async handleProjectSetCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const projectUuid = this.extractCallbackSuffix(ctx, "project-set:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
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
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_members"),
    });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectDetailCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const projectUuid = this.extractCallbackSuffix(ctx, "project-detail:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
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
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_members"),
    });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectDeleteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const projectUuid = this.extractCallbackSuffix(ctx, "project-delete:");
    if (!projectUuid) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_action"),
        show_alert: true,
      });
      return;
    }

    await this.handleProjectDeleteByUuid(ctx, projectUuid);
  }

  private async handleProjectMemberOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(ctx, "project-member-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_member_payload"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.stale_member_payload"),
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

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_session"),
    });
    await this.showProjectMemberDetail(ctx, payload);
  }

  private async handleProjectMemberNoteCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^project-member-note:(question|share):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_member_action"),
        show_alert: true,
      });
      return;
    }

    const [, kind, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_member_payload"),
        show_alert: true,
      });
      return;
    }
    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.stale_member_payload"),
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

  private async handleProjectMemberLiveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(ctx, "project-member-live:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_live_payload"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload || !payload.targetClientUuid || !payload.targetLocalSessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.stale_live_payload"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.no_telegram_user"),
        show_alert: true,
      });
      return;
    }

    const session = await this.sessionStore.getSession(payload.sessionId);
    const actor = this.getGatewayActorFromContext(ctx);
    const sourceClientUuid = await this.ensureGatewayClientUuid(principal, actor);

    const result = await this.callGatewayJson<{ delivered?: boolean }>(
      "/live/request-approval",
      {
        client_uuid: payload.targetClientUuid,
        payload: {
          ...(payload.projectUuid ? { project_uuid: payload.projectUuid } : {}),
          ...(payload.projectName ? { project_name: payload.projectName } : {}),
          source_session_id: payload.sessionId,
          source_session_label: session?.label ?? payload.sessionId,
          source_client_uuid: sourceClientUuid,
          source_local_session_id: payload.sessionId,
          target_session_id: payload.targetSessionId,
          target_session_label: payload.targetSessionLabel,
          target_client_uuid: payload.targetClientUuid,
          target_local_session_id: payload.targetLocalSessionId,
        },
      },
    );

    await ctx.answerCallbackQuery({
      text: result?.delivered
        ? this.t(locale, "menu:project.request_live_sent")
        : this.t(locale, "menu:live.actions.approval_unavailable"),
      ...(result?.delivered ? {} : { show_alert: true }),
    });
  }

  private async handleLiveApprovalCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const match = data.match(/^live-approval:(approve|deny):(.+)$/u);
    if (!match) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_approval"),
        show_alert: true,
      });
      return;
    }

    const [, decision, payloadKeyRaw] = match;
    const payloadKey = payloadKeyRaw?.trim();
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_approval_data"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getLiveApprovalPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.approval_stale"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    const approved = decision === "approve";
    const result = await this.callGatewayJson<{ delivered?: boolean }>(
      "/live/resolve-approval",
      {
        client_uuid: payload.sourceClientUuid,
        approved,
        payload: {
          ...(payload.projectUuid ? { project_uuid: payload.projectUuid } : {}),
          ...(payload.projectName ? { project_name: payload.projectName } : {}),
          source_session_id: payload.sourceSessionId,
          source_session_label: payload.sourceSessionLabel,
          source_client_uuid: payload.sourceClientUuid,
          source_local_session_id: payload.sourceLocalSessionId,
          target_session_id: payload.targetSessionId,
          target_session_label: payload.targetSessionLabel,
          target_client_uuid: payload.targetClientUuid,
          target_local_session_id: payload.targetLocalSessionId,
        },
      },
    );

    await ctx.answerCallbackQuery({
      text: approved
        ? this.t(locale, "menu:live.approval.approved")
        : this.t(locale, "menu:live.approval.denied"),
    });

    if (ctx.callbackQuery?.message) {
      await this.editText(
        ctx,
        [
          approved
            ? this.t(locale, "menu:live.approval.approved")
            : this.t(locale, "menu:live.approval.denied"),
          "",
          ...(payload.projectName
            ? [
                this.t(locale, "menu:live.approval.project", {
                  projectName: payload.projectName,
                }),
              ]
            : []),
          this.t(locale, "menu:live.approval.route", {
            sourceSessionName: payload.sourceSessionLabel,
            targetSessionName: payload.targetSessionLabel,
          }),
          "",
          result?.delivered
            ? approved
              ? this.t(locale, "menu:live.approval.source_open")
              : this.t(locale, "menu:live.approval.result_denied", {
                  sourceSessionName: payload.sourceSessionLabel,
                  targetSessionName: payload.targetSessionLabel,
                })
            : this.t(locale, "menu:live.actions.approval_unavailable"),
        ].join("\n"),
        { kind: "menu", sessionId: payload.sessionId },
      );
    }
  }

  private async handleProjectMemberFilesCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(ctx, "project-member-files:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_member_payload"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectMemberPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.stale_member_payload"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.opening_files"),
    });
    await this.showProjectMemberFiles(ctx, payload);
  }

  private async handlePartnerFileOpenCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const payloadKey = this.extractCallbackSuffix(ctx, "partner-file-open:");
    if (!payloadKey) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_member_payload"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getPartnerFileTargetPayloadByKey(payloadKey);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.data_stale"),
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
    const locale = await this.resolveLocaleForContext(ctx);
    const projectUuid = this.extractCallbackSuffix(ctx, "project-members:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const payload = await this.getProjectPayloadByUuid(sessionId, projectUuid);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.loading_members"),
    });
    await this.showProjectMembers(ctx, payload);
  }

  private async handleProjectLeaveCallback(
    ctx: TelegramMenuContext,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const projectUuid = this.extractCallbackSuffix(ctx, "project-leave:");
    const principal = this.getPrincipalFromContext(ctx);
    if (!projectUuid || !principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.invalid_action"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
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

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.left_callback"),
    });
    await this.showProjectsMenu(
      ctx,
      this.t(locale, "menu:project.left_screen"),
    );
  }

  private async handleProjectDeleteByUuid(
    ctx: TelegramMenuContext,
    projectUuid: string,
  ): Promise<void> {
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const sessionId =
      await this.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_active_session"),
        show_alert: true,
      });
      return;
    }

    const projects = await this.listGatewayProjects(principal);
    const project = projects.find((item) => item.project_uuid === projectUuid);
    if (!project) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.not_found"),
        show_alert: true,
      });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (project.role !== "owner") {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:project.delete_only_owner"),
        show_alert: true,
      });
      return;
    }

    const clientUuid = await this.ensureGatewayClientUuid(principal);
    await this.callGatewayJson("/projects/delete", {
      client_uuid: clientUuid,
      project_uuid: projectUuid,
    });

    const session = await this.sessionStore.getSession(sessionId);
    if (session?.activeProjectUuid === projectUuid) {
      await this.sessionStore.setSession({
        ...session,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }

    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:project.deleted_callback"),
    });
    await this.showCollabDeleteMenu(
      ctx,
      this.t(locale, "menu:project.deleted_screen", {
        projectName: project.name,
      }),
    );
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
    const locale = await this.resolveLocaleForContext(ctx);
    const principal = this.getPrincipalFromContext(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "common:errors.no_telegram_identity"),
        show_alert: true,
      });
      return;
    }

    const principalKey = buildPrincipalKey(principal);
    const pending = this.pendingFileHandoffs.get(principalKey);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: this.t(locale, "menu:handoff.no_pending"),
        show_alert: true,
      });
      return;
    }

    this.pendingFileHandoffs.delete(principalKey);
    await this.deletePendingFileHandoffPrompt(ctx, pending);
    await ctx.answerCallbackQuery({
      text: this.t(locale, "menu:handoff.cancelled"),
    });
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
    await upsertXchangeRecord(
      this.config.tmux,
      workspaceDir,
      this.config.exchange.dir,
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
            ...(typeof meta?.sizeBytes === "number"
              ? { size_bytes: meta.sizeBytes }
              : {}),
            ...(meta?.storageRef ? { storage_ref: meta.storageRef } : {}),
          },
        ],
        tags: ["local", "handoff", "file"],
        created_at: createdAt,
        updated_at: createdAt,
      },
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
        `Xchange record: ${handoffId}`,
        "",
        "Immediate action: call get_xchange_record for this record and follow its action_desc.",
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
    const locale = await this.resolveLocaleForContext(ctx);
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
        linkedSession?.label ??
        sourceSession.linkedSessionId ??
        this.t(locale, "menu:partner.screen.default_partner");
    }
    const targetLabel =
      resolvedTargetLabel ?? this.t(locale, "menu:partner.screen.default_partner");

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
        "После подготовки обязательно отправь его обратно через send_partner_note.",
        "Задача не завершена, пока send_partner_note не отработал успешно.",
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
          this.t(locale, "menu:partner.actions.task_sent"),
          ...(output.project_name ? [`Проект: ${output.project_name}`] : []),
          ...(output.target_actor_label
            ? [
                this.t(locale, "menu:partner.screen.executor", {
                  label: output.target_actor_label,
                }),
              ]
            : []),
          this.t(locale, "menu:partner.screen.route_result", {
            source: targetLabel,
            target: sourceLabel,
          }),
          this.t(locale, "menu:partner.screen.type", {
            kind: pending.kind,
          }),
          this.t(locale, "menu:partner.screen.summary", {
            summary: parsed.summary,
          }),
          this.t(locale, "menu:partner.screen.status", {
            status:
              output.delivery_status === "delivered"
                ? this.t(locale, "menu:partner.screen.delivered")
                : this.t(locale, "menu:partner.screen.queued"),
          }),
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
        this.t(locale, "menu:partner.actions.inbox_queued"),
        this.t(locale, "menu:partner.screen.route_send", {
          source: sourceLabel,
          target: targetLabel,
        }),
        this.t(locale, "menu:partner.screen.type", {
          kind: pending.kind,
        }),
        this.t(locale, "menu:partner.screen.summary", {
          summary: parsed.summary,
        }),
        this.t(locale, "menu:partner.screen.current_session_handles"),
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
        "Пользователь просит текущую сессию выполнить работу и отправить результат другой сессии.",
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
        "Не пересылай это как новую задачу в target-сессию.",
        "Сначала выполни работу в текущей сессии сам.",
        "Через send_partner_note или send_partner_file отправляй только результат, а не исходное поручение.",
        "Не используй linked partner для отправки. Передай target_session_id явно в send_partner_note.",
        "После подготовки обязательно используй send_partner_note.",
        "Задача не завершена, пока send_partner_note не отработал успешно.",
        "Если запрос касается существующего локального файла, не ограничивайся note.",
        "Найди файл в локальном workspace и вызови send_partner_file.",
        "Не заменяй это на plain send_partner_note с упоминанием имени файла.",
        "Недостаточно просто упомянуть имя файла в тексте note.",
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
    const locale = await this.resolveLocaleForContext(ctx);
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
        this.t(locale, "menu:handoff.delivered_agent"),
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
        this.t(locale, "menu:handoff.queued_partner"),
        ...(output.project_name
          ? [
              this.t(locale, "menu:handoff.project", {
                projectName: output.project_name,
              }),
            ]
          : []),
        ...(output.target_actor_label
          ? [
              this.t(locale, "menu:handoff.recipient", {
                label: output.target_actor_label,
              }),
            ]
          : []),
        ...(output.target_session_label
          ? [
              this.t(locale, "menu:handoff.session", {
                label: output.target_session_label,
              }),
            ]
          : []),
        this.t(locale, "menu:handoff.status", {
          status:
            output.delivery_status === "delivered"
              ? this.t(locale, "menu:handoff.delivered")
              : this.t(locale, "menu:handoff.queued"),
        }),
        this.t(locale, "menu:handoff.share", {
          shareId: output.share_id,
        }),
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
    const locale = await this.resolveLocaleForContext(ctx);
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
        this.t(locale, "menu:project.created", {
          projectName,
          inviteToken: created.invite_token,
        }),
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
        this.t(locale, "menu:project.joined", {
          projectName,
        }),
        { kind: "menu", sessionId: pending.sessionId },
      );
    }

    this.pendingProjects.delete(principalKey);
    await this.showProjectsMenu(
      ctx,
      this.t(locale, "menu:project.opened", {
        projectName,
      }),
    );
    return true;
  }
}
