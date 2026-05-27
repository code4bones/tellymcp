import { GrammyError, type Bot } from "grammy";

import type { AppConfig } from "../../../app/config/env";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../api/storage/contract";
import type { TelegramPrincipal } from "../../../entities/auth/model/types";
import type { Logger } from "../../lib/logger/logger";
import { isTerminalUnavailableError } from "../terminal/client";
import type { TransportTerminalActions } from "./transportTerminalActions";
import type { TelegramMenuContext } from "./transportTypes";

export interface TransportTerminalRuntimeHost {
  config: AppConfig;
  logger: Logger;
  bot: Bot<TelegramMenuContext>;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  isTelegramEnabled(): boolean;
  terminalActions?: TransportTerminalActions;
  terminalNudgeDebounceTimers: Map<string, NodeJS.Timeout>;
  ensureGatewayScopedConsolesBoundForPrincipal?(
    principal: TelegramPrincipal,
  ): Promise<void>;
}

export class TransportTerminalRuntime {
  private terminalPromptScanTimer: NodeJS.Timeout | undefined;
  private terminalPromptScanInFlight = false;

  public constructor(private readonly host: TransportTerminalRuntimeHost) {}

  private get actions(): TransportTerminalActions {
    const actions = this.host.terminalActions;
    if (!actions) {
      throw new Error("TransportTerminalRuntime requires terminal actions");
    }
    return actions;
  }

  public clearTerminalNudgeDebounceTimers(): void {
    for (const timer of this.host.terminalNudgeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.host.terminalNudgeDebounceTimers.clear();
  }

  public startPromptScan(): void {
    if (!this.host.config.terminal.promptScanEnabled) {
      this.host.logger.debug("terminal prompt scan disabled", {
        promptScanEnabled: this.host.config.terminal.promptScanEnabled,
      });
      return;
    }

    this.clearTerminalPromptScanTimer();

    const intervalMs = this.host.config.terminal.promptScanIntervalSeconds * 1000;
    const timer = setInterval(() => {
      void this.runTerminalPromptScanCycle().catch((error) => {
        this.host.logger.warn("terminal prompt scan cycle failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    this.terminalPromptScanTimer = timer;

    this.host.logger.info("terminal prompt scan scheduled", {
      intervalSeconds: this.host.config.terminal.promptScanIntervalSeconds,
      cooldownSeconds: this.host.config.terminal.promptScanCooldownSeconds,
      strategy: this.host.config.terminal.promptScanStrategy,
      minScore: this.host.config.terminal.promptScanMinScore,
    });

    void this.runTerminalPromptScanCycle().catch((error) => {
      this.host.logger.warn("initial terminal prompt scan failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
  }

  public clearTerminalPromptScanTimer(): void {
    if (this.terminalPromptScanTimer) {
      clearInterval(this.terminalPromptScanTimer);
      this.terminalPromptScanTimer = undefined;
    }
  }

  public scheduleTerminalNudgeForInboxMessage(
    sessionId: string,
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): void {
    if (!this.host.config.terminal.nudgeEnabled) {
      return;
    }

    if (!session?.terminalTarget) {
      this.host.logger.debug(
        "terminal nudge scheduling skipped for inbox message",
        {
          sessionId,
          reason: "no_terminal_target",
        },
      );
      return;
    }

    const existingTimer = this.host.terminalNudgeDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.host.terminalNudgeDebounceTimers.delete(sessionId);
      void this.actions
        .nudgeForInboxMessage(sessionId)
        .catch((error) => {
          const payload = {
            sessionId,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          };

          if (isTerminalUnavailableError(error)) {
            void this.host.sessionStore
              .getSession(sessionId)
              .then((currentSession) => {
                if (!currentSession?.terminalTarget) {
                  return;
                }

                return this.actions.notifyUnavailable(
                  sessionId,
                  currentSession,
                  error,
                );
              });
            this.host.logger.warn(
              "terminal nudge skipped because terminal is unavailable",
              payload,
            );
            return;
          }

          this.host.logger.error("terminal nudge failed", payload);
        });
    }, this.host.config.terminal.nudgeDebounceSeconds * 1000);
    timer.unref();
    this.host.terminalNudgeDebounceTimers.set(sessionId, timer);

    this.host.logger.info("terminal nudge scheduled for inbox message", {
      sessionId,
      terminalTarget: session.terminalTarget,
      debounceSeconds: this.host.config.terminal.nudgeDebounceSeconds,
    });
  }

  public async sendTypingForSession(sessionId: string): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      this.host.logger.debug(
        "Telegram typing skipped because transport is disabled",
        {
          sessionId,
        },
      );
      return;
    }

    const binding = await this.host.bindingStore.getBinding(sessionId);
    if (!binding) {
      this.host.logger.debug(
        "Telegram typing skipped because session is unbound",
        {
          sessionId,
        },
      );
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

  private async runTerminalPromptScanCycle(): Promise<void> {
    if (!this.host.config.terminal.promptScanEnabled) {
      this.host.logger.debug("terminal prompt scan cycle skipped", {
        skipReason: "disabled",
      });
      return;
    }

    if (this.terminalPromptScanInFlight) {
      this.host.logger.debug("terminal prompt scan cycle skipped", {
        skipReason: "in_flight",
      });
      return;
    }

    this.terminalPromptScanInFlight = true;
    try {
      if (this.host.ensureGatewayScopedConsolesBoundForPrincipal) {
        const principals = await this.host.bindingStore.listBoundPrincipals();
        this.host.logger.debug("terminal prompt scan syncing bound gateway principals", {
          principalCount: principals.length,
        });
        for (const principal of principals) {
          await this.host.ensureGatewayScopedConsolesBoundForPrincipal(principal);
        }
      }

      const sessions = await this.host.sessionStore.listSessions();
      this.host.logger.debug("terminal prompt scan cycle started", {
        sessionCount: sessions.length,
      });
      if (sessions.length === 0) {
        this.host.logger.debug("terminal prompt scan cycle found no sessions");
        return;
      }
      for (const session of sessions) {
        await this.actions.scanPromptForSession(session);
      }
      this.host.logger.debug("terminal prompt scan cycle completed", {
        sessionCount: sessions.length,
      });
    } finally {
      this.terminalPromptScanInFlight = false;
    }
  }
}
