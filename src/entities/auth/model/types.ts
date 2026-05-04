export type CreateSessionPairCodeInput = {
  session_id?: string | undefined;
  session_label?: string | undefined;
  expires_in_seconds?: number | undefined;
};

export type CreateSessionPairCodeOutput = {
  session_id: string;
  code: string;
  expires_at: string;
  status: "pending";
  status_message: string;
  telegram_link_hint?: string | undefined;
};

export type ClearSessionPairingInput = {
  session_id?: string | undefined;
};

export type ClearSessionPairingOutput = {
  cleared: boolean;
  session_id: string;
};

export type PairCodeRecord = {
  code: string;
  sessionId: string;
  sessionLabel?: string | undefined;
  createdAt: string;
  expiresAt: string;
};

export type SessionBinding = {
  sessionId: string;
  telegramChatId: number;
  telegramUserId: number;
  linkedAt: string;
};

export type TelegramPrincipal = {
  telegramChatId: number;
  telegramUserId: number;
};
