import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  RefreshToolsMarkdownInput,
  RefreshToolsMarkdownOutput,
} from "../../../entities/request/model/types";
import { refreshToolsMarkdownOutputSchema } from "../../../entities/request/model/schema";
import type { SessionStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import {
  ProjectIdentityResolver,
  writeSessionMarkerState,
} from "../../../shared/lib/project-identity/projectIdentity";
import { getTellyMcpPackageRoot } from "../../../shared/lib/version/versionHandshake";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeClientLocalSessionId(
  mode: AppConfig["distributed"]["mode"],
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || mode !== "client") {
    return trimmed || undefined;
  }

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return trimmed;
  }

  return trimmed.slice(separatorIndex + 1).trim() || trimmed;
}

function normalizeRemoteRefreshOutput(
  value: unknown,
): RefreshToolsMarkdownOutput | null {
  const candidate =
    value && typeof value === "object" && "structuredContent" in value
      ? (value as { structuredContent?: unknown }).structuredContent
      : value && typeof value === "object" && "result" in value
        ? (value as { result?: unknown }).result
        : value;

  const parsed = refreshToolsMarkdownOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export class RefreshToolsMarkdownService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async refresh(
    input: RefreshToolsMarkdownInput = {},
  ): Promise<RefreshToolsMarkdownOutput> {
    const normalizedSessionId = normalizeClientLocalSessionId(
      this.config.distributed.mode,
      input.session_id,
    );
    const resolved = this.projectIdentityResolver.resolveSessionDefaults({
      ...input,
      ...(normalizedSessionId ? { session_id: normalizedSessionId } : {}),
    });
    const explicitCwd = input.cwd?.trim() ? resolve(input.cwd.trim()) : null;
    const requestedSessionId = normalizedSessionId ?? "";
    const knownHash = input.known_hash?.trim() || null;
    const remoteLookupRequested =
      Boolean(this.remoteConsoleInvoker) &&
      this.config.distributed.mode !== "client";
    const remote = remoteLookupRequested && requestedSessionId
      ? await this.remoteConsoleInvoker?.invokeForRelaySession<RefreshToolsMarkdownOutput>(
          requestedSessionId,
          "telegramMcp.toolsSync.refreshToolsMarkdownRemote",
          input as Record<string, unknown>,
        )
      : null;
    if (remote) {
      const normalizedRemote = normalizeRemoteRefreshOutput(remote);
      if (normalizedRemote) {
        return normalizedRemote;
      }
      this.logger.error(
        "refresh_tools_markdown received invalid remote console output",
        {
          sessionId: requestedSessionId,
          remote,
        },
      );
      throw new Error(
        `Invalid remote refresh_tools_markdown output: ${JSON.stringify(remote)}`,
      );
    }
    if (remoteLookupRequested) {
      this.logger.error(
        "refresh_tools_markdown could not resolve remote console target",
        {
          sessionId: resolved.sessionId,
          requestedSessionId,
          explicitCwd,
        },
      );
      throw new Error(
        requestedSessionId
          ? "Could not resolve remote console target for refresh_tools_markdown. Use the canonical gateway session_id in the format client_uuid:local_session_id."
          : "refresh_tools_markdown requires explicit session_id in gateway mode. Use the canonical gateway session_id in the format client_uuid:local_session_id.",
      );
    }
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const sessionCwd = session?.cwd?.trim() ? resolve(session.cwd.trim()) : null;
    const workspaceDir = requestedSessionId
      ? sessionCwd ?? explicitCwd ?? resolved.cwd
      : explicitCwd ?? sessionCwd ?? resolved.cwd;
    const packageRoot = getTellyMcpPackageRoot(__dirname);
    if (!packageRoot) {
      throw new Error("Could not resolve installed package root for TOOLS.md.");
    }
    const gatewayToolsPath = join(packageRoot, "TOOLS.md");

    let source: "gateway" | "local" = "local";
    let content: string;

    if (this.config.distributed.gatewayPublicUrl) {
      const url = normalizeGatewayBaseUrl(this.config.distributed.gatewayPublicUrl);
      url.pathname = `${url.pathname}/tools-md`.replace(/\/{2,}/gu, "/");

      const response = await fetch(url, {
        method: "GET",
        headers: {
          ...(this.config.distributed.gatewayAuthToken
            ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
            : {}),
        },
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `Gateway TOOLS.md request failed with status ${response.status}: ${message || response.statusText}`,
        );
      }

      content = await response.text();
      source = "gateway";
    } else {
      content = readFileSync(gatewayToolsPath, "utf8");
    }

    const currentHash = computeContentHash(content);
    const changed = knownHash !== currentHash;

    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      ...(session?.label ? { label: session.label } : {}),
      ...(session?.cwd ? { cwd: session.cwd } : workspaceDir ? { cwd: workspaceDir } : {}),
      ...(session?.activeProjectUuid
        ? { activeProjectUuid: session.activeProjectUuid }
        : {}),
      ...(session?.activeProjectName
        ? { activeProjectName: session.activeProjectName }
        : {}),
      ...(session?.task ? { task: session.task } : {}),
      ...(session?.summary ? { summary: session.summary } : {}),
      ...(session?.files ? { files: session.files } : {}),
      ...(session?.decisions ? { decisions: session.decisions } : {}),
      ...(session?.risks ? { risks: session.risks } : {}),
      ...(session?.terminalTarget ? { terminalTarget: session.terminalTarget } : {}),
      ...(session?.lastTerminalNudgeAt
        ? { lastTerminalNudgeAt: session.lastTerminalNudgeAt }
        : {}),
      lastSeenToolsHash: currentHash,
      lastNotifiedToolsHash: currentHash,
      updatedAt: new Date().toISOString(),
    });
    if (workspaceDir) {
      writeSessionMarkerState({
        cwd: workspaceDir,
        localSessionId: resolved.sessionId,
        lastSeenToolsHash: currentHash,
        lastNotifiedToolsHash: currentHash,
        logger: this.logger,
      });
    }

    this.logger.info("TOOLS.md refreshed", {
      source,
      bytes: Buffer.byteLength(content, "utf8"),
      currentHash,
      changed,
    });

    return {
      source,
      session_id: resolved.sessionId,
      current_hash: currentHash,
      changed,
      ...(changed ? { content } : {}),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }
}
