export type PairCodeRecord = {
  code: string;
  sessionId: string;
  sessionLabel?: string | undefined;
  targetClientUuid?: string | undefined;
  targetLocalSessionId?: string | undefined;
  createdAt: string;
  expiresAt: string;
};

export type SessionBinding = {
  sessionId: string;
  telegramChatId: number;
  telegramUserId: number;
  telegramUsername?: string | undefined;
  linkedAt: string;
};

export type TelegramPrincipal = {
  telegramChatId: number;
  telegramUserId: number;
};
