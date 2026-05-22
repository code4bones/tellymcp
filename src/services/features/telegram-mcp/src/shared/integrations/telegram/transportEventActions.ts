import { InlineKeyboard } from "grammy";

import type { WebAppLaunchRegistry } from "../../../app/webapp/auth";
import { buildLiveRelaySessionId } from "../../../app/webapp/relay";
import type { TelegramInboxMessage } from "../../../entities/inbox/model/types";
import type { AppConfig } from "../../../app/config/env";
import type { SessionBindingStore, SessionStore, TelegramInboxStore } from "../../api/storage/contract";
import { createInboxMessageId } from "../../lib/ids/ids";
import type { Logger } from "../../lib/logger/logger";
import { writeTellySessionRuntimeState } from "../../lib/project-identity/projectIdentity";
import type { SupportedLocale } from "../../i18n";
import type { LiveApprovalEventPayload, SendMessageMeta, TelegramSendMessageOptions } from "./transportTypes";

export interface TransportEventActionsHost {
  logger: Logger;
  config: AppConfig;
  sessionStore: SessionStore;
  inboxStore: TelegramInboxStore;
  bindingStore: SessionBindingStore;
  webAppLaunchRegistry: WebAppLaunchRegistry;
  createLiveApprovalMenuPayload(input: {
    sessionId: string;
    sourceSessionId: string;
    sourceSessionLabel: string;
    sourceClientUuid: string;
    sourceLocalSessionId: string;
    targetSessionId: string;
    targetSessionLabel: string;
    targetClientUuid: string;
    targetLocalSessionId: string;
    projectUuid?: string;
    projectName?: string;
  }): Promise<string>;
  nudgeSessionInbox(sessionId: string): Promise<void>;
  sendNotification(input: {
    sessionId: string;
    sessionLabel?: string;
    recipient: { telegramChatId: number; telegramUserId: number };
    message: string;
  }): Promise<{ externalMessageId?: string | number }>;
  resolveLocaleForTelegramUserId(
    telegramUserId: number,
    telegramLanguageCode?: string | null,
  ): Promise<SupportedLocale>;
  t(locale: SupportedLocale, key: string, options?: Record<string, unknown>): string;
  tForTelegramUserId(
    telegramUserId: number,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  sendChatMessage(
    telegramChatId: number,
    text: string,
    options: TelegramSendMessageOptions,
    meta: SendMessageMeta,
  ): Promise<{ message_id: number }>;
  buildLiveViewUrl(input: {
    targetSessionId: string;
    targetClientUuid?: string;
    targetLocalSessionId?: string;
    sourceClientUuid?: string;
    launchMode?: "default" | "expand" | "fullscreen";
  }): string | null;
  buildLiveViewKeyboard(
    buildUrlForMode: (
      mode: "default" | "expand" | "fullscreen",
    ) => string | null,
    locale: SupportedLocale,
  ): InlineKeyboard;
}

export class TransportEventActions {
  public constructor(private readonly host: TransportEventActionsHost) {}

  public async handleToolsUpdatedEvent(input: {
    local_session_id: string;
    session_label?: string;
    client_tools_hash?: string;
    gateway_tools_hash: string;
    reason: "missing" | "outdated";
    instruction: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.local_session_id);
    if (!session) {
      this.host.logger.warn("Skipping tools update event because local session is unavailable", {
        sessionId: input.local_session_id,
        reason: input.reason,
      });
      return;
    }

    this.host.logger.info("TOOLS.md update event received for console", {
      sessionId: session.sessionId,
      sessionLabel: session.label ?? input.session_label ?? session.sessionId,
      reason: input.reason,
      gatewayToolsHash: input.gateway_tools_hash,
      clientToolsHash: input.client_tools_hash,
    });

    const binding = await this.host.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      return;
    }

