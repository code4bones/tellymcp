import type { SessionBindingStore, SessionStore } from "../../api/storage/contract";
import type { SupportedLocale } from "../../i18n";
import type { HumanTransportNotification } from "../../api/transport/contract";

export interface TransportProjectEventsHost {
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  resolveLocaleForTelegramUserId(
    telegramUserId?: number,
    telegramLanguageCode?: string | null | undefined,
  ): Promise<SupportedLocale>;
  t(
    locale: SupportedLocale,
    key: string,
    options?: Record<string, unknown>,
  ): string;
  sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }>;
}

export class TransportProjectEvents {
  public constructor(private readonly host: TransportProjectEventsHost) {}

  public async handleProjectMemberJoinedEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.host.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.host.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.host.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.host.t(locale, "menu:notices.project.new_member");

      await this.host.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.host.t(locale, "menu:notices.project.member_joined", {
          projectName: input.project_name,
          memberLabel,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectMemberLeftEvent(input: {
    project_uuid: string;
    project_name: string;
    member_display_name?: string;
    member_telegram_username?: string;
  }): Promise<void> {
    const rawMemberLabel =
      input.member_display_name?.trim() ||
      (input.member_telegram_username?.trim()
        ? `@${input.member_telegram_username.trim().replace(/^@/u, "")}`
        : null);

    const sessions = await this.host.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      const binding = await this.host.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.host.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );
      const memberLabel =
        rawMemberLabel ?? this.host.t(locale, "menu:notices.project.member");

      await this.host.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.host.t(locale, "menu:notices.project.member_left", {
          projectName: input.project_name,
          memberLabel,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }

  public async handleProjectDeletedEvent(input: {
    project_uuid: string;
    project_name: string;
  }): Promise<void> {
    const sessions = await this.host.sessionStore.listSessions();
    const notifiedChats = new Set<number>();

    for (const session of sessions) {
      if (session.activeProjectUuid === input.project_uuid) {
        await this.host.sessionStore.setSession({
          ...session,
          activeProjectUuid: undefined,
          activeProjectName: undefined,
          updatedAt: new Date().toISOString(),
        });
      }

      const binding = await this.host.bindingStore.getBinding(session.sessionId);
      if (!binding || notifiedChats.has(binding.telegramChatId)) {
        continue;
      }
      const locale = await this.host.resolveLocaleForTelegramUserId(
        binding.telegramUserId,
      );

      await this.host.sendNotification({
        sessionId: session.sessionId,
        ...(session.label ? { sessionLabel: session.label } : {}),
        recipient: {
          telegramChatId: binding.telegramChatId,
          telegramUserId: binding.telegramUserId,
        },
        message: this.host.t(locale, "menu:notices.project.deleted", {
          projectName: input.project_name,
        }),
      });
      notifiedChats.add(binding.telegramChatId);
    }
  }
}
