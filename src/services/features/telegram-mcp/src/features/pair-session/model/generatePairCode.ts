import type { AppConfig } from "../../../app/config/env";
import type {
  ClearSessionPairingInput,
  ClearSessionPairingOutput,
  CreateSessionPairCodeInput,
  CreateSessionPairCodeOutput,
  PairCodeRecord,
} from "../../../entities/auth/model/types";
import type {
  MaintenanceStore,
  SessionStore,
  SessionBindingStore,
} from "../../../shared/api/storage/contract";
import { createPairCode } from "../../../shared/lib/ids/ids";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import {
  callGatewayJson,
  ensureGatewayClientUuid,
} from "../../distributed-client/model/gatewayClientAccess";

export class PairSessionService {
  private static readonly MAX_PAIR_CODE_ATTEMPTS = 20;

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  private async unregisterGatewaySession(
    localSessionId: string,
  ): Promise<void> {
    if (!this.config.distributed.gatewayPublicUrl) {
      return;
    }

    const clientUuid = await this.maintenanceStore.getGatewayClientUuid();
    if (!clientUuid) {
      return;
    }

    const url = new URL(this.config.distributed.gatewayPublicUrl);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    if (!url.pathname.endsWith("/gateway")) {
      url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
    }
    url.pathname = `${url.pathname}/sessions/unregister`.replace(/\/{2,}/gu, "/");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distributed.gatewayAuthToken
          ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify({
        client_uuid: clientUuid,
        local_session_id: localSessionId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Gateway session unregister failed with status ${response.status}: ${text || response.statusText}`,
      );
    }
  }

  private async mirrorPairCodeToGateway(input: {
    code: string;
    sessionId: string;
    sessionLabel?: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<void> {
    if (!this.config.distributed.gatewayPublicUrl) {
      return;
    }

    const clientUuid = await ensureGatewayClientUuid({
      maintenanceStore: this.maintenanceStore,
      gatewayPublicUrl: this.config.distributed.gatewayPublicUrl,
      ...(this.config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this.config.distributed.gatewayAuthToken }
        : {}),
      ...(this.config.project.name ? { projectName: this.config.project.name } : {}),
      ...(this.config.telegram.botUsername
        ? { botUsername: this.config.telegram.botUsername }
        : {}),
      ...(this.config.distributed.gatewayToken
        ? { gatewayToken: this.config.distributed.gatewayToken }
        : {}),
    });

    await callGatewayJson({
      gatewayPublicUrl: this.config.distributed.gatewayPublicUrl,
      ...(this.config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this.config.distributed.gatewayAuthToken }
        : {}),
      endpointPath: "/pair-codes/register",
      body: {
        code: input.code,
        session_id: input.sessionId,
        ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      },
    });
  }

  public async registerRemotePairCode(input: {
    code: string;
    sessionId: string;
    sessionLabel?: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<boolean> {
    const expiresAtMs = new Date(input.expiresAt).getTime();
    const ttlSeconds = Math.max(
      1,
      Math.ceil((expiresAtMs - Date.now()) / 1000),
    );

    return this.bindingStore.createPairCode(
      {
        code: input.code.trim().toUpperCase(),
        sessionId: input.sessionId,
        ...(input.sessionLabel?.trim()
          ? { sessionLabel: input.sessionLabel.trim() }
          : {}),
        targetClientUuid: input.targetClientUuid.trim(),
        targetLocalSessionId: input.targetLocalSessionId.trim(),
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      },
      ttlSeconds,
    );
  }

  public async createPairCode(
    input: CreateSessionPairCodeInput,
  ): Promise<CreateSessionPairCodeOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const now = new Date();
    const ttlSeconds =
      input.expires_in_seconds ?? this.config.pairCodeTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    let code: string | null = null;

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
      ...(input.cwd
        ? { cwd: resolved.cwd }
        : existingSession?.cwd
          ? { cwd: existingSession.cwd }
          : { cwd: resolved.cwd }
      ),
      ...(existingSession?.linkedSessionId
        ? { linkedSessionId: existingSession.linkedSessionId }
        : {}),
      ...(existingSession?.activeProjectUuid
        ? { activeProjectUuid: existingSession.activeProjectUuid }
        : {}),
      ...(existingSession?.activeProjectName
        ? { activeProjectName: existingSession.activeProjectName }
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
    this.projectIdentityResolver.persistSessionMarker({
      cwd: resolved.cwd,
      sessionId: resolved.sessionId,
      sessionLabel: input.session_label?.trim() || resolved.sessionLabel,
    });

    for (
      let attempt = 0;
      attempt < PairSessionService.MAX_PAIR_CODE_ATTEMPTS;
      attempt += 1
    ) {
      const candidate = createPairCode();
      const record: PairCodeRecord = {
        code: candidate,
        sessionId: resolved.sessionId,
        ...(resolved.sessionLabel
          ? { sessionLabel: resolved.sessionLabel }
          : {}),
        createdAt: now.toISOString(),
        expiresAt,
      };
      const reserved = await this.bindingStore.createPairCode(record, ttlSeconds);
      if (reserved) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      throw new Error(
        "Failed to reserve a unique 3-digit pairing code. Try again in a moment.",
      );
    }

    this.logger.info("Session pair code created", {
      sessionId: resolved.sessionId,
      sessionLabel: resolved.sessionLabel,
      sessionIdDerived: resolved.sessionIdDerived,
      sessionLabelDerived: resolved.sessionLabelDerived,
      cwd: input.cwd?.trim(),
      tmuxSessionName: input.tmux_session_name,
      tmuxWindowName: input.tmux_window_name,
      tmuxWindowIndex: input.tmux_window_index,
      tmuxPaneId: input.tmux_pane_id,
      tmuxPaneIndex: input.tmux_pane_index,
      expiresAt,
      ttlSeconds,
    });

    await this.mirrorPairCodeToGateway({
      code,
      sessionId: resolved.sessionId,
      ...(resolved.sessionLabel ? { sessionLabel: resolved.sessionLabel } : {}),
      createdAt: now.toISOString(),
      expiresAt,
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
    const existingSession = await this.sessionStore.getSession(resolved.sessionId);
    if (existingSession) {
      await this.unregisterGatewaySession(resolved.sessionId);
      await this.sessionStore.setSession({
        ...existingSession,
        activeProjectUuid: undefined,
        activeProjectName: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
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
