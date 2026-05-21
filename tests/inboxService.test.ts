import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { TelegramInboxMessage } from "../src/services/features/telegram-mcp/src/entities/inbox/model/types";
import type {
  SessionStore,
  TelegramInboxStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { InboxService } from "../src/services/features/telegram-mcp/src/features/inbox/model/inboxService";

describe("InboxService", () => {
  it("returns system inbox messages with telegram_message_id = 0", async () => {
    const message: TelegramInboxMessage = {
      id: "inbox-1",
      sessionId: "session-1",
      telegramChatId: 171197806,
      telegramUserId: 171197806,
      sourceTelegramMessageId: 0,
      text: "Gateway TOOLS.md has changed.",
      receivedAt: "2026-05-16T12:00:00.000Z",
    };

    const service = new InboxService(
      {
        telegram: {
          inboxBatchSize: 20,
        },
      } as AppConfig,
      {
        listInboxMessages: vi
          .fn<TelegramInboxStore["listInboxMessages"]>()
          .mockResolvedValue([message]),
        countInboxMessages: vi
          .fn<TelegramInboxStore["countInboxMessages"]>()
          .mockResolvedValue(1),
      } as unknown as TelegramInboxStore,
      {} as SessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
      {
        resolveSessionDefaults: vi
          .fn<ProjectIdentityResolver["resolveSessionDefaults"]>()
          .mockReturnValue({
            sessionId: "session-1",
            sessionLabel: "leftDev",
            cwd: "/tmp/workspace",
            sessionIdDerived: false,
            sessionLabelDerived: false,
          }),
      } as unknown as ProjectIdentityResolver,
    );

    const output = await service.getInbox({
      session_id: "session-1",
    });

    expect(output).toEqual({
      session_id: "session-1",
      total: 1,
      has_more: false,
      messages: [
        {
          message_id: "inbox-1",
          source: "telegram",
          message_kind: "system",
          telegram_chat_id: 171197806,
          telegram_user_id: 171197806,
          telegram_message_id: 0,
          text: "Gateway TOOLS.md has changed.",
          received_at: "2026-05-16T12:00:00.000Z",
        },
      ],
    });
  });

  it("routes relay inbox requests through remote console invoker", async () => {
    const invokeForRelaySession = vi
      .fn()
      .mockResolvedValue({ session_id: "relay~client~LEFT", total: 7 });

    const service = new InboxService(
      {
        telegram: {
          inboxBatchSize: 20,
        },
      } as AppConfig,
      {
        countInboxMessages: vi.fn(),
      } as unknown as TelegramInboxStore,
      {} as SessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
      {
        resolveSessionDefaults: vi
          .fn<ProjectIdentityResolver["resolveSessionDefaults"]>()
          .mockReturnValue({
            sessionId: "relay~client~LEFT",
            sessionLabel: "LEFT",
            cwd: "/tmp/workspace",
            sessionIdDerived: false,
            sessionLabelDerived: false,
          }),
      } as unknown as ProjectIdentityResolver,
      {
        invokeForRelaySession,
      },
    );

    const output = await service.getInboxCount({
      session_id: "relay~client~LEFT",
    });

    expect(invokeForRelaySession).toHaveBeenCalledWith(
      "relay~client~LEFT",
      "telegramMcp.inbox.getInboxCountRemote",
      {
        session_id: "relay~client~LEFT",
      },
    );
    expect(output).toEqual({
      session_id: "relay~client~LEFT",
      total: 7,
    });
  });
});
