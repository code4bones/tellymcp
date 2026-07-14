import type {
  SessionBindingStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
import {
  isPtyTarget,
  stopPtyTarget,
} from "../../../shared/integrations/terminal/ptyRegistry";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import { redactSecrets } from "../../../shared/lib/redact-secrets/redactSecrets";
import type {
  ClearSessionContextInput,
  ClearSessionContextOutput,
  GetRuntimeDiagnosticsInput,
  GetRuntimeDiagnosticsOutput,
  GetSessionContextInput,
  GetSessionContextOutput,
  SetSessionContextInput,
  SetSessionContextOutput,
  RenameSessionInput,
  RenameSessionOutput,
} from "../../../entities/session/model/types";

type RuntimeDiagnosticsContext = {
  mode: "client" | "gateway" | "both";
  packageVersion: string;
  protocolVersion: string;
  nodeId?: string | undefined;
  gatewayWsUrlConfigured: boolean;
  gatewayAuthConfigured: boolean;
  pingRedis?: (() => Promise<string>) | undefined;
};

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

export class SessionContextService {
  public constructor(
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
    private readonly runtimeDiagnostics?: RuntimeDiagnosticsContext,
  ) {}

  private getRemoteConsoleInvoker(): RemoteConsoleInvoker | undefined {
    return this.runtimeDiagnostics?.mode === "client"
      ? undefined
      : this.remoteConsoleInvoker;
  }

  private formatDiagnosticError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactSecrets(message).replace(/\s+/gu, " ").trim();
    return redacted.length > 500
      ? `${redacted.slice(0, 497)}...`
      : redacted || "Unknown error";
  }

  private finalizeDiagnostics(
    output: Omit<GetRuntimeDiagnosticsOutput, "status">,
  ): GetRuntimeDiagnosticsOutput {
    const degraded = Object.values(output.checks).some(
      (check) => check.status !== "ok",
    );
    return {
      ...output,
      status: degraded ? "degraded" : "ok",
    };
  }

  private async collectLocalDiagnostics(
    sessionId: string,
  ): Promise<GetRuntimeDiagnosticsOutput> {
    const runtime = this.runtimeDiagnostics;
    let session: Awaited<ReturnType<SessionStore["getSession"]>> = null;
    let sessionStoreCheck: GetRuntimeDiagnosticsOutput["checks"]["session_store"];
    try {
      session = await this.sessionStore.getSession(sessionId);
      await this.bindingStore.getBinding(sessionId);
      sessionStoreCheck = {
        status: "ok",
        message: session
          ? "Session and route stores are readable; session metadata exists."
          : "Session and route stores are readable; no saved metadata exists for this id.",
      };
    } catch (error) {
      sessionStoreCheck = {
        status: "error",
        message: `Session store check failed: ${this.formatDiagnosticError(error)}`,
      };
    }

    let redisCheck: GetRuntimeDiagnosticsOutput["checks"]["redis"];
    if (runtime?.mode === "client") {
      redisCheck = {
        status: "ok",
        message: "Redis is not required in client mode; process-local state is active.",
      };
    } else if (!runtime?.pingRedis) {
      redisCheck = {
        status: "warn",
        message: "Runtime Redis probe is unavailable.",
      };
    } else {
      try {
        const reply = await runtime.pingRedis();
        redisCheck = {
          status: reply.trim().toUpperCase() === "PONG" ? "ok" : "warn",
          message: `Redis probe returned ${reply.trim() || "an empty response"}.`,
        };
      } catch (error) {
        redisCheck = {
          status: "error",
          message: `Redis probe failed: ${this.formatDiagnosticError(error)}`,
        };
      }
    }

    const mode = runtime?.mode ?? "client";
    const gatewayConfigured = Boolean(runtime?.gatewayWsUrlConfigured);
    const gatewayConfiguration =
      mode === "gateway"
        ? {
            status: "ok" as const,
            message:
              "Gateway runtime does not require an outbound gateway WebSocket URL.",
          }
        : gatewayConfigured
          ? {
              status: "ok" as const,
              message: runtime?.gatewayAuthConfigured
                ? "Gateway WebSocket URL and authentication are configured."
                : "Gateway WebSocket URL is configured; authentication is not configured.",
            }
          : {
              status: "error" as const,
              message:
                "Gateway WebSocket URL is not configured for this client runtime.",
            };

    return this.finalizeDiagnostics({
      checked_at: new Date().toISOString(),
      session_id: sessionId,
      runtime: {
        mode,
        package_version: runtime?.packageVersion ?? "unknown",
        protocol_version: runtime?.protocolVersion ?? "unknown",
        ...(runtime?.nodeId ? { node_id: runtime.nodeId } : {}),
      },
      checks: {
        configuration: runtime
          ? {
              status: "ok",
              message: "Normalized environment schema was accepted at startup.",
            }
          : {
              status: "warn",
              message: "Runtime configuration metadata is unavailable.",
            },
        redis: redisCheck,
        session_store: sessionStoreCheck,
        terminal: session?.terminalTarget
          ? {
              status: "ok",
              message: "A PTY terminal target is configured for this session.",
            }
          : {
              status: "warn",
              message: "No PTY terminal target is configured for this session.",
            },
        gateway_configuration: gatewayConfiguration,
        relay: {
          status: "ok",
          message: "Local diagnostic action completed.",
        },
      },
    });
  }

  public async getRuntimeDiagnostics(
    input: GetRuntimeDiagnosticsInput,
  ): Promise<GetRuntimeDiagnosticsOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remoteConsoleInvoker = this.getRemoteConsoleInvoker();
    if (!remoteConsoleInvoker) {
      return await this.collectLocalDiagnostics(resolved.sessionId);
    }

    try {
      const remote =
        await remoteConsoleInvoker.invokeForRelaySession<GetRuntimeDiagnosticsOutput>(
          resolved.sessionId,
          "telegramMcp.sessionContext.getRuntimeDiagnosticsRemote",
          input as Record<string, unknown>,
        );
      return this.finalizeDiagnostics({
        ...remote,
        checks: {
          ...remote.checks,
          relay: {
            status: "ok",
            message: "Gateway-to-client relay completed successfully.",
          },
        },
      });
    } catch (error) {
      const local = await this.collectLocalDiagnostics(resolved.sessionId);
      return this.finalizeDiagnostics({
        ...local,
        checks: {
          ...local.checks,
          relay: {
            status: "error",
            message: `Gateway-to-client relay failed: ${this.formatDiagnosticError(error)}`,
          },
        },
      });
    }
  }

  public async setContext(
    input: SetSessionContextInput,
  ): Promise<SetSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote =
      await this.getRemoteConsoleInvoker()?.invokeForRelaySession<SetSessionContextOutput>(
        resolved.sessionId,
        "telegramMcp.sessionContext.setContextRemote",
        input as Record<string, unknown>,
      );
    if (remote) {
      return remote;
    }
    const updatedAt = new Date().toISOString();
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);

    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      ...(input.session_label
        ? { label: redactSecrets(input.session_label) }
        : resolved.sessionLabel
          ? { label: redactSecrets(resolved.sessionLabel) }
          : existing?.label
            ? { label: existing.label }
            : {}),
      ...(existing?.cwd ? { cwd: existing.cwd } : { cwd: resolved.cwd }),
      ...(existing?.activeProjectUuid
        ? { activeProjectUuid: existing.activeProjectUuid }
        : {}),
      ...(existing?.activeProjectName
        ? { activeProjectName: existing.activeProjectName }
        : {}),
      ...(input.task
        ? { task: redactSecrets(input.task) }
        : existing?.task
          ? { task: existing.task }
          : {}),
      summary: redactSecrets(input.summary),
      ...(input.files?.length
        ? { files: input.files.map((item) => redactSecrets(item)) }
        : existing?.files
          ? { files: existing.files }
          : {}),
      ...(input.decisions?.length
        ? { decisions: input.decisions.map((item) => redactSecrets(item)) }
        : existing?.decisions
          ? { decisions: existing.decisions }
          : {}),
      ...(input.risks?.length
        ? { risks: input.risks.map((item) => redactSecrets(item)) }
        : existing?.risks
          ? { risks: existing.risks }
          : {}),
      ...(existing?.terminalTarget
        ? { terminalTarget: existing.terminalTarget }
        : {}),
      ...(existing?.lastTerminalNudgeAt
        ? { lastTerminalNudgeAt: existing.lastTerminalNudgeAt }
        : {}),
      ...(existing?.lastSeenToolsHash
        ? { lastSeenToolsHash: existing.lastSeenToolsHash }
        : {}),
      ...(existing?.lastNotifiedToolsHash
        ? { lastNotifiedToolsHash: existing.lastNotifiedToolsHash }
        : {}),
      updatedAt,
    });
    this.projectIdentityResolver.persistSessionMarker({
      cwd: resolved.cwd,
      sessionId: resolved.sessionId,
      sessionLabel: input.session_label?.trim() || resolved.sessionLabel,
    });

    this.logger.info("Session context saved", {
      sessionId: resolved.sessionId,
      sessionLabel: resolved.sessionLabel,
      sessionIdDerived: resolved.sessionIdDerived,
      sessionLabelDerived: resolved.sessionLabelDerived,
      hasBinding: Boolean(binding),
      fileCount: input.files?.length ?? 0,
      decisionCount: input.decisions?.length ?? 0,
      riskCount: input.risks?.length ?? 0,
    });

    return {
      saved: true,
      session_id: resolved.sessionId,
      updated_at: updatedAt,
      has_binding: Boolean(binding),
    };
  }

  public async renameSession(
    input: RenameSessionInput,
  ): Promise<RenameSessionOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote =
      await this.getRemoteConsoleInvoker()?.invokeForRelaySession<RenameSessionOutput>(
        resolved.sessionId,
        "telegramMcp.sessionContext.renameSessionRemote",
        input as Record<string, unknown>,
      );
    if (remote) {
      return remote;
    }
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const updatedAt = new Date().toISOString();
    const label = redactSecrets(input.title);

    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      label,
      ...(existing?.cwd ? { cwd: existing.cwd } : { cwd: resolved.cwd }),
      ...(existing?.activeProjectUuid
        ? { activeProjectUuid: existing.activeProjectUuid }
        : {}),
      ...(existing?.activeProjectName
        ? { activeProjectName: existing.activeProjectName }
        : {}),
      ...(existing?.task ? { task: existing.task } : {}),
      ...(existing?.summary ? { summary: existing.summary } : {}),
      ...(existing?.files ? { files: existing.files } : {}),
      ...(existing?.decisions ? { decisions: existing.decisions } : {}),
      ...(existing?.risks ? { risks: existing.risks } : {}),
      ...(existing?.terminalTarget
        ? { terminalTarget: existing.terminalTarget }
        : {}),
      ...(existing?.lastTerminalNudgeAt
        ? { lastTerminalNudgeAt: existing.lastTerminalNudgeAt }
        : {}),
      ...(existing?.lastSeenToolsHash
        ? { lastSeenToolsHash: existing.lastSeenToolsHash }
        : {}),
      ...(existing?.lastNotifiedToolsHash
        ? { lastNotifiedToolsHash: existing.lastNotifiedToolsHash }
        : {}),
      updatedAt,
    });
    this.projectIdentityResolver.persistSessionMarker({
      cwd: resolved.cwd,
      sessionId: resolved.sessionId,
      sessionLabel: label,
    });

    this.logger.info("Session renamed", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      sessionLabel: label,
    });

    return {
      renamed: true,
      session_id: resolved.sessionId,
      session_label: label,
      updated_at: updatedAt,
    };
  }

  public async getContext(
    input: GetSessionContextInput,
  ): Promise<GetSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote =
      await this.getRemoteConsoleInvoker()?.invokeForRelaySession<GetSessionContextOutput>(
        resolved.sessionId,
        "telegramMcp.sessionContext.getContextRemote",
        input as Record<string, unknown>,
      );
    if (remote) {
      return remote;
    }
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);

    this.logger.debug("Session context requested", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      exists: Boolean(session),
      hasBinding: Boolean(binding),
    });

    const statusMessage = binding
      ? session?.terminalTarget
        ? "Gateway console binding is active for this session. A terminal target is configured, so ordinary Telegram messages can wake the agent through terminal nudges."
        : "Gateway console binding is active for this session. No terminal target is configured, so inbox handling requires passive MCP checks."
      : session
        ? "Session metadata exists, but no gateway console binding is active."
        : "Session metadata and gateway console binding are both absent.";

    return {
      session_id: resolved.sessionId,
      exists: Boolean(session),
      has_binding: Boolean(binding),
      status_message: statusMessage,
      ...(session
        ? {
            context: {
              ...(session.label ? { session_label: session.label } : {}),
              ...(session.cwd ? { cwd: session.cwd } : {}),
              ...(session.activeProjectUuid
                ? { active_project_uuid: session.activeProjectUuid }
                : {}),
              ...(session.activeProjectName
                ? { active_project_name: session.activeProjectName }
                : {}),
              ...(session.task ? { task: session.task } : {}),
              ...(session.summary ? { summary: session.summary } : {}),
              ...(session.files ? { files: session.files } : {}),
              ...(session.decisions ? { decisions: session.decisions } : {}),
              ...(session.risks ? { risks: session.risks } : {}),
              updated_at: session.updatedAt,
            },
          }
        : {}),
      ...(binding
        ? {
            binding: {
              telegram_chat_id: binding.telegramChatId,
              telegram_user_id: binding.telegramUserId,
              ...(binding.telegramUsername
                ? { telegram_username: binding.telegramUsername }
                : {}),
              linked_at: binding.linkedAt,
            },
          }
        : {}),
      ...(session
        ? {
            terminal: {
              configured: Boolean(session.terminalTarget),
              ...(session.terminalTarget
                ? { terminal_target: session.terminalTarget }
                : {}),
              ...(session.lastTerminalNudgeAt
                ? { last_nudge_at: session.lastTerminalNudgeAt }
                : {}),
            },
          }
        : {}),
    };
  }

  public async clearContext(
    input: ClearSessionContextInput,
  ): Promise<ClearSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote =
      await this.getRemoteConsoleInvoker()?.invokeForRelaySession<ClearSessionContextOutput>(
        resolved.sessionId,
        "telegramMcp.sessionContext.clearContextRemote",
        input as Record<string, unknown>,
      );
    if (remote) {
      return remote;
    }
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const existingTarget = existing?.terminalTarget;
    if (existingTarget && isPtyTarget(existingTarget)) {
      stopPtyTarget(existingTarget);
    }
    await this.sessionStore.clearSession(resolved.sessionId);
    await this.bindingStore.clearBinding(resolved.sessionId);
    this.projectIdentityResolver.removeSessionMarker(
      existing?.cwd || resolved.cwd,
    );

    this.logger.info("Session context cleared", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      clearedTelegramRoute: true,
    });

    return {
      cleared: true,
      session_id: resolved.sessionId,
      cleared_pairing: true,
    };
  }
}
