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
  GetSessionContextInput,
  GetSessionContextOutput,
  SetSessionContextInput,
  SetSessionContextOutput,
  RenameSessionInput,
  RenameSessionOutput,
} from "../../../entities/session/model/types";

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
  ) {}

  public async setContext(
    input: SetSessionContextInput,
  ): Promise<SetSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<SetSessionContextOutput>(
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
      ...(existing?.linkedSessionId
        ? { linkedSessionId: existing.linkedSessionId }
        : {}),
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
      ...(existing?.tmuxSessionName
        ? { tmuxSessionName: existing.tmuxSessionName }
        : {}),
      ...(existing?.tmuxWindowName
        ? { tmuxWindowName: existing.tmuxWindowName }
        : {}),
      ...(typeof existing?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: existing.tmuxWindowIndex }
        : {}),
      ...(existing?.tmuxPaneId ? { tmuxPaneId: existing.tmuxPaneId } : {}),
      ...(typeof existing?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: existing.tmuxPaneIndex }
        : {}),
      ...(existing?.tmuxTarget ? { tmuxTarget: existing.tmuxTarget } : {}),
      ...(existing?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
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
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<RenameSessionOutput>(
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
      ...(existing?.linkedSessionId
        ? { linkedSessionId: existing.linkedSessionId }
        : {}),
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
      ...(existing?.tmuxSessionName
        ? { tmuxSessionName: existing.tmuxSessionName }
        : {}),
      ...(existing?.tmuxWindowName
        ? { tmuxWindowName: existing.tmuxWindowName }
        : {}),
      ...(typeof existing?.tmuxWindowIndex === "number"
        ? { tmuxWindowIndex: existing.tmuxWindowIndex }
        : {}),
      ...(existing?.tmuxPaneId ? { tmuxPaneId: existing.tmuxPaneId } : {}),
      ...(typeof existing?.tmuxPaneIndex === "number"
        ? { tmuxPaneIndex: existing.tmuxPaneIndex }
        : {}),
      ...(existing?.tmuxTarget ? { tmuxTarget: existing.tmuxTarget } : {}),
      ...(existing?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
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
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<GetSessionContextOutput>(
      resolved.sessionId,
      "telegramMcp.sessionContext.getContextRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    const linkedSession = session?.linkedSessionId
      ? await this.sessionStore.getSession(session.linkedSessionId)
      : null;

    this.logger.debug("Session context requested", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      exists: Boolean(session),
      hasBinding: Boolean(binding),
    });

    const statusMessage = binding
      ? session?.tmuxTarget
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
              ...(session.linkedSessionId
                ? { linked_session_id: session.linkedSessionId }
                : {}),
              ...(linkedSession?.label
                ? { linked_session_label: linkedSession.label }
                : {}),
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
            tmux: {
              configured: Boolean(session.tmuxTarget),
              ...(session.tmuxSessionName
                ? { tmux_session_name: session.tmuxSessionName }
                : {}),
              ...(session.tmuxWindowName
                ? { tmux_window_name: session.tmuxWindowName }
                : {}),
              ...(typeof session.tmuxWindowIndex === "number"
                ? { tmux_window_index: session.tmuxWindowIndex }
                : {}),
              ...(session.tmuxPaneId
                ? { tmux_pane_id: session.tmuxPaneId }
                : {}),
              ...(typeof session.tmuxPaneIndex === "number"
                ? { tmux_pane_index: session.tmuxPaneIndex }
                : {}),
              ...(session.tmuxTarget
                ? { tmux_target: session.tmuxTarget }
                : {}),
              ...(session.lastTmuxNudgeAt
                ? { last_nudge_at: session.lastTmuxNudgeAt }
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
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<ClearSessionContextOutput>(
      resolved.sessionId,
      "telegramMcp.sessionContext.clearContextRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const existingTarget = existing?.tmuxTarget;
    if (existingTarget && isPtyTarget(existingTarget)) {
      stopPtyTarget(existingTarget);
    }
    await this.sessionStore.clearSession(resolved.sessionId);
    await this.bindingStore.clearBinding(resolved.sessionId);
    this.projectIdentityResolver.removeSessionMarker(existing?.cwd || resolved.cwd);

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
