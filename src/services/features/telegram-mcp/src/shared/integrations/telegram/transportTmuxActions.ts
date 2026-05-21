import { captureTmuxPaneRange, captureVisibleTmuxPane, getTmuxWindowHeight, resolveTmuxTargetFromHint, sendTmuxLiteralLine } from "../tmux/client";
import type { AppConfig } from "../../../app/config/env";
import type { SessionBindingStore, SessionStore, TelegramInboxStore } from "../../api/storage/contract";
import type { HumanTransportNotification } from "../../api/transport/contract";
import type { Logger } from "../../lib/logger/logger";
import { detectTmuxInteractivePrompt, type TmuxPromptDetection } from "../../lib/tmuxPromptDetection";
import { type SupportedLocale } from "../../i18n";
import { slugifyFilenamePart, shouldNudge } from "./transportUtils";
import type { GatewayActorProfile, TmuxCaptureScope, WebAppLaunchMode } from "./transportTypes";
import { isTmuxTargetInvalidError, isTmuxUnavailableError } from "../tmux/client";

const TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;
const TMUX_PROMPT_SCAN_MATCHED_LINES_LIMIT = 6;

type SessionRecord = Awaited<ReturnType<SessionStore["listSessions"]>>[number];
type BindingRecord = Awaited<ReturnType<SessionBindingStore["getBinding"]>>;

export interface TransportTmuxHost {
  config: AppConfig;
  sessionStore: SessionStore;
  inboxStore: TelegramInboxStore;
  bindingStore: SessionBindingStore;
  logger: Logger;
  tmuxNudgeFailureNoticeAt: Map<string, number>;
  tmuxPromptNoticeState: Map<string, { fingerprint: string; sentAtMs: number }>;
  sendTypingForSession(sessionId: string): Promise<void>;
  resolveLocaleForTelegramUserId(userId: number): Promise<SupportedLocale>;
  sendNotification(input: HumanTransportNotification): Promise<{ externalMessageId?: string | number }>;
  sendLiveViewLauncherMessage(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sessionName: string;
    locale: SupportedLocale;
    actor?: GatewayActorProfile;
    allowForeignBinding?: boolean;
  }): Promise<{ message_id: number } | null>;
  t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string;
}

export class TransportTmuxActions {
  public constructor(private readonly host: TransportTmuxHost) {}

  public async nudgeForInboxMessage(sessionId: string): Promise<void> {
    await this.nudgeForSession(sessionId, {
      message: this.host.config.tmux.nudgeMessage,
      reason: "inbox_message",
      requireInboxMessage: true,
    });
  }

  public async nudgeForSession(
    sessionId: string,
    input: {
      message: string;
      reason: "inbox_message" | "partner_note";
      requireInboxMessage: boolean;
    },
  ): Promise<void> {
    if (!this.host.config.tmux.nudgeEnabled) {
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.tmuxTarget) {
      this.host.logger.debug("tmux nudge skipped", {
        sessionId,
        nudgeReason: input.reason,
        skipReason: "no_tmux_target",
      });
      return;
    }

    const inboxCount = await this.host.inboxStore.countInboxMessages(sessionId);
    if (input.requireInboxMessage && inboxCount === 0) {
      this.host.logger.debug("tmux nudge skipped because inbox is empty", {
        sessionId,
        reason: input.reason,
      });
      return;
    }

    const nowMs = Date.now();
    if (
      !shouldNudge(
        session.lastTmuxNudgeAt,
        this.host.config.tmux.nudgeCooldownSeconds,
        nowMs,
      )
    ) {
      this.host.logger.debug("tmux nudge skipped because of cooldown", {
        sessionId,
        reason: input.reason,
        tmuxTarget: session.tmuxTarget,
        inboxCount,
        lastTmuxNudgeAt: session.lastTmuxNudgeAt,
      });
      return;
    }

    await this.host.sendTypingForSession(sessionId);

    let tmuxTarget = session.tmuxTarget;
    try {
      await sendTmuxLiteralLine(this.host.config.tmux, tmuxTarget, input.message);
    } catch (error) {
      if (isTmuxTargetInvalidError(error)) {
        const recoveredTarget = await this.tryRecoverTarget(sessionId, session);
        if (recoveredTarget) {
          tmuxTarget = recoveredTarget;
          await sendTmuxLiteralLine(
            this.host.config.tmux,
            recoveredTarget,
            input.message,
          );
        } else {
          await this.notifyTargetInvalid(sessionId, session, error);
          throw error;
        }
      } else {
        throw error;
      }
    }

    const lastTmuxNudgeAt = new Date(nowMs).toISOString();
    await this.host.sessionStore.setSession({
      ...session,
      tmuxTarget,
      ...(tmuxTarget.startsWith("%")
        ? { tmuxPaneId: tmuxTarget }
        : session.tmuxPaneId
          ? { tmuxPaneId: session.tmuxPaneId }
          : {}),
      lastTmuxNudgeAt,
    });
    this.host.tmuxNudgeFailureNoticeAt.delete(sessionId);

    this.host.logger.info("tmux nudge sent", {
      sessionId,
      reason: input.reason,
      message: input.message,
      tmuxSessionName: session.tmuxSessionName,
      tmuxTarget,
      inboxCount,
      lastTmuxNudgeAt,
    });
  }

