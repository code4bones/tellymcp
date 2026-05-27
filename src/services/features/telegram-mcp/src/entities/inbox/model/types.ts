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

export type TelegramMenuPayloadRecord = {
  key: string;
  kind:
    | "inbox-message"
    | "active-session"
    | "session-group"
    | "file-entry"
    | "link-target"
    | "project-entry"
    | "project-delete-entry"
    | "project-member"
    | "live-approval"
    | "terminal-prompt-action"
    | "project-file-target"
    | "partner-file-target";
  sessionId?: string | undefined;
  ownerKey?: string | undefined;
  ownerLabel?: string | undefined;
  messageId?: string | undefined;
  filePath?: string | undefined;
  targetSessionId?: string | undefined;
  sourceSessionId?: string | undefined;
  sourceSessionLabel?: string | undefined;
  sourceClientUuid?: string | undefined;
  sourceLocalSessionId?: string | undefined;
  targetClientUuid?: string | undefined;
  targetLocalSessionId?: string | undefined;
  projectUuid?: string | undefined;
  projectName?: string | undefined;
  title?: string | undefined;
  promptActions?: string[] | undefined;
  createdAt: string;
  expiresAt: string;
};
