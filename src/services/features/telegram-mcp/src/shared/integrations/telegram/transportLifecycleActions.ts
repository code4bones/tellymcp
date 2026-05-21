import {
  TELLYMCP_PACKAGE_NAME,
  TELLYMCP_PROTOCOL_VERSION,
  detectAvailablePackageUpdate,
  getTellyMcpPackageVersion,
} from "../../lib/version/versionHandshake";
import { isTmuxUnavailableError } from "../tmux/client";
import { joinHttpPath, normalizeBasePath } from "./transportUtils";
import type { AppConfig } from "../../../app/config/env";
import type { SessionBindingStore, SessionStore, TelegramInboxStore } from "../../api/storage/contract";
import type { Logger } from "../../lib/logger/logger";
import type { SupportedLocale } from "../../i18n";

export interface TransportLifecycleActionsHost {
  logger: Logger;
  config: AppConfig;
  sessionStore: SessionStore;
  inboxStore: TelegramInboxStore;
  bindingStore: SessionBindingStore;
  isTelegramEnabled(): boolean;
  nudgeSessionInbox(sessionId: string): Promise<void>;
  resolveLocaleForTelegramUserId(
    telegramUserId: number,
    telegramLanguageCode?: string | null,
  ): Promise<SupportedLocale>;
  t(locale: SupportedLocale, key: string, options?: Record<string, unknown>): string;
  sendNotification(input: {
    sessionId: string;
    sessionLabel?: string;
    recipient: { telegramChatId: number; telegramUserId: number };
    message: string;
  }): Promise<{ externalMessageId?: string | number }>;
}

export class TransportLifecycleActions {
  public constructor(private readonly host: TransportLifecycleActionsHost) {}

