import { GrammyError, type Bot } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type { SessionStore, SessionBindingStore } from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import { isTmuxUnavailableError } from "../tmux/client";
import type { TransportTmuxActions } from "./transportTmuxActions";
import type { TelegramMenuContext } from "./transportTypes";

export interface TransportTmuxRuntimeHost {
  config: AppConfig;
  logger: Logger;
  bot: Bot<TelegramMenuContext>;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  isTelegramEnabled(): boolean;
  tmuxActions: TransportTmuxActions;
  tmuxNudgeDebounceTimers: Map<string, NodeJS.Timeout>;
}

export class TransportTmuxRuntime {
  private tmuxPromptScanTimer: NodeJS.Timeout | undefined;
  private tmuxPromptScanInFlight = false;

  public constructor(private readonly host: TransportTmuxRuntimeHost) {}

  public clearTmuxNudgeDebounceTimers(): void {
    for (const timer of this.host.tmuxNudgeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.host.tmuxNudgeDebounceTimers.clear();
  }

  public startPromptScan(): void {
    if (!this.host.config.tmux.promptScanEnabled) {
      return;
    }

    this.clearTmuxPromptScanTimer();

    const intervalMs = this.host.config.tmux.promptScanIntervalSeconds * 1000;
    const timer = setInterval(() => {
      void this.runTmuxPromptScanCycle().catch((error) => {
        this.host.logger.warn("tmux prompt scan cycle failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    this.tmuxPromptScanTimer = timer;

    this.host.logger.info("tmux prompt scan scheduled", {
      intervalSeconds: this.host.config.tmux.promptScanIntervalSeconds,
      cooldownSeconds: this.host.config.tmux.promptScanCooldownSeconds,
      strategy: this.host.config.tmux.promptScanStrategy,
      minScore: this.host.config.tmux.promptScanMinScore,
    });

    void this.runTmuxPromptScanCycle().catch((error) => {
      this.host.logger.warn("initial tmux prompt scan failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
  }

  public clearTmuxPromptScanTimer(): void {
    if (this.tmuxPromptScanTimer) {
      clearInterval(this.tmuxPromptScanTimer);
      this.tmuxPromptScanTimer = undefined;
    }
  }

  public scheduleTmuxNudgeForInboxMessage(
    sessionId: string,
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): void {
    if (!this.host.config.tmux.nudgeEnabled) {
      return;
    }

    if (!session?.tmuxTarget) {
      this.host.logger.debug("tmux nudge scheduling skipped for inbox message", {
        sessionId,
        reason: "no_tmux_target",
      });
      return;
    }

    const existingTimer = this.host.tmuxNudgeDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.host.tmuxNudgeDebounceTimers.delete(sessionId);
      void this.host.tmuxActions.nudgeForInboxMessage(sessionId).catch((error) => {
        const payload = {
          sessionId,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };

        if (isTmuxUnavailableError(error)) {
          void this.host.sessionStore.getSession(sessionId).then((currentSession) => {
            if (!currentSession?.tmuxTarget) {
              return;
            }

            return this.host.tmuxActions.notifyUnavailable(
              sessionId,
              currentSession,
              error,
            );
          });
          this.host.logger.warn(
            "tmux nudge skipped because tmux is unavailable",
            payload,
          );
          return;
        }

        this.host.logger.error("tmux nudge failed", payload);
      });
    }, this.host.config.tmux.nudgeDebounceSeconds * 1000);
    timer.unref();
    this.host.tmuxNudgeDebounceTimers.set(sessionId, timer);

    this.host.logger.info("tmux nudge scheduled for inbox message", {
      sessionId,
      tmuxTarget: session.tmuxTarget,
      debounceSeconds: this.host.config.tmux.nudgeDebounceSeconds,
    });
  }

  public async sendTypingForSession(sessionId: string): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      this.host.logger.debug("Telegram typing skipped because transport is disabled", {
        sessionId,
      });
      return;
    }

    const binding = await this.host.bindingStore.getBinding(sessionId);
    if (!binding) {
      this.host.logger.debug("Telegram typing skipped because session is unbound", {
        sessionId,
      });
      return;
    }

    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.host.bot.api.sendChatAction(binding.telegramChatId, "typing");
        this.host.logger.debug("Telegram typing action sent", {
          sessionId,
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        });
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(
          1,
          error.parameters.retry_after ?? 1,
        );
        this.host.logger.warn(
          "Telegram rate limit hit while sending typing action, cooling down",
          {
            sessionId,
            telegramChatId: binding.telegramChatId,
            telegramUserId: binding.telegramUserId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }

  private async runTmuxPromptScanCycle(): Promise<void> {
    if (!this.host.config.tmux.promptScanEnabled || this.tmuxPromptScanInFlight) {
      return;
    }

    this.tmuxPromptScanInFlight = true;
    try {
      const sessions = await this.host.sessionStore.listSessions();
      for (const session of sessions) {
        await this.host.tmuxActions.scanPromptForSession(session);
      }
    } finally {
      this.tmuxPromptScanInFlight = false;
    }
  }
}
