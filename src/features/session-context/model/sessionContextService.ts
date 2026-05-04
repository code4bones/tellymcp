import type { AppConfig } from "../../../app/config/env.js";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../../shared/api/storage/contract.js";
import type { Logger } from "../../../shared/lib/logger/logger.js";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity.js";
import { redactSecrets } from "../../../shared/lib/redact-secrets/redactSecrets.js";
import type {
  ClearSessionContextInput,
  ClearSessionContextOutput,
  GetTmuxTargetInput,
  GetTmuxTargetOutput,
  GetHumanChannelModeInput,
  GetHumanChannelModeOutput,
  GetSessionContextInput,
  GetSessionContextOutput,
  HumanChannelMode,
  SetSessionContextInput,
  SetSessionContextOutput,
  SetHumanChannelModeInput,
  SetHumanChannelModeOutput,
  SetTmuxTargetInput,
  SetTmuxTargetOutput,
} from "../../../entities/session/model/types.js";

function buildHumanModeStatus(
  config: AppConfig,
  mode: HumanChannelMode,
  hasBinding: boolean,
  hasTmuxTarget: boolean,
): { statusMessage: string; telegramPollingEnabled: boolean } {
  if (mode === "telegram") {
    if (!hasBinding) {
      return hasTmuxTarget && config.tmux.nudgeEnabled
        ? {
            statusMessage:
              "Telegram mode is requested, but the session is not paired yet. Pair the session before relying on Telegram polling or tmux nudges.",
            telegramPollingEnabled: false,
          }
        : {
            statusMessage:
              "Telegram mode is requested, but the session is not paired yet. Pair the session before relying on Telegram polling.",
            telegramPollingEnabled: false,
          };
    }

    if (hasTmuxTarget && config.tmux.nudgeEnabled) {
      return {
        statusMessage:
          "Telegram mode is active. When a new non-reply Telegram message is stored in inbox, the service will nudge the configured tmux pane and the agent should then fetch inbox messages through MCP tools.",
        telegramPollingEnabled: true,
      };
    }

    if (hasTmuxTarget) {
      return {
        statusMessage:
          "Telegram mode is active. A tmux target is configured, but tmux nudging is disabled in the service configuration. The agent should still poll Telegram inbox count at checkpoints.",
        telegramPollingEnabled: true,
      };
    }

    return {
      statusMessage:
        "Telegram mode is active. The agent should poll Telegram inbox count and only fetch inbox messages when the count is greater than zero.",
      telegramPollingEnabled: true,
    };
  }

  return {
    statusMessage:
      "Direct mode is active. The agent should not poll Telegram inbox unless explicitly instructed.",
    telegramPollingEnabled: false,
  };
}

function buildHumanModeAgentInstruction(
  config: AppConfig,
  mode: HumanChannelMode,
  hasTmuxTarget: boolean,
): string {
  return mode === "telegram"
    ? hasTmuxTarget && config.tmux.nudgeEnabled
      ? "Telegram mode enabled for this session. The service will nudge the tmux pane when a new non-reply Telegram message is stored in inbox. When nudged, call get_telegram_inbox, process the returned batch carefully, delete only handled inbox messages, and continue to the next batch only if has_more is true and the current batch completed cleanly."
      : "Telegram mode enabled for this session. Periodically call get_telegram_inbox_count at checkpoints, call get_telegram_inbox only if total > 0, and delete processed inbox messages. Prefer Telegram for asynchronous human interaction while this mode stays active."
    : "Direct mode enabled for this session. Do not poll Telegram inbox proactively. Use Telegram only for explicit ask_user_telegram or notify_telegram actions.";
}