  public async recoverPendingInboxNudges(): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      this.host.logger.debug(
        "Startup inbox nudge recovery skipped because Telegram transport is disabled",
      );
      return;
    }

    if (!this.host.config.tmux.nudgeEnabled) {
      this.host.logger.debug(
        "Startup inbox nudge recovery skipped because tmux nudging is disabled",
      );
      return;
    }

    const sessions = await this.host.sessionStore.listSessions();
    let recoveredCount = 0;

    for (const session of sessions) {
      if (!session.tmuxTarget) {
        continue;
      }

      const inboxCount = await this.host.inboxStore.countInboxMessages(
        session.sessionId,
      );
      if (inboxCount === 0) {
        continue;
      }

      recoveredCount += 1;
      try {
        await this.host.nudgeSessionInbox(session.sessionId);
      } catch (error) {
        const payload = {
          sessionId: session.sessionId,
          tmuxTarget: session.tmuxTarget,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };

        if (isTmuxUnavailableError(error)) {
          this.host.logger.warn(
            "Startup inbox nudge recovery skipped because tmux is unavailable",
            payload,
          );
          continue;
        }

        this.host.logger.error("Startup inbox nudge recovery failed", payload);
      }
    }

    this.host.logger.info("Startup inbox nudge recovery finished", {
      scannedSessions: sessions.length,
      recoveredSessions: recoveredCount,
    });
  }

  public async sendStartupNotifications(runtimeDirname: string): Promise<void> {
    if (!this.host.isTelegramEnabled()) {
      this.host.logger.debug(
        "Startup notifications skipped because Telegram transport is disabled",
      );
      return;
    }

    const packageVersion = getTellyMcpPackageVersion(runtimeDirname);
    const availableUpdate = await detectAvailablePackageUpdate({
      currentVersion: packageVersion,
    });
    if (availableUpdate) {
      this.host.logger.warn("A newer TellyMCP package version is available", {
        currentVersion: availableUpdate.currentVersion,
        latestVersion: availableUpdate.latestVersion,
        packageName: TELLYMCP_PACKAGE_NAME,
      });
    }
    const sessions = await this.host.sessionStore.listSessions();
    const groupedRecipients = new Map<
      string,
      {
        binding: { telegramChatId: number; telegramUserId: number };
        sessionIds: string[];
        sessionLabels: string[];
      }
    >();

    for (const session of sessions) {
      const binding = await this.host.bindingStore.getBinding(session.sessionId);
      if (!binding) {
        continue;
      }

      const key = `${binding.telegramChatId}:${binding.telegramUserId}`;
      const current = groupedRecipients.get(key);
      if (current) {
        current.sessionIds.push(session.sessionId);
        current.sessionLabels.push(session.label ?? session.sessionId);
        continue;
      }

      groupedRecipients.set(key, {
        binding: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        sessionIds: [session.sessionId],
        sessionLabels: [session.label ?? session.sessionId],
      });
    }

    if (groupedRecipients.size === 0) {
      this.host.logger.info("Skipping startup notifications because no sessions have an active Telegram route");
      return;
    }

    const runtimePort =
      this.host.config.distributed.mode === "gateway" ||
      this.host.config.distributed.mode === "both"
        ? Number(process.env.PORT || this.host.config.mcp.httpPort)
        : this.host.config.mcp.httpPort;
    const rootPrefix =
      this.host.config.distributed.mode === "gateway" ||
      this.host.config.distributed.mode === "both"
        ? normalizeBasePath(process.env.ROOT_PREFIX || "/api")
        : "";
    const localMcpPath =
      this.host.config.distributed.mode === "gateway" ||
      this.host.config.distributed.mode === "both"
        ? joinHttpPath(rootPrefix, this.host.config.mcp.httpPath)
        : this.host.config.mcp.httpPath;
    const localWebappPath =
      this.host.config.distributed.mode === "gateway" ||
      this.host.config.distributed.mode === "both"
        ? joinHttpPath(rootPrefix, this.host.config.webapp.basePath)
        : this.host.config.webapp.basePath;
    const localMcpUrl = `http://${this.host.config.mcp.httpHost}:${runtimePort}${localMcpPath}`;
    const localWebappUrl = `http://${this.host.config.mcp.httpHost}:${runtimePort}${localWebappPath}`;

    for (const recipientGroup of groupedRecipients.values()) {
      const primarySessionId = recipientGroup.sessionIds[0];
      if (!primarySessionId) {
        continue;
      }
      const locale = await this.host.resolveLocaleForTelegramUserId(
        recipientGroup.binding.telegramUserId,
      );
      const uniqueSessionLabels = Array.from(new Set(recipientGroup.sessionLabels)).sort();
      const browserStatus = this.host.config.browser.enabled
        ? (this.host.config.browser.headless ? "enabled, headless" : "enabled, headed")
        : "disabled";
      const startupMessage = [
        this.host.t(locale, "menu:notices.startup.title"),
        this.host.t(locale, "menu:notices.startup.version", {
          packageVersion,
        }),
        this.host.t(locale, "menu:notices.startup.protocol", {
          protocolVersion: TELLYMCP_PROTOCOL_VERSION,
        }),
        this.host.t(locale, "menu:notices.startup.mode", {
          mode: this.host.config.distributed.mode,
        }),
        ...(this.host.config.telegram.botUsername
          ? [
              this.host.t(locale, "menu:notices.startup.bot", {
                botUsername: this.host.config.telegram.botUsername.replace(/^@/u, ""),
              }),
            ]
          : []),
        this.host.t(locale, "menu:notices.startup.sessions", {
          count: uniqueSessionLabels.length,
        }),
        this.host.t(locale, "menu:notices.startup.session_list", {
          sessions: uniqueSessionLabels.join(", "),
        }),
        this.host.t(locale, "menu:notices.startup.mcp", {
          url: localMcpUrl,
        }),
        ...(this.host.config.webapp.enabled
          ? [this.host.t(locale, "menu:notices.startup.webapp", { url: localWebappUrl })]
          : []),
        ...(this.host.config.distributed.gatewayPublicUrl
          ? [
              this.host.t(locale, "menu:notices.startup.gateway", {
                url: this.host.config.distributed.gatewayPublicUrl,
              }),
            ]
          : []),
        ...(this.host.config.distributed.gatewayWsUrl
          ? [
              this.host.t(locale, "menu:notices.startup.gateway_ws", {
                url: this.host.config.distributed.gatewayWsUrl,
              }),
            ]
          : []),
        this.host.t(locale, "menu:notices.startup.browser", {
          status: browserStatus,
        }),
        ...(availableUpdate
          ? [
              this.host.t(locale, "menu:notices.startup.update_available", {
                currentVersion: availableUpdate.currentVersion,
                latestVersion: availableUpdate.latestVersion,
              }),
              this.host.t(locale, "menu:notices.startup.update_command", {
                packageName: TELLYMCP_PACKAGE_NAME,
                latestVersion: availableUpdate.latestVersion,
              }),
            ]
          : []),
        this.host.t(locale, "menu:notices.startup.hint"),
      ].join("\n");

      try {
        await this.host.sendNotification({
          sessionId: primarySessionId,
          sessionLabel: "TellyMCP",
          recipient: recipientGroup.binding,
          message: startupMessage,
        });
      } catch (error) {
        this.host.logger.warn("Failed to deliver Telegram startup notification", {
          telegramChatId: recipientGroup.binding.telegramChatId,
          telegramUserId: recipientGroup.binding.telegramUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
