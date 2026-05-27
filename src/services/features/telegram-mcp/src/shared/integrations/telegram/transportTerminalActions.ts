import {
  captureTerminalPaneRange,
  captureVisibleTerminal,
  ensureTerminalTargetForSession,
  getTerminalWindowHeight,
  isTerminalTargetInvalidError,
  isTerminalUnavailableError,
  resolveTerminalTargetFromHint,
  sendTerminalLiteralLine,
} from "../terminal/client";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type { AppConfig } from "../../../app/config/env";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../api/storage/contract";
import type { HumanTransportNotification } from "../../api/transport/contract";
import type { Logger } from "../../lib/logger/logger";
import {
  detectTerminalInteractivePrompt,
  type TerminalPromptDetection,
} from "../../lib/terminalPromptDetection";
import { type SupportedLocale } from "../../i18n";
import { slugifyFilenamePart, shouldNudge } from "./transportUtils";
import type { GatewayActorProfile, TerminalCaptureScope } from "./transportTypes";

const TERMINAL_NUDGE_FAILURE_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;
const TERMINAL_PROMPT_SCAN_MATCHED_LINES_LIMIT = 6;

type SessionRecord = Awaited<ReturnType<SessionStore["listSessions"]>>[number];
type BindingRecord = Awaited<ReturnType<SessionBindingStore["getBinding"]>>;

export interface TransportTerminalHost {
  config: AppConfig;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  logger: Logger;
  terminalNudgeFailureNoticeAt: Map<string, number>;
  terminalPromptNoticeState: Map<string, { fingerprint: string; sentAtMs: number }>;
  sendTypingForSession(sessionId: string): Promise<void>;
  resolveLocaleForTelegramUserId(userId: number): Promise<SupportedLocale>;
  sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }>;
  sendLiveViewLauncherMessage(input: {
    principal: { telegramChatId: number; telegramUserId: number };
    sessionId: string;
    sessionName: string;
    locale: SupportedLocale;
    actor?: GatewayActorProfile;
    allowForeignBinding?: boolean;
  }): Promise<{ message_id: number } | null>;
  callGatewayJson<T>(
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
  t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string;
}

export class TransportTerminalActions {
  public constructor(private readonly host: TransportTerminalHost) {}

