import type { AppConfig } from "../../../app/config/env.js";
import type {
  CreateSessionPairCodeInput,
  CreateSessionPairCodeOutput,
  PairCodeRecord,
} from "../../../entities/auth/model/types.js";
import type {
  SessionStore,
  SessionBindingStore,
} from "../../../shared/api/storage/contract.js";
import { createPairCode } from "../../../shared/lib/ids/ids.js";
import type { Logger } from "../../../shared/lib/logger/logger.js";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity.js";
import type {
  ClearSessionPairingInput,
  ClearSessionPairingOutput,
} from "../../../entities/auth/model/types.js";

export class PairSessionService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async createPairCode(
    input: CreateSessionPairCodeInput,
  ): Promise<CreateSessionPairCodeOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const now = new Date();
    const ttlSeconds =
      input.expires_in_seconds ?? this.config.pairCodeTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const code = createPairCode();

    const existingSession = await this.sessionStore.getSession(
      resolved.sessionId,
    );
    await this.sessionStore.setSession({
      sessionId: resolved.sessionId,
      ...(input.session_label
        ? { label: input.session_label }
        : resolved.sessionLabel
          ? { label: resolved.sessionLabel }
          : existingSession?.label
            ? { label: existingSession.label }
            : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions
        ? { decisions: existingSession.decisions }
        : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      ...(input.tmux_session_name
        ? { tmuxSessionName: input.tmux_session_name }
        : existingSession?.tmuxSessionName
          ? { tmuxSessionName: existingSession.tmuxSessionName }
          : {}),
      ...(input.tmux_window_name
        ? { tmuxWindowName: input.tmux_window_name }
        : existingSession?.tmuxWindowName
          ? { tmuxWindowName: existingSession.tmuxWindowName }
          : {}),
      ...(typeof input.tmux_window_index === "number"
        ? { tmuxWindowIndex: input.tmux_window_index }
        : typeof existingSession?.tmuxWindowIndex === "number"
          ? { tmuxWindowIndex: existingSession.tmuxWindowIndex }
          : {}),
      ...(input.tmux_pane_id
        ? { tmuxPaneId: input.tmux_pane_id, tmuxTarget: input.tmux_pane_id }
        : existingSession?.tmuxPaneId
          ? {
              tmuxPaneId: existingSession.tmuxPaneId,
              ...(existingSession.tmuxTarget
                ? { tmuxTarget: existingSession.tmuxTarget }
                : {}),
            }
          : existingSession?.tmuxTarget
            ? { tmuxTarget: existingSession.tmuxTarget }
            : {}),
      ...(typeof input.tmux_pane_index === "number"
        ? { tmuxPaneIndex: input.tmux_pane_index }
        : typeof existingSession?.tmuxPaneIndex === "number"
          ? { tmuxPaneIndex: existingSession.tmuxPaneIndex }
          : {}),
      ...(existingSession?.lastTmuxNudgeAt
        ? { lastTmuxNudgeAt: existingSession.lastTmuxNudgeAt }
        : {}),
      updatedAt: now.toISOString(),
    });

    const record: PairCodeRecord = {
      code,
      sessionId: resolved.sessionId,
      ...(resolved.sessionLabel ? { sessionLabel: resolved.sessionLabel } : {}),
      createdAt: now.toISOString(),
      expiresAt,
    };

    await this.bindingStore.createPairCode(record, ttlSeconds);

    this.logger.info("Session pair code created", {
      sessionId: resolved.sessionId,
      sessionLabel: resolved.sessionLabel,
      sessionIdDerived: resolved.sessionIdDerived,
      sessionLabelDerived: resolved.sessionLabelDerived,
      tmuxSessionName: input.tmux_session_name,
      tmuxWindowName: input.tmux_window_name,
      tmuxWindowIndex: input.tmux_window_index,
      tmuxPaneId: input.tmux_pane_id,
      tmuxPaneIndex: input.tmux_pane_index,
      expiresAt,
      ttlSeconds,
    });

    return {
      session_id: resolved.sessionId,
      code,
      expires_at: expiresAt,
      status: "pending",
      status_message:
        "Pairing code created. Send it to the Telegram bot and then use get_session_context to confirm that pairing is active.",
      ...(this.config.telegram.botUsername
        ? {
            telegram_link_hint: `https://t.me/${this.config.telegram.botUsername}?start=${encodeURIComponent(code)}`,
          }
        : {}),
    };
  }

  public async clearPairing(
    input: ClearSessionPairingInput,
  ): Promise<ClearSessionPairingOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    await this.bindingStore.clearBinding(resolved.sessionId);

    this.logger.info("Session pairing cleared", {
      sessionId: resolved.sessionId,
      sessionIdDerived: resolved.sessionIdDerived,
    });

    return {
      cleared: true,
      session_id: resolved.sessionId,
    };
  }
}