    await this.host.sendNotification({
      sessionId: session.sessionId,
      ...(session.label ? { sessionLabel: session.label } : {}),
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.changed",
        ),
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.session",
          {
            sessionName: session.label ?? input.session_label ?? session.sessionId,
          },
        ),
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.tools.action_required",
        ),
      ].join("\n"),
    });

    await this.host.sessionStore.setSession({
      ...session,
      lastNotifiedToolsHash: input.gateway_tools_hash,
      updatedAt: new Date().toISOString(),
    });
    if (session.cwd?.trim()) {
      writeTellySessionRuntimeState({
        cwd: session.cwd,
        sessionId: session.sessionId,
        lastSeenToolsHash: session.lastSeenToolsHash,
        lastNotifiedToolsHash: input.gateway_tools_hash,
        logger: this.host.logger,
      });
    }
  }

  public async handleGatewayVersionCompatibilityEvent(input: {
    local_session_id: string;
    session_label?: string;
    compatibility: "warn" | "reject";
    gateway_package_version: string;
    gateway_protocol_version: string;
    gateway_capabilities: string[];
    client_package_version: string;
    client_protocol_version: string;
    client_capabilities: string[];
    reasons: string[];
    instruction: string;
  }): Promise<void> {
    const session = await this.host.sessionStore.getSession(input.local_session_id);
    if (!session) {
      this.host.logger.warn(
        "Skipping gateway version compatibility event because local session is unavailable",
        {
          sessionId: input.local_session_id,
          compatibility: input.compatibility,
        },
      );
      return;
    }

    const title =
      input.compatibility === "reject"
        ? "Gateway/client protocol mismatch blocks transport."
        : "Gateway/client version mismatch detected.";
    const inboxMessage: TelegramInboxMessage = {
      id: createInboxMessageId(),
      sessionId: session.sessionId,
      telegramChatId: 0,
      telegramUserId: 0,
      sourceTelegramMessageId: 0,
      text: [
        title,
        `Session: ${session.label ?? input.session_label ?? session.sessionId}`,
        `Compatibility: ${input.compatibility}`,
        `Client package: ${input.client_package_version}`,
        `Client protocol: ${input.client_protocol_version}`,
        `Gateway package: ${input.gateway_package_version}`,
        `Gateway protocol: ${input.gateway_protocol_version}`,
        `Client capabilities: ${input.client_capabilities.join(", ") || "none"}`,
        `Gateway capabilities: ${input.gateway_capabilities.join(", ") || "none"}`,
        ...(input.reasons.length > 0
          ? ["", "# Reasons", ...input.reasons.map((reason) => `- ${reason}`)]
          : []),
        "",
        "# Action Required",
        input.instruction,
        ...(input.compatibility === "reject"
          ? [
              "Do not continue collaboration, delivery, or live relay work until this client is upgraded.",
            ]
          : [
              "Upgrade the older side soon and verify the updated TOOLS.md before continuing sensitive work.",
            ]),
      ].join("\n"),
      receivedAt: new Date().toISOString(),
    };

    await this.host.inboxStore.createInboxMessage(inboxMessage);
    await this.host.nudgeSessionInbox(session.sessionId);

    const binding = await this.host.bindingStore.getBinding(session.sessionId);
    if (!binding) {
      return;
    }

    await this.host.sendNotification({
      sessionId: session.sessionId,
      ...(session.label ? { sessionLabel: session.label } : {}),
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: [
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          input.compatibility === "reject"
            ? "menu:notices.version.reject"
            : "menu:notices.version.warn",
        ),
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.session",
          {
            sessionName: session.label ?? input.session_label ?? session.sessionId,
          },
        ),
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.client",
          {
            packageVersion: input.client_package_version,
            protocolVersion: input.client_protocol_version,
          },
        ),
        await this.host.tForTelegramUserId(
          binding.telegramUserId,
          "menu:notices.version.gateway",
          {
            packageVersion: input.gateway_package_version,
            protocolVersion: input.gateway_protocol_version,
          },
        ),
        input.instruction,
      ].join("\n"),
    });
  }

  public async handleLiveViewApprovalRequestEvent(
    input: LiveApprovalEventPayload,
  ): Promise<void> {
    const targetSession =
      (await this.host.sessionStore.getSession(input.target_local_session_id)) ??
      (await this.host.sessionStore.getSession(
        buildLiveRelaySessionId(
          input.target_client_uuid,
          input.target_local_session_id,
        ),
      ));
    if (!targetSession) {
      this.host.logger.warn("Skipping live approval request because target session is unavailable", {
        targetLocalSessionId: input.target_local_session_id,
        sourceLocalSessionId: input.source_local_session_id,
      });
      return;
    }

    const binding = await this.host.bindingStore.getBinding(targetSession.sessionId);
    if (!binding) {
      this.host.logger.warn("Skipping live approval request because target session has no active Telegram route", {
        sessionId: targetSession.sessionId,
        sourceLocalSessionId: input.source_local_session_id,
      });
      return;
    }
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    const payloadKey = await this.host.createLiveApprovalMenuPayload({
      sessionId: targetSession.sessionId,
      sourceSessionId: input.source_session_id,
      sourceSessionLabel: input.source_session_label,
      sourceClientUuid: input.source_client_uuid,
      sourceLocalSessionId: input.source_local_session_id,
      targetSessionId: input.target_session_id,
      targetSessionLabel: input.target_session_label,
      targetClientUuid: input.target_client_uuid,
      targetLocalSessionId: input.target_local_session_id,
      ...(input.project_uuid ? { projectUuid: input.project_uuid } : {}),
      ...(input.project_name ? { projectName: input.project_name } : {}),
    });

    const sent = await this.host.sendChatMessage(
      binding.telegramChatId,
      [
        this.host.t(locale, "menu:live.approval.request_title"),
        "",
        ...(input.project_name
          ? [
              this.host.t(locale, "menu:live.approval.project", {
                projectName: input.project_name,
              }),
            ]
          : []),
        this.host.t(locale, "menu:live.approval.route", {
          sourceSessionName: input.source_session_label,
          targetSessionName: input.target_session_label,
        }),
        "",
        this.host.t(locale, "menu:live.approval.request_message", {
          sourceSessionName: input.source_session_label,
        }),
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text(`✅ ${this.host.t(locale, "menu:live.approval.approve")}`, `live-approval:approve:${payloadKey}`)
          .text(`❌ ${this.host.t(locale, "menu:live.approval.deny")}`, `live-approval:deny:${payloadKey}`),
      },
      {
        kind: "notification",
        sessionId: targetSession.sessionId,
      },
    );

    this.host.logger.info("Telegram live approval request delivered", {
      sessionId: targetSession.sessionId,
      telegramChatId: binding.telegramChatId,
      telegramUserId: binding.telegramUserId,
      messageId: sent.message_id,
      sourceLocalSessionId: input.source_local_session_id,
    });
  }

  public async handleLiveViewApprovalResolvedEvent(
    input: LiveApprovalEventPayload & { approved: boolean },
  ): Promise<void> {
    const sourceSession =
      (await this.host.sessionStore.getSession(input.source_local_session_id)) ??
      (await this.host.sessionStore.getSession(
        buildLiveRelaySessionId(
          input.source_client_uuid,
          input.source_local_session_id,
        ),
      ));
    if (!sourceSession) {
      this.host.logger.warn("Skipping live approval resolution because source session is unavailable", {
        sourceLocalSessionId: input.source_local_session_id,
        targetLocalSessionId: input.target_local_session_id,
      });
      return;
    }

    const binding = await this.host.bindingStore.getBinding(sourceSession.sessionId);
    if (!binding) {
      this.host.logger.warn("Skipping live approval resolution because source session has no active Telegram route", {
        sessionId: sourceSession.sessionId,
        targetLocalSessionId: input.target_local_session_id,
      });
      return;
    }
    const locale = await this.host.resolveLocaleForTelegramUserId(
      binding.telegramUserId,
    );

    if (!input.approved) {
      await this.host.sendNotification({
        sessionId: sourceSession.sessionId,
        ...(sourceSession.label ? { sessionLabel: sourceSession.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: [
          this.host.t(locale, "menu:live.approval.denied"),
          ...(input.project_name
            ? [
                this.host.t(locale, "menu:live.approval.project", {
                  projectName: input.project_name,
                }),
              ]
            : []),
          this.host.t(locale, "menu:live.approval.route", {
            sourceSessionName: input.source_session_label,
            targetSessionName: input.target_session_label,
          }),
        ].join("\n"),
      });
      return;
    }

    const liveViewUrl = this.host.buildLiveViewUrl({
      targetSessionId: input.target_session_id,
      targetClientUuid: input.target_client_uuid,
      targetLocalSessionId: input.target_local_session_id,
    });
    if (!liveViewUrl) {
      throw new Error("Unable to build Live View URL for approved request.");
    }

    const sent = await this.host.sendChatMessage(
      binding.telegramChatId,
      [
        this.host.t(locale, "menu:live.approval.approved"),
        "",
        ...(input.project_name
          ? [
              this.host.t(locale, "menu:live.approval.project", {
                projectName: input.project_name,
              }),
            ]
          : []),
        this.host.t(locale, "menu:live.approval.route", {
          sourceSessionName: input.source_session_label,
          targetSessionName: input.target_session_label,
        }),
        "",
        this.host.t(locale, "menu:live.actions.choose_mode"),
      ].join("\n"),
      {
        reply_markup: this.host.buildLiveViewKeyboard(
          (mode) =>
            this.host.buildLiveViewUrl({
              targetSessionId: input.target_session_id,
              targetClientUuid: input.target_client_uuid,
              targetLocalSessionId: input.target_local_session_id,
              launchMode: mode,
            }),
          locale,
        ),
      },
      {
        kind: "notification",
        sessionId: sourceSession.sessionId,
      },
    );

    this.host.webAppLaunchRegistry.set(
      binding.telegramUserId,
      sourceSession.sessionId,
      this.host.config.webapp.initDataTtlSeconds,
      {
        telegramChatId: binding.telegramChatId,
        telegramMessageId: sent.message_id,
      },
    );
  }
}
