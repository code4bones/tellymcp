import type {
  PairCodeRecord,
  SessionBinding,
  TelegramPrincipal,
} from "../../../entities/auth/model/types";
import type {
  TelegramInboxMessage,
  TelegramMenuPayloadRecord,
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type {
  PendingRequestRecord,
  PendingResolution,
} from "../../../entities/request/model/types";
import type { SessionContext } from "../../../entities/session/model/types";

export interface SessionStore {
  getSession(sessionId: string): Promise<SessionContext | null>;
  listSessions(): Promise<SessionContext[]>;
  setSession(session: SessionContext): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

export interface SessionBindingStore {
  createPairCode(record: PairCodeRecord, ttlSeconds: number): Promise<boolean>;
  consumePairCode(code: string): Promise<PairCodeRecord | null>;
  getBinding(sessionId: string): Promise<SessionBinding | null>;
  setBinding(binding: SessionBinding): Promise<void>;
  clearBinding(sessionId: string): Promise<void>;
  getActiveSessionIdForPrincipal(
    principal: TelegramPrincipal,
  ): Promise<string | null>;
  getActiveSessionIdForTelegramUser(
    telegramUserId: number,
  ): Promise<string | null>;
  setActiveSessionIdForPrincipal(
    principal: TelegramPrincipal,
    sessionId: string,
  ): Promise<void>;
  listBoundSessionIdsForPrincipal(
    principal: TelegramPrincipal,
  ): Promise<string[]>;
}

export interface PendingRequestStore {
  resetRuntimeState(): Promise<void>;
  getActive(): Promise<PendingRequestRecord | null>;
  createPending(request: PendingRequestRecord): Promise<void>;
  updatePending(request: PendingRequestRecord): Promise<void>;
  resolvePending(
    requestId: string,
    resolution: PendingResolution,
  ): Promise<void>;
  enqueue(request: PendingRequestRecord): Promise<void>;
  dequeueNext(): Promise<PendingRequestRecord | null>;
}

export interface TelegramInboxStore {
  createInboxMessage(message: TelegramInboxMessage): Promise<void>;
  listInboxMessages(
    sessionId: string,
    limit: number,
  ): Promise<TelegramInboxMessage[]>;
  countInboxMessages(sessionId: string): Promise<number>;
  getInboxMessage(
    sessionId: string,
    messageId: string,
  ): Promise<TelegramInboxMessage | null>;
  deleteInboxMessage(sessionId: string, messageId: string): Promise<boolean>;
}

export interface TelegramMenuPayloadStore {
  createMenuPayload(
    record: TelegramMenuPayloadRecord,
    ttlSeconds: number,
  ): Promise<void>;
  getMenuPayload(key: string): Promise<TelegramMenuPayloadRecord | null>;
}

export interface TelegramXchangeFileMetaStore {
  setXchangeFileMeta(meta: TelegramXchangeFileMeta): Promise<void>;
  listXchangeFileMetas(sessionId: string): Promise<TelegramXchangeFileMeta[]>;
  getXchangeFileMeta(
    sessionId: string,
    filePath: string,
  ): Promise<TelegramXchangeFileMeta | null>;
  deleteXchangeFileMeta(sessionId: string, filePath: string): Promise<boolean>;
}

export interface MaintenanceStore {
  pruneAll(): Promise<{ deletedKeys: number }>;
}