export class SessionContextService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async setContext(
    input: SetSessionContextInput,
  ): Promise<SetSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
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
      ...(existing?.humanMode ? { humanMode: existing.humanMode } : {}),
      ...(existing?.tmuxSessionName
        ? { tmuxSessionName: existing.tmuxSessionName }
        : {}),
      ...(existing?.tmuxTarget ? { tmuxTarget: existing.tmuxTarget } : {}),
      ...(existing?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
        : {}),
      updatedAt,
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

  public async getContext(
    input: GetSessionContextInput,
  ): Promise<GetSessionContextOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    const humanMode = session?.humanMode ?? "direct";
    const modeStatus = buildHumanModeStatus(
      this.config,
      humanMode,
      Boolean(binding),
      Boolean(session?.tmuxTarget),
    );

    this.logger.debug("Session context requested", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      exists: Boolean(session),
      hasBinding: Boolean(binding),
    });

    const statusMessage = binding
      ? `${modeStatus.statusMessage} Telegram pairing is active for this session.`
      : session
        ? `${modeStatus.statusMessage} Session metadata exists, but Telegram pairing is not active.`
        : `${modeStatus.statusMessage} Session metadata and Telegram pairing are both absent.`;

    return {
      session_id: resolved.sessionId,
      exists: Boolean(session),
      has_binding: Boolean(binding),
      human_channel_mode: humanMode,
      telegram_polling_enabled: modeStatus.telegramPollingEnabled,
      status_message: statusMessage,
      ...(session
        ? {
            context: {
              ...(session.label ? { session_label: session.label } : {}),
              ...(session.task ? { task: session.task } : {}),
              ...(session.summary ? { summary: session.summary } : {}),
              ...(session.files ? { files: session.files } : {}),
              ...(session.decisions ? { decisions: session.decisions } : {}),
              ...(session.risks ? { risks: session.risks } : {}),
              human_channel_mode: humanMode,
              updated_at: session.updatedAt,
            },
          }
        : {}),
      ...(binding
        ? {
            binding: {
              telegram_chat_id: binding.telegramChatId,
              telegram_user_id: binding.telegramUserId,
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
    await this.sessionStore.clearSession(resolved.sessionId);
    await this.bindingStore.clearBinding(resolved.sessionId);

    this.logger.info("Session context cleared", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      clearedPairing: true,
    });

    return {
      cleared: true,
      session_id: resolved.sessionId,
      cleared_pairing: true,
    };
  }

  public async getHumanChannelMode(
    input: GetHumanChannelModeInput,
  ): Promise<GetHumanChannelModeOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    const humanMode = session?.humanMode ?? "direct";
    const hasTmuxTarget = Boolean(session?.tmuxTarget);
    const modeStatus = buildHumanModeStatus(
      this.config,
      humanMode,
      Boolean(binding),
      hasTmuxTarget,
    );
    const agentInstruction = buildHumanModeAgentInstruction(
      this.config,
      humanMode,
      hasTmuxTarget,
    );

    this.logger.debug("Session human channel mode requested", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      humanChannelMode: humanMode,
      hasBinding: Boolean(binding),
      telegramPollingEnabled: modeStatus.telegramPollingEnabled,
    });

    return {
      session_id: resolved.sessionId,
      has_binding: Boolean(binding),
      human_channel_mode: humanMode,
      telegram_polling_enabled: modeStatus.telegramPollingEnabled,
      tmux_target_configured: hasTmuxTarget,
      tmux_nudge_enabled: this.config.tmux.nudgeEnabled,
      status_message: modeStatus.statusMessage,
      agent_instruction: agentInstruction,
    };
  }

  public async setHumanChannelMode(
    input: SetHumanChannelModeInput,
  ): Promise<SetHumanChannelModeOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    const updatedAt = new Date().toISOString();
    const hasTmuxTarget = Boolean(existing?.tmuxTarget);

    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      ...(existing?.label
        ? { label: existing.label }
        : resolved.sessionLabel
          ? { label: redactSecrets(resolved.sessionLabel) }
          : {}),
      ...(existing?.task ? { task: existing.task } : {}),
      ...(existing?.summary ? { summary: existing.summary } : {}),
      ...(existing?.files ? { files: existing.files } : {}),
      ...(existing?.decisions ? { decisions: existing.decisions } : {}),
      ...(existing?.risks ? { risks: existing.risks } : {}),
      ...(existing?.tmuxSessionName
        ? { tmuxSessionName: existing.tmuxSessionName }
        : {}),
      ...(existing?.tmuxTarget ? { tmuxTarget: existing.tmuxTarget } : {}),
      ...(existing?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
        : {}),
      humanMode: input.mode,
      updatedAt,
    });

    const modeStatus = buildHumanModeStatus(
      this.config,
      input.mode,
      Boolean(binding),
      hasTmuxTarget,
    );
    const agentInstruction = buildHumanModeAgentInstruction(
      this.config,
      input.mode,
      hasTmuxTarget,
    );

    this.logger.info("Session human channel mode updated", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      humanChannelMode: input.mode,
      hasBinding: Boolean(binding),
      telegramPollingEnabled: modeStatus.telegramPollingEnabled,
    });

    return {
      session_id: resolved.sessionId,
      human_channel_mode: input.mode,
      telegram_polling_enabled: modeStatus.telegramPollingEnabled,
      tmux_target_configured: hasTmuxTarget,
      tmux_nudge_enabled: this.config.tmux.nudgeEnabled,
      status_message: modeStatus.statusMessage,
      agent_instruction: agentInstruction,
    };
  }

  public async setTmuxTarget(
    input: SetTmuxTargetInput,
  ): Promise<SetTmuxTargetOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const existing = await this.sessionStore.getSession(resolved.sessionId);
    const updatedAt = new Date().toISOString();
    const sanitizedTarget = redactSecrets(input.tmux_target);
    const sanitizedSessionName = input.tmux_session_name
      ? redactSecrets(input.tmux_session_name)
      : existing?.tmuxSessionName;

    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      ...(existing?.label
        ? { label: existing.label }
        : resolved.sessionLabel
          ? { label: redactSecrets(resolved.sessionLabel) }
          : {}),
      ...(existing?.task ? { task: existing.task } : {}),
      ...(existing?.summary ? { summary: existing.summary } : {}),
      ...(existing?.files ? { files: existing.files } : {}),
      ...(existing?.decisions ? { decisions: existing.decisions } : {}),
      ...(existing?.risks ? { risks: existing.risks } : {}),
      ...(existing?.humanMode ? { humanMode: existing.humanMode } : {}),
      ...(sanitizedSessionName
        ? { tmuxSessionName: sanitizedSessionName }
        : {}),
      tmuxTarget: sanitizedTarget,
      ...(existing?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existing.lastTmuxNudgeAt }
        : {}),
      updatedAt,
    });

    this.logger.info("Session tmux target saved", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      tmuxSessionName: sanitizedSessionName,
      tmuxTarget: sanitizedTarget,
    });

    return {
      session_id: resolved.sessionId,
      tmux_target: sanitizedTarget,
      ...(sanitizedSessionName
        ? { tmux_session_name: sanitizedSessionName }
        : {}),
      status_message:
        "tmux target saved for this session. In Telegram mode, the service can nudge this tmux pane when a new non-reply Telegram message is stored in inbox.",
    };
  }

  public async getTmuxTarget(
    input: GetTmuxTargetInput,
  ): Promise<GetTmuxTargetOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const configured = Boolean(session?.tmuxTarget);

    this.logger.debug("Session tmux target requested", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
      configured,
    });

    return {
      session_id: resolved.sessionId,
      configured,
      ...(session?.tmuxTarget ? { tmux_target: session.tmuxTarget } : {}),
      ...(session?.tmuxSessionName
        ? { tmux_session_name: session.tmuxSessionName }
        : {}),
      ...(session?.lastTmuxNudgeAt
        ? { last_nudge_at: session.lastTmuxNudgeAt }
        : {}),
      status_message: configured
        ? "tmux target is configured for this session."
        : "tmux target is not configured for this session.",
    };
  }
}