  private buildCapturePreview(capture: string): string[] {
    return capture
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-6);
  }

  private isExpectedRelayCaptureMiss(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error);
    return (
      /\bInvalid live relay view response\b/u.test(message) ||
      /\bis not connected\b/u.test(message) ||
      /\brequest is rejected\b/u.test(message) ||
      /\brelay live capture did not return terminal content\b/u.test(message)
    );
  }

  private buildRelayTerminalTarget(sessionId: string): string | null {
    const relay = parseLiveRelaySessionId(sessionId);
    if (!relay) {
      return null;
    }

    return `relay:${relay.clientUuid}/${relay.localSessionId}`;
  }

  private extractTerminalTextFromGatewayMarkdown(markdownContent: string): string {
    const match = markdownContent.match(/```text\n([\s\S]*?)\n```/u);
    return match?.[1] ?? markdownContent;
  }

  private async ensurePtyTargetForSession(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
  ): Promise<string | null> {
    const ensuredTarget = ensureTerminalTargetForSession(this.host.config.terminal, {
      sessionId,
      ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}),
      ...(typeof session.terminalTarget === "string"
        ? { target: session.terminalTarget }
        : {}),
    });

    if (!ensuredTarget) {
      return null;
    }

    if (ensuredTarget === session.terminalTarget) {
      return ensuredTarget;
    }

    await this.host.sessionStore.setSession({
      ...session,
      terminalTarget: ensuredTarget,
      updatedAt: new Date().toISOString(),
    });

    this.host.logger.info("PTY terminal target normalized", {
      sessionId,
      previousTerminalTarget: session.terminalTarget,
      normalizedTerminalTarget: ensuredTarget,
    });

    return ensuredTarget;
  }

  public async nudgeForInboxMessage(sessionId: string): Promise<void> {
    await this.nudgeForSession(sessionId, {
      message: this.host.config.terminal.nudgeMessage,
      reason: "human_message",
    });
  }

  public async nudgeForSession(
    sessionId: string,
    input: {
      message: string;
      reason: "human_message" | "partner_note";
    },
  ): Promise<void> {
    if (!this.host.config.terminal.nudgeEnabled) {
      return;
    }

    const session = await this.host.sessionStore.getSession(sessionId);
    if (!session?.terminalTarget) {
      this.host.logger.debug("terminal nudge skipped", {
        sessionId,
        nudgeReason: input.reason,
        skipReason: "no_terminal_target",
      });
      return;
    }

    let normalizedSession = session;
    if (!session.terminalTarget.startsWith("pty:")) {
      const normalizedTarget = await this.ensurePtyTargetForSession(sessionId, session);
      if (normalizedTarget) {
        normalizedSession = {
          ...session,
          terminalTarget: normalizedTarget,
        };
      }
    }

    const nowMs = Date.now();
    if (
      !shouldNudge(
        session.lastTerminalNudgeAt,
        this.host.config.terminal.nudgeCooldownSeconds,
        nowMs,
      )
    ) {
      this.host.logger.debug("terminal nudge skipped because of cooldown", {
        sessionId,
        reason: input.reason,
        terminalTarget: normalizedSession.terminalTarget,
        lastTerminalNudgeAt: normalizedSession.lastTerminalNudgeAt,
      });
      return;
    }

    await this.host.sendTypingForSession(sessionId);

    let terminalTarget = normalizedSession.terminalTarget ?? null;
    if (!terminalTarget) {
      this.host.logger.debug("terminal nudge skipped", {
        sessionId,
        nudgeReason: input.reason,
        skipReason: "normalized_target_missing",
      });
      return;
    }
    try {
      await sendTerminalLiteralLine(this.host.config.terminal, terminalTarget, input.message);
    } catch (error) {
      if (isTerminalTargetInvalidError(error) || isTerminalUnavailableError(error)) {
        const recoveredTarget = await this.ensurePtyTargetForSession(
          sessionId,
          normalizedSession,
        );
        if (recoveredTarget) {
          terminalTarget = recoveredTarget;
          await sendTerminalLiteralLine(
            this.host.config.terminal,
            recoveredTarget,
            input.message,
          );
        } else {
          await this.notifyTargetInvalid(sessionId, normalizedSession, error);
          throw error;
        }
      } else {
        throw error;
      }
    }

    const lastTerminalNudgeAt = new Date(nowMs).toISOString();
    await this.host.sessionStore.setSession({
      ...normalizedSession,
      terminalTarget: terminalTarget,
      lastTerminalNudgeAt,
    });
    this.host.terminalNudgeFailureNoticeAt.delete(sessionId);

    this.host.logger.info("terminal nudge sent", {
      sessionId,
      reason: input.reason,
      message: input.message,
      terminalTarget,
      lastTerminalNudgeAt,
    });
  }

  public async tryRecoverTarget(
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<SessionStore["getSession"]>>>,
  ): Promise<string | null> {
    const recoveredTarget = await resolveTerminalTargetFromHint(this.host.config.terminal, {
      terminalTarget: session.terminalTarget,
    });

    if (!recoveredTarget || recoveredTarget === session.terminalTarget) {
      return recoveredTarget;
    }

    await this.host.sessionStore.setSession({
      ...session,
      terminalTarget: recoveredTarget,
      updatedAt: new Date().toISOString(),
    });

    this.host.logger.warn("terminal target auto-recovered", {
      sessionId,
      previousTerminalTarget: session.terminalTarget,
      recoveredTerminalTarget: recoveredTarget,
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
    const lastNoticeAt = this.host.terminalNudgeFailureNoticeAt.get(sessionId);
    if (
      lastNoticeAt &&
      nowMs - lastNoticeAt < TERMINAL_NUDGE_FAILURE_NOTICE_COOLDOWN_MS
    ) {
      return;
    }
    this.host.terminalNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const terminalTarget = session.terminalTarget ?? "unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    try {
      await this.host.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.host.t(locale, "menu:notices.terminal.target_invalid_title", {
            sessionName: sessionLabel,
          }),
          this.host.t(locale, "menu:notices.terminal.target_invalid_target", {
            terminalTarget,
          }),
          this.host.t(locale, "menu:system.error_prefix", {
            message: errorMessage,
          }),
          this.host.t(locale, "menu:system.terminal_recreated_hint"),
          this.host.t(locale, "menu:notices.terminal.target_invalid_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.host.logger.warn(
        "Failed to deliver terminal target failure notification",
        {
          sessionId,
          terminalTarget,
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
          notifyError:
            notifyError instanceof Error
              ? (notifyError.stack ?? notifyError.message)
              : String(notifyError),
        },
      );
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
    const lastNoticeAt = this.host.terminalNudgeFailureNoticeAt.get(sessionId);
    if (
      lastNoticeAt &&
      nowMs - lastNoticeAt < TERMINAL_NUDGE_FAILURE_NOTICE_COOLDOWN_MS
    ) {
      return;
    }
    this.host.terminalNudgeFailureNoticeAt.set(sessionId, nowMs);

    const sessionLabel = session.label ?? sessionId;
    const terminalTarget = session.terminalTarget ?? "unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    try {
      await this.host.sendNotification({
        sessionId,
        sessionLabel: "TellyMCP",
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.host.t(locale, "menu:notices.terminal.unavailable_title", {
            sessionName: sessionLabel,
          }),
          this.host.t(locale, "menu:notices.terminal.unavailable_body"),
          this.host.t(locale, "menu:notices.terminal.unavailable_target", {
            terminalTarget,
          }),
          this.host.t(locale, "menu:system.error_prefix", {
            message: errorMessage,
          }),
          this.host.t(locale, "menu:notices.terminal.unavailable_reason"),
          this.host.t(locale, "menu:notices.terminal.unavailable_action"),
        ].join("\n"),
      });
    } catch (notifyError) {
      this.host.logger.warn("Failed to deliver terminal unavailable notification", {
        sessionId,
        terminalTarget,
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
    const relayTerminalTarget = this.buildRelayTerminalTarget(session.sessionId);
    if (!session.terminalTarget && !relayTerminalTarget) {
      this.host.logger.debug("terminal prompt scan skipped", {
        sessionId: session.sessionId,
        sessionLabel: session.label,
        isRelaySession: relayTerminalTarget !== null,
        skipReason: "no_terminal_target",
      });
      this.host.terminalPromptNoticeState.delete(session.sessionId);
      return;
    }

    const binding = await this.host.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      this.host.logger.debug("terminal prompt scan skipped", {
        sessionId: session.sessionId,
        sessionLabel: session.label,
        isRelaySession: relayTerminalTarget !== null,
        terminalTarget: session.terminalTarget ?? relayTerminalTarget,
        skipReason: "no_binding",
      });
      this.host.terminalPromptNoticeState.delete(session.sessionId);
      return;
    }

    let terminalTarget = session.terminalTarget ?? relayTerminalTarget;
    let capture: string;

    this.host.logger.debug("terminal prompt scan started", {
      sessionId: session.sessionId,
      sessionLabel: session.label,
      isRelaySession: relayTerminalTarget !== null,
      terminalTarget,
      strategy: this.host.config.terminal.promptScanStrategy,
      minScore: this.host.config.terminal.promptScanMinScore,
    });

    try {
      capture = await this.capturePromptBuffer(session);
    } catch (error) {
      if (isTerminalUnavailableError(error)) {
        this.host.logger.debug(
          "terminal prompt scan skipped because terminal is unavailable",
          {
            sessionId: session.sessionId,
            sessionLabel: session.label,
            terminalTarget,
          },
        );
        return;
      }
      if (isTerminalTargetInvalidError(error)) {
        const recoveredTarget = await this.tryRecoverTarget(
          session.sessionId,
          session,
        );
        if (!recoveredTarget) {
          this.host.logger.debug(
            "terminal prompt scan skipped because target is invalid",
            {
              sessionId: session.sessionId,
              sessionLabel: session.label,
              terminalTarget,
            },
          );
          return;
        }
        terminalTarget = recoveredTarget;
        capture = await this.capturePromptBuffer({
          ...session,
          terminalTarget: recoveredTarget,
        });
      } else {
        if (
          relayTerminalTarget &&
          this.isExpectedRelayCaptureMiss(error)
        ) {
          this.host.logger.debug("terminal prompt scan skipped because relay capture is unavailable", {
            sessionId: session.sessionId,
            sessionLabel: session.label,
            terminalTarget,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
          this.host.terminalPromptNoticeState.delete(session.sessionId);
          return;
        }
        this.host.logger.warn("terminal prompt scan capture failed", {
          sessionId: session.sessionId,
          terminalTarget,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        return;
      }
    }

    const capturePreview = this.buildCapturePreview(capture);
    this.host.logger.debug("terminal prompt buffer captured", {
      sessionId: session.sessionId,
      sessionLabel: session.label,
      terminalTarget,
      captureChars: capture.length,
      captureLines: capture.split("\n").length,
      previewTail: capturePreview,
    });

    const detection = detectTerminalInteractivePrompt(capture, {
      strategy: this.host.config.terminal.promptScanStrategy,
      minScore: this.host.config.terminal.promptScanMinScore,
    });

    if (!detection) {
      this.host.logger.debug("terminal prompt scan found no interactive prompt", {
        sessionId: session.sessionId,
        sessionLabel: session.label,
        terminalTarget,
        strategy: this.host.config.terminal.promptScanStrategy,
        minScore: this.host.config.terminal.promptScanMinScore,
        previewTail: capturePreview,
      });
      this.host.terminalPromptNoticeState.delete(session.sessionId);
      return;
    }

    if (!this.shouldSendPromptNotice(session.sessionId, detection)) {
      return;
    }

    await this.notifyPromptDetected(
      session,
      binding,
      detection,
      terminalTarget ?? relayTerminalTarget ?? "unknown",
    );
  }

  public async capturePromptBuffer(session: {
    sessionId: string;
    terminalTarget?: string | undefined;
  }): Promise<string> {
    const relay = parseLiveRelaySessionId(session.sessionId);
    if (relay) {
      this.host.logger.debug("terminal prompt relay capture requested", {
        sessionId: session.sessionId,
        clientUuid: relay.clientUuid,
        localSessionId: relay.localSessionId,
      });
      const output = await this.host.callGatewayJson<{
        markdown_content?: string;
      }>("/live/capture-buffer", {
        session_id: session.sessionId,
        scope: {
          mode: "visible",
        },
      });
      const markdownContent =
        typeof output.markdown_content === "string"
          ? output.markdown_content
          : "";
      if (!markdownContent.trim()) {
        this.host.logger.warn("terminal prompt relay capture returned empty content", {
          sessionId: session.sessionId,
          clientUuid: relay.clientUuid,
          localSessionId: relay.localSessionId,
        });
        throw new Error("relay live capture did not return terminal content");
      }

      return this.extractTerminalTextFromGatewayMarkdown(markdownContent);
    }

    const target = session.terminalTarget;
    if (!target) {
      throw new Error("terminal target is not configured");
    }
    if (this.host.config.terminal.captureMode === "visible") {
      return captureVisibleTerminal(
        this.host.config.terminal,
        target,
        this.host.config.terminal.captureLines,
        this.host.config.webapp.visibleScreens,
      );
    }
    return captureTerminalPaneRange(
      this.host.config.terminal,
      target,
      `-${this.host.config.terminal.captureLines}`,
      false,
    );
  }

  public shouldSendPromptNotice(
    sessionId: string,
    detection: TerminalPromptDetection,
  ): boolean {
    const existing = this.host.terminalPromptNoticeState.get(sessionId);
    const nowMs = Date.now();
    const cooldownMs = this.host.config.terminal.promptScanCooldownSeconds * 1000;
    if (
      existing &&
      existing.fingerprint === detection.fingerprint &&
      nowMs - existing.sentAtMs < cooldownMs
    ) {
      this.host.logger.debug(
        "terminal prompt detected but notification is on cooldown",
        {
          sessionId,
          fingerprint: detection.fingerprint,
          score: detection.score,
          reasons: detection.reasons,
          cooldownSeconds: this.host.config.terminal.promptScanCooldownSeconds,
        },
      );
      return false;
    }
    this.host.terminalPromptNoticeState.set(sessionId, {
      fingerprint: detection.fingerprint,
      sentAtMs: nowMs,
    });
    return true;
  }

  public async notifyPromptDetected(
    session: SessionRecord,
    binding: BindingRecord,
    detection: TerminalPromptDetection,
    terminalTarget: string,
  ): Promise<void> {
    if (!binding) {
      return;
    }
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );
    const sessionLabel = session.label ?? session.sessionId;
    const excerpt =
      detection.excerpt
        .split("\n")
        .slice(-Math.max(TERMINAL_PROMPT_SCAN_MATCHED_LINES_LIMIT + 2, 8))
        .join("\n") || detection.matchedLines.slice(-TERMINAL_PROMPT_SCAN_MATCHED_LINES_LIMIT).join("\n");

    await this.host.sendNotification({
      sessionId: session.sessionId,
      sessionLabel: "TellyMCP",
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        this.host.t(locale, "menu:notices.terminal.prompt_detected_title", {
          sessionName: sessionLabel,
        }),
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
      this.host.logger.warn("Failed to deliver terminal prompt live launcher", {
        sessionId: session.sessionId,
        terminalTarget,
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }

    this.host.logger.info("terminal prompt detected", {
      sessionId: session.sessionId,
      terminalTarget,
      score: detection.score,
      strategy: this.host.config.terminal.promptScanStrategy,
      minScore: this.host.config.terminal.promptScanMinScore,
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
      terminalTarget?: string | undefined;
    },
    scope: TerminalCaptureScope,
  ): Promise<{
    filename: string;
    buffer: Buffer;
    captureMode: TerminalCaptureScope["mode"];
    scopeDescription: string;
  }> {
    const target = session.terminalTarget;
    if (!target) {
      throw new Error("terminal target is not configured");
    }
    const paneStart = await this.resolveCaptureStart(target, scope);
    const stdout = await captureTerminalPaneRange(
      this.host.config.terminal,
      target,
      paneStart,
      false,
    );

    const capturedAt = new Date().toISOString();
    const scopeDescription = this.describeCaptureScope(scope);
    const titleBase = session.label ?? session.sessionId;
    const filenameBase = slugifyFilenamePart(titleBase) || "session-buffer";
    const timestamp = capturedAt.replace(/[:.]/g, "-");
    const filename = `${filenameBase}-${timestamp}.md`;
    const content = [
      "# Terminal Buffer",
      "",
      `- Session: ${session.label ?? session.sessionId}`,
      `- Session ID: ${session.sessionId}`,
      `- terminal target: ${target}`,
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
    scope: TerminalCaptureScope,
  ): Promise<string> {
    if (scope.mode === "full") {
      return "-";
    }
    if (scope.mode === "lines") {
      return `-${scope.lines}`;
    }
    const height = await getTerminalWindowHeight(this.host.config.terminal, target);
    if (typeof height !== "number" || height <= 0) {
      return `-${this.host.config.terminal.captureLines}`;
    }
    return `-${height}`;
  }

  public describeCaptureScope(scope: TerminalCaptureScope): string {
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
