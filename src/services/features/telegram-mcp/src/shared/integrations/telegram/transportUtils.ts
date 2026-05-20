import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import { isTmuxUnavailableError } from "../tmux/client";
import type {
  AdminClientViewRecord,
  TelegramMenuContext,
} from "./transportTypes";

export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function normalizeBasePath(value: string): string {
  const trimmed = trimTrailingSlashes(value.trim());
  return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed || ""}`;
}

export function joinHttpPath(prefix: string, suffix: string): string {
  const normalizedPrefix = prefix ? normalizeBasePath(prefix) : "";
  const normalizedSuffix = normalizeBasePath(suffix);

  if (!normalizedPrefix || normalizedPrefix === "/") {
    return normalizedSuffix;
  }

  return `${normalizedPrefix}${normalizedSuffix}`.replace(/\/{2,}/gu, "/");
}

export function resolveWebAppPublicBaseUrl(config: AppConfig): string | null {
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

export function resolveGatewayControlBaseUrl(config: AppConfig): string | null {
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

export function parsePairingCode(text: string): string | null {
  const match = text
    .trim()
    .match(/^\/(?:start|link)(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?$/i);
  return match?.[1]?.trim().toUpperCase() ?? null;
}

export function isMenuEntryCommand(text: string): boolean {
  return /^\/(?:menu|start)(?:@\w+)?$/i.test(text.trim());
}

export function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?$/i.test(text.trim());
}

export function parseAdminAuthCommand(text: string): string | null {
  const match = text.trim().match(/^\/auth(?:@\w+)?(?:\s+(.+))?$/i);
  return match?.[1]?.trim() || null;
}

export function isGatewayLinkCommand(text: string): boolean {
  return /^\/link(?:@\w+)?$/i.test(text.trim());
}

export function isGatewayAdminCommand(text: string): boolean {
  return /^\/admin(?:@\w+)?$/i.test(text.trim());
}

export function readMenuPayloadKey(ctx: TelegramMenuContext): string | null {
  const payload = (ctx as TelegramMenuContext & { match?: string }).match;
  return typeof payload === "string" && payload.length > 0 ? payload : null;
}

export function buildDatedRelativePath(
  fileName: string,
  date = new Date(),
): string {
  const dateSegment = date.toISOString().slice(0, 10);
  const timeSegment = date.toTimeString().slice(0, 8).replace(/:/gu, "-");
  return `${dateSegment}/${timeSegment}/${fileName}`;
}

export function buildPrincipalKey(principal: {
  telegramChatId: number;
  telegramUserId: number;
}): string {
  return `${principal.telegramChatId}:${principal.telegramUserId}`;
}

export function formatTmuxBridgeError(
  _config: AppConfig,
  error: unknown,
  fallback: string,
): string {
  if (isTmuxUnavailableError(error)) {
    return "tmux is unavailable right now.";
  }

  return fallback;
}

export function splitLongTelegramText(text: string, maxChars: number): string[] {
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

export function escapeMarkdownV2(text: string): string {
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

export function escapeMarkdownV2CodeBlock(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function splitTitleAndBody(text: string): {
  title: string;
  body: string;
} {
  const normalized = text.trim();
  const [firstLine = "", ...rest] = normalized.split("\n");
  const title = firstLine.trim() || "Codex";
  const body = rest.join("\n").trim();

  return {
    title,
    body: body || firstLine.trim(),
  };
}

export function renderMarkdownChunk(title: string, body: string): string {
  return `*${escapeMarkdownV2(title)}*\n\n\`\`\`\n${escapeMarkdownV2CodeBlock(body)}\n\`\`\``;
}

export function shouldNudge(
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

export function slugifyFilenamePart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function formatMenuTimestamp(
  timestamp: string | undefined,
): string | null {
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

export function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

export function buildLocalHandoffId(fileName: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${timestamp}-${slugifyFilenamePart(fileName) || "file-handoff"}`;
}

export function buildLocalNoteContent(input: {
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

export function buildAdminClientTitle(client: AdminClientViewRecord): string {
  const displayName = client.telegram_display_name?.trim() || "";
  const telegramUsername =
    client.telegram_username?.trim().replace(/^@/u, "") || "";
  const botUsername = client.bot_username?.trim().replace(/^@/u, "") || "";
  const clientLabel = client.client_label?.trim() || "";
  const namespace = client.namespace?.trim() || "";
  const nodeId = client.node_id?.trim() || "";
  const runtimeLabel = [namespace, nodeId].filter(Boolean).join("/") || nodeId || "";
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

export function buildAdminClientButtonLabel(
  client: AdminClientViewRecord,
): string {
  const markers = [
    client.is_connected ? "🟢" : null,
    client.is_registered ? "🗂" : null,
  ]
    .filter(Boolean)
    .join("");
  const prefix = markers ? `${markers} ` : "";
  return `${prefix}${buildAdminClientTitle(client)}`.slice(0, 56);
}
