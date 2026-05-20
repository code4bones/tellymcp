import { describe, expect, it, vi } from "vitest";

import { TelegramTransport } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transport";

type MockFn = ReturnType<typeof vi.fn>;

type TransportHarness = TelegramTransport & {
  pendingPartnerNotes: Map<string, unknown>;
  sessionStore: {
    getSession: MockFn;
  };
  inboxStore: {
    createInboxMessage: MockFn;
  };
  maintenanceStore: {
    setOutgoingDeliveryNotice: MockFn;
  };
  getPrincipalFromContext: MockFn;
  getProjectMemberPayloadByKey: MockFn;
  beginPartnerNoteMode: MockFn;
  deletePendingPartnerNotePrompt: MockFn;
  replyText: MockFn;
  sendPartnerNote: MockFn;
  enqueuePartnerNoteInstruction: MockFn;
  nudgeSessionInbox: MockFn;
  ensureProjectSessionRegistered: MockFn;
  handleProjectMemberNoteCallback: (
    ctx: CallbackContext,
  ) => Promise<void>;
  handlePendingPartnerNote: (
    ctx: MessageContext,
    text: string,
  ) => Promise<boolean>;
  __enqueuePartnerNoteInstruction: (
    input: {
      principal: { telegramChatId: number; telegramUserId: number };
      sessionId: string;
      sourceTelegramMessageId: number;
      kind: "share" | "question" | "reply" | "request" | "handoff";
      summary: string;
      message: string;
      targetSessionId?: string;
      targetSessionLabel?: string;
      projectUuid?: string;
    },
  ) => Promise<void>;
};

type CallbackContext = {
  callbackQuery: {
    data: string;
  };
  answerCallbackQuery: MockFn;
  deleteMessage: MockFn;
  chat: { id: number };
  message: { message_id: number };
};

type MessageContext = {
  chat: { id: number };
  message: { message_id: number };
};

function createTransportHarness(): TransportHarness {
  const transport = Object.create(TelegramTransport.prototype) as unknown as TransportHarness;
  transport.pendingPartnerNotes = new Map();
  transport.sessionStore = {
    getSession: vi.fn(),
  };
  transport.inboxStore = {
    createInboxMessage: vi.fn(async () => undefined),
  };
  transport.maintenanceStore = {
    setOutgoingDeliveryNotice: vi.fn(),
  };
  transport.getPrincipalFromContext = vi.fn();
  transport.getProjectMemberPayloadByKey = vi.fn();
  transport.beginPartnerNoteMode = vi.fn();
  transport.deletePendingPartnerNotePrompt = vi.fn(async () => undefined);
  transport.replyText = vi.fn(async () => ({ message_id: 777 }));
  transport.sendPartnerNote = vi.fn();
  transport.enqueuePartnerNoteInstruction = vi.fn(async () => undefined);
  transport.nudgeSessionInbox = vi.fn(async () => undefined);
  transport.ensureProjectSessionRegistered = vi.fn(async () => undefined);
  transport.__enqueuePartnerNoteInstruction =
    TelegramTransport.prototype["enqueuePartnerNoteInstruction"].bind(transport) as TransportHarness["__enqueuePartnerNoteInstruction"];
  return transport;
}

function createCallbackContext(data: string): CallbackContext {
  return {
    callbackQuery: {
      data,
    },
    answerCallbackQuery: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    chat: { id: 171197806 },
    from: { id: 171197806, language_code: "ru" },
    message: { message_id: 1157 },
  };
}

