import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  RefreshToolsMarkdownInput,
  RefreshToolsMarkdownOutput,
} from "../../../entities/request/model/types";
import { refreshToolsMarkdownOutputSchema } from "../../../entities/request/model/schema";
import type { SessionStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import { getTellyMcpPackageRoot } from "../../../shared/lib/version/versionHandshake";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T | null>;
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
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const explicitCwd = input.cwd?.trim() ? resolve(input.cwd.trim()) : null;
    const requestedSessionId = input.session_id?.trim() ?? "";
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
    const saveLocally = input.save_locally !== false;
    const gatewayToolsPath = join(
      getTellyMcpPackageRoot(__dirname) ?? process.cwd(),
      "TOOLS.md",
    );

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

    if (!workspaceDir) {
      throw new Error(
        "Could not resolve target workspace for TOOLS.md. Pass cwd explicitly or ensure the console session has a workspace cwd.",
      );
    }

    const toolsPath = join(workspaceDir, "TOOLS.md");

    if (saveLocally) {
      if (sessionCwd && explicitCwd && sessionCwd !== explicitCwd) {
        this.logger.warn(
          "refresh_tools_markdown ignored explicit cwd in favor of console workspace",
          {
            sessionId: resolved.sessionId,
            explicitCwd,
            sessionCwd,
          },
        );
      }
      mkdirSync(dirname(toolsPath), { recursive: true });
      writeFileSync(toolsPath, content, "utf8");
      const appliedHash = computeContentHash(content);
      await this.sessionStore.setSession({
        sessionId: resolved.sessionId,
        ...(session?.label ? { label: session.label } : {}),
        ...(session?.cwd ? { cwd: session.cwd } : { cwd: workspaceDir }),
        ...(session?.linkedSessionId
          ? { linkedSessionId: session.linkedSessionId }
          : {}),
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
        lastSeenToolsHash: appliedHash,
        lastNotifiedToolsHash: appliedHash,
        updatedAt: new Date().toISOString(),
      });
    }

    this.logger.info("TOOLS.md refreshed", {
      source,
      saved: saveLocally,
      path: toolsPath,
      bytes: Buffer.byteLength(content, "utf8"),
    });

    return {
      source,
      saved: saveLocally,
      bytes: Buffer.byteLength(content, "utf8"),
      ...(saveLocally ? { path: toolsPath } : {}),
    };
  }
}
