export type TelegramInboxMessage = {
  id: string;
  sessionId: string;
  telegramChatId: number;
  telegramUserId: number;
  sourceTelegramMessageId: number;
  text: string;
  receivedAt: string;
};

export type GetTelegramInboxInput = {
  session_id?: string | undefined;
};

export type GetTelegramInboxOutput = {
  session_id: string;
  total: number;
  has_more: boolean;
  messages: Array<{
    message_id: string;
    source: "telegram";
    telegram_chat_id: number;
    telegram_user_id: number;
    telegram_message_id: number;
    text: string;
    received_at: string;
  }>;
};

export type GetTelegramInboxCountInput = {
  session_id?: string | undefined;
};

export type GetTelegramInboxCountOutput = {
  session_id: string;
  total: number;
};

export type DeleteTelegramInboxMessageInput = {
  session_id?: string | undefined;
  message_id: string;
};

export type DeleteTelegramInboxMessageOutput = {
  deleted: boolean;
  session_id: string;
  message_id: string;
};

export type TelegramMenuPayloadRecord = {
  key: string;
  kind: "inbox-message" | "active-session";
  sessionId: string;
  messageId?: string | undefined;
  createdAt: string;
  expiresAt: string;
};