describe("TelegramTransport collaboration flows", () => {
  it("deletes stale project-member note message", async () => {
    const transport = createTransportHarness();
    transport.getProjectMemberPayloadByKey.mockResolvedValue(null);
    const ctx = createCallbackContext("project-member-note:question:stale-key");

    await transport.handleProjectMemberNoteCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Данные участника проекта некорректны или устарели.",
      show_alert: true,
    });
    expect(ctx.deleteMessage).toHaveBeenCalled();
    expect(transport.beginPartnerNoteMode).not.toHaveBeenCalled();
  });

  it("routes project Ask through sendPartnerNote and stores outgoing notice", async () => {
    const transport = createTransportHarness();
    const principal = { telegramChatId: 171197806, telegramUserId: 171197806 };
    transport.getPrincipalFromContext.mockReturnValue(principal);
    transport.sessionStore.getSession.mockResolvedValue({
      sessionId: "left-session",
      label: "leftDev",
    });
    transport.sendPartnerNote.mockResolvedValue({
      session_id: "left-session",
      partner_session_id: "target-session",
      project_name: "Project One",
      target_actor_label: "Backend User",
      target_session_label: "backend",
      kind: "question",
      share_id: "share-1",
      delivery_status: "queued",
      note_path: "gateway://shares/share-1.md",
      xchange_record_id: "share-1",
      copied_artifacts: [],
      inbox_message_id: "delivery-1",
      requires_reply: true,
    });

    transport.pendingPartnerNotes.set("171197806:171197806", {
      sessionId: "left-session",
      kind: "question",
      initiatedAt: "2026-05-16T00:00:00.000Z",
      targetSessionId: "target-session",
      targetSessionLabel: "backend",
      projectUuid: "project-1",
    });

    const ctx: MessageContext = {
      chat: { id: 171197806 },
      message: { message_id: 1157 },
    };

    const handled = await transport.handlePendingPartnerNote(
      ctx,
      "Кратко\n\nОпиши REST API",
    );

    expect(handled).toBe(true);
    expect(transport.ensureProjectSessionRegistered).toHaveBeenCalledWith({
      principal,
      sessionId: "left-session",
      projectUuid: "project-1",
    });
    expect(transport.sendPartnerNote).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "left-session",
        target_session_id: "target-session",
        project_uuid: "project-1",
        kind: "question",
        summary: "Кратко",
        requires_reply: true,
      }),
    );
    expect(transport.enqueuePartnerNoteInstruction).not.toHaveBeenCalled();
    expect(transport.maintenanceStore.setOutgoingDeliveryNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryUuid: "delivery-1",
        sessionId: "left-session",
        shareId: "share-1",
      }),
    );
  });

  it("routes project Share into current session inbox instruction", async () => {
    const transport = createTransportHarness();
    const principal = { telegramChatId: 171197806, telegramUserId: 171197806 };
    transport.getPrincipalFromContext.mockReturnValue(principal);
    transport.sessionStore.getSession.mockResolvedValue({
      sessionId: "left-session",
      label: "leftDev",
    });

    transport.pendingPartnerNotes.set("171197806:171197806", {
      sessionId: "left-session",
      kind: "share",
      initiatedAt: "2026-05-16T00:00:00.000Z",
      targetSessionId: "target-session",
      targetSessionLabel: "backend",
      projectUuid: "project-1",
    });

    const ctx: MessageContext = {
      chat: { id: 171197806 },
      message: { message_id: 1157 },
    };

    const handled = await transport.handlePendingPartnerNote(
      ctx,
      "Сводка\n\nОтправь описание REST",
    );

    expect(handled).toBe(true);
    expect(transport.sendPartnerNote).not.toHaveBeenCalled();
    expect(transport.enqueuePartnerNoteInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        sessionId: "left-session",
        kind: "share",
        summary: "Сводка",
        message: "Отправь описание REST",
        targetSessionId: "target-session",
        targetSessionLabel: "backend",
        projectUuid: "project-1",
      }),
    );
  });

  it("writes explicit send_partner_file guidance into Share inbox instruction", async () => {
    const transport = createTransportHarness();
    transport.sessionStore.getSession.mockResolvedValue({
      sessionId: "left-session",
      label: "leftDev",
    });

    await transport.__enqueuePartnerNoteInstruction({
      principal: { telegramChatId: 171197806, telegramUserId: 171197806 },
      sessionId: "left-session",
      sourceTelegramMessageId: 1157,
      kind: "share",
      summary: "Отправь файл sample.txt",
      message: "Передай sample.txt в другую сессию",
      targetSessionId: "target-session",
      targetSessionLabel: "backend",
      projectUuid: "project-1",
    });

    expect(transport.inboxStore.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Не пересылай это как новую задачу в target-сессию.",
        ),
      }),
    );
    expect(transport.inboxStore.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Сначала выполни работу в текущей сессии сам.",
        ),
      }),
    );
    expect(transport.inboxStore.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Через send_partner_note или send_partner_file отправляй только результат, а не исходное поручение.",
        ),
      }),
    );
    expect(transport.inboxStore.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Найди файл в локальном workspace и вызови send_partner_file.",
        ),
      }),
    );
    expect(transport.inboxStore.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Не заменяй это на plain send_partner_note с упоминанием имени файла.",
        ),
      }),
    );
    expect(transport.nudgeSessionInbox).toHaveBeenCalledWith("left-session");
  });
});
