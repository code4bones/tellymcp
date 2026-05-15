export type TelegramInboxMessage = {
  id: string;
  sessionId: string;
  telegramChatId: number;
  telegramUserId: number;
  sourceTelegramMessageId: number;
  text: string;
  attachments?: string[] | undefined;
  receivedAt: string;
};

export type TelegramXchangeFileMeta = {
  sessionId: string;
  filePath: string;
  relativePath?: string | undefined;
  source: "telegram-upload" | "browser-screenshot" | "partner-artifact";
  sourceTelegramMessageId?: number | undefined;
  uploadedAt: string;
  originalName?: string | undefined;
  caption?: string | undefined;
  storageRef?: string | undefined;
  bucketName?: string | undefined;
  objectName?: string | undefined;
  vfsNodeId?: number | undefined;
  vfsPublicUrl?: string | undefined;
  vfsParentId?: number | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
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
    attachments?: string[];
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
  kind:
    | "inbox-message"
    | "active-session"
    | "file-entry"
    | "link-target"
    | "project-entry"
    | "project-member"
    | "project-file-target"
    | "partner-file-target";
  sessionId: string;
  messageId?: string | undefined;
  filePath?: string | undefined;
  targetSessionId?: string | undefined;
  targetClientUuid?: string | undefined;
  targetLocalSessionId?: string | undefined;
  projectUuid?: string | undefined;
  title?: string | undefined;
  createdAt: string;
  expiresAt: string;
};