  public async tryRecoverTarget(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
  ): Promise<string | null> {
    const recoveredTarget = await resolveTmuxTargetFromHint(this.host.config.tmux, {
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

    await this.host.sessionStore.setSession({
      ...session,
      tmuxTarget: recoveredTarget,
      tmuxPaneId: recoveredTarget,
      updatedAt: new Date().toISOString(),
    });

    this.host.logger.warn("tmux target auto-recovered", {
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

  public async notifyTargetInvalid(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
    error: unknown,
  ): Promise<void> {
    const binding = await this.host.bindingStore.getBinding(sessionId);
    if (!binding) {
      return;
    }
    const nowMs = Date.now();
    const lastNoticeAt = this.host.tmuxNudgeFailureNoticeAt.get(sessionId);
    if (lastNoticeAt && nowMs - lastNoticeAt < TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS) {
      return;
    }
    this.host.tmuxNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const tmuxTarget = session.tmuxTarget ?? "unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const locale = await this.host.resolveLocaleForTelegramUserId(binding.telegramUserId);

    try {
      await this.host.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.host.t(locale, "menu:notices.tmux.target_invalid_title", { sessionName: sessionLabel }),
          this.host.t(locale, "menu:notices.tmux.target_invalid_target", { tmuxTarget }),
          this.host.t(locale, "menu:system.error_prefix", { message: errorMessage }),
          this.host.t(locale, "menu:system.tmux_recreated_hint"),
          this.host.t(locale, "menu:notices.tmux.target_invalid_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.host.logger.warn("Failed to deliver tmux target failure notification", {
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

  public async notifyUnavailable(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
    error: unknown,
  ): Promise<void> {
    const binding = await this.host.bindingStore.getBinding(sessionId);
    if (!binding) {
      return;
    }
    const nowMs = Date.now();
    const lastNoticeAt = this.host.tmuxNudgeFailureNoticeAt.get(sessionId);
    if (lastNoticeAt && nowMs - lastNoticeAt < TMUX_NUDGE_FAILURE_NOTICE_COOLDOWN_MS) {
      return;
    }
    this.host.tmuxNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const tmuxTarget = session.tmuxTarget ?? "unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const locale = await this.host.resolveLocaleForTelegramUserId(binding.telegramUserId);

    try {
      await this.host.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.host.t(locale, "menu:notices.tmux.unavailable_title", { sessionName: sessionLabel }),
          this.host.t(locale, "menu:notices.tmux.unavailable_body"),
          this.host.t(locale, "menu:notices.tmux.unavailable_target", { tmuxTarget }),
          this.host.t(locale, "menu:system.error_prefix", { message: errorMessage }),
          this.host.t(locale, "menu:notices.tmux.unavailable_reason"),
          this.host.t(locale, "menu:notices.tmux.unavailable_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.host.logger.warn("Failed to deliver tmux unavailable notification", {
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

  public async scanPromptForSession(session: SessionRecord): Promise<void> {
    if (!session.tmuxTarget) {
      this.host.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    const binding = await this.host.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      this.host.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    let tmuxTarget = session.tmuxTarget;
    let capture: string;

    try {
      capture = await this.capturePromptBuffer(session);
    } catch (error) {
      if (isTmuxUnavailableError(error)) {
        this.host.logger.debug("tmux prompt scan skipped because tmux is unavailable", {
          sessionId: session.sessionId,
          tmuxTarget,
        });
        return;
      }
      if (isTmuxTargetInvalidError(error)) {
        const recoveredTarget = await this.tryRecoverTarget(session.sessionId, session);
        if (!recoveredTarget) {
          this.host.logger.debug("tmux prompt scan skipped because target is invalid", {
            sessionId: session.sessionId,
            tmuxTarget,
          });
          return;
        }
        tmuxTarget = recoveredTarget;
        capture = await this.capturePromptBuffer({
          ...session,
          tmuxTarget: recoveredTarget,
          tmuxPaneId: recoveredTarget.startsWith("%") ? recoveredTarget : session.tmuxPaneId,
        });
      } else {
        this.host.logger.warn("tmux prompt scan capture failed", {
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
      strategy: this.host.config.tmux.promptScanStrategy,
      minScore: this.host.config.tmux.promptScanMinScore,
    });

    if (!detection) {
      this.host.logger.debug("tmux prompt scan found no interactive prompt", {
        sessionId: session.sessionId,
        tmuxTarget,
        strategy: this.host.config.tmux.promptScanStrategy,
        minScore: this.host.config.tmux.promptScanMinScore,
      });
      this.host.tmuxPromptNoticeState.delete(session.sessionId);
      return;
    }

    if (!this.shouldSendPromptNotice(session.sessionId, detection)) {
      return;
    }

    await this.notifyPromptDetected(session, binding, detection, tmuxTarget);
  }

  public async capturePromptBuffer(session: {
    sessionId: string;
    tmuxTarget?: string | undefined;
    tmuxPaneId?: string | undefined;
  }): Promise<string> {
    const target = session.tmuxTarget;
    if (!target) {
      throw new Error("tmux target is not configured");
    }
    if (this.host.config.tmux.captureMode === "visible") {
      return captureVisibleTmuxPane(
        this.host.config.tmux,
        target,
        this.host.config.tmux.captureLines,
        this.host.config.webapp.visibleScreens,
      );
    }
    return captureTmuxPaneRange(
      this.host.config.tmux,
      target,
      `-${this.host.config.tmux.captureLines}`,
      false,
    );
  }

  public shouldSendPromptNotice(
    sessionId: string,
    detection: TmuxPromptDetection,
  ): boolean {
    const existing = this.host.tmuxPromptNoticeState.get(sessionId);
    const nowMs = Date.now();
    const cooldownMs = this.host.config.tmux.promptScanCooldownSeconds * 1000;
    if (
      existing &&
      existing.fingerprint === detection.fingerprint &&
      nowMs - existing.sentAtMs < cooldownMs
    ) {
      this.host.logger.debug("tmux prompt detected but notification is on cooldown", {
        sessionId,
        fingerprint: detection.fingerprint,
        score: detection.score,
        reasons: detection.reasons,
        cooldownSeconds: this.host.config.tmux.promptScanCooldownSeconds,
      });
      return false;
    }
    this.host.tmuxPromptNoticeState.set(sessionId, {
      fingerprint: detection.fingerprint,
      sentAtMs: nowMs,
    });
    return true;
  }

  public async notifyPromptDetected(
    session: SessionRecord,
    binding: BindingRecord,
    detection: TmuxPromptDetection,
    tmuxTarget: string,
  ): Promise<void> {
    if (!binding) {
      return;
    }
    const locale = await this.host.resolveLocaleForTelegramUserId(binding.telegramUserId);
    const sessionLabel = session.label ?? session.sessionId;
    const excerpt = detection.matchedLines
      .slice(-TMUX_PROMPT_SCAN_MATCHED_LINES_LIMIT)
      .join("\n");

    await this.host.sendNotification({
      sessionId: session.sessionId,
      sessionLabel: "TellyMCP",
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        this.host.t(locale, "menu:notices.tmux.prompt_detected_title", { sessionName: sessionLabel }),
        this.host.t(locale, "menu:notices.tmux.prompt_detected_score", { score: detection.score }),
        this.host.t(locale, "menu:notices.tmux.prompt_detected_target", { tmuxTarget }),
        this.host.t(locale, "menu:notices.tmux.prompt_detected_hint"),
        this.host.t(locale, "menu:notices.tmux.prompt_detected_excerpt"),
        excerpt,
      ].join("\n"),
    });

    try {
      await this.host.sendLiveViewLauncherMessage({
        principal: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        sessionId: session.sessionId,
        sessionName: sessionLabel,
        locale,
      });
    } catch (error) {
      this.host.logger.warn("Failed to deliver tmux prompt live launcher", {
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

    this.host.logger.info("tmux prompt detected", {
      sessionId: session.sessionId,
      tmuxTarget,
      score: detection.score,
      strategy: this.host.config.tmux.promptScanStrategy,
      minScore: this.host.config.tmux.promptScanMinScore,
      reasons: detection.reasons,
      fingerprint: detection.fingerprint,
      matchedLines: detection.matchedLines,
      excerpt,
    });
  }

  public async captureBuffer(
    session: {
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
    const paneStart = await this.resolveCaptureStart(target, scope);
    const stdout = await captureTmuxPaneRange(this.host.config.tmux, target, paneStart, false);

    const capturedAt = new Date().toISOString();
    const scopeDescription = this.describeCaptureScope(scope);
    const titleBase = session.label ?? session.tmuxWindowName ?? session.sessionId;
    const filenameBase = slugifyFilenamePart(titleBase) || "session-buffer";
    const timestamp = capturedAt.replace(/[:.]/g, "-");
    const filename = `${filenameBase}-${timestamp}.md`;
    const content = [
      "# tmux Buffer",
      "",
      `- Session: ${session.label ?? session.sessionId}`,
      `- Session ID: ${session.sessionId}`,
      `- tmux target: ${target}`,
      ...(session.tmuxSessionName ? [`- tmux session: ${session.tmuxSessionName}`] : []),
      ...(session.tmuxWindowName ? [`- tmux window: ${session.tmuxWindowName}`] : []),
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

  public async resolveCaptureStart(
    target: string,
    scope: TmuxCaptureScope,
  ): Promise<string> {
    if (scope.mode === "full") {
      return "-";
    }
    if (scope.mode === "lines") {
      return `-${scope.lines}`;
    }
    const height = await getTmuxWindowHeight(this.host.config.tmux, target);
    if (typeof height !== "number" || height <= 0) {
      return `-${this.host.config.tmux.captureLines}`;
    }
    return `-${height}`;
  }

  public describeCaptureScope(scope: TmuxCaptureScope): string {
    switch (scope.mode) {
      case "visible":
        return "visible pane";
      case "lines":
        return `last ${scope.lines} lines`;
      case "full":
        return "full history";
    }
  }
}
