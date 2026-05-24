import type {
  PairCodeRecord,
  SessionBinding,
  TelegramPrincipal,
} from "../../../entities/auth/model/types";
import type {
  TelegramMenuPayloadRecord,
  TelegramXchangeFileMeta,
} from "../../../entities/inbox/model/types";
import type {
  PendingRequestRecord,
  PendingResolution,
} from "../../../entities/request/model/types";
import type { SessionContext } from "../../../entities/session/model/types";

export type OutgoingDeliveryNotice = {
  deliveryUuid: string;
  sessionId: string;
  telegramChatId: number;
  telegramMessageId: number;
  shareId: string;
  kind: string;
  summary: string;
  projectName?: string | undefined;
  targetLabel?: string | undefined;
  targetSessionLabel?: string | undefined;
};

export type ProjectMenuViewState = {
  sessionId: string;
  projectUuid: string;
  telegramChatId: number;
  telegramMessageId: number;
  updatedAt: string;
};

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
  clearActiveSessionIdForPrincipal(
    principal: TelegramPrincipal,
  ): Promise<void>;
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

export interface TelegramMenuPayloadStore {
  createMenuPayload(
    record: TelegramMenuPayloadRecord,
    ttlSeconds: number,
  ): Promise<void>;
  getMenuPayload(key: string): Promise<TelegramMenuPayloadRecord | null>;
}

export interface TelegramUserLocaleStore {
  getUserLocale(telegramUserId: number): Promise<string | null>;
  setUserLocale(telegramUserId: number, locale: string): Promise<void>;
}

export interface TelegramAdminAuthStore {
  isAdminAuthorized(principal: TelegramPrincipal): Promise<boolean>;
  setAdminAuthorized(principal: TelegramPrincipal): Promise<void>;
  clearAdminAuthorized(principal: TelegramPrincipal): Promise<void>;
  listAdminAuthorizedPrincipals(): Promise<TelegramPrincipal[]>;
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
  getGatewayClientUuid(): Promise<string | null>;
  setGatewayClientUuid(clientUuid: string): Promise<void>;
  setProjectMenuViewState(state: ProjectMenuViewState): Promise<void>;
  listProjectMenuViewStates(projectUuid: string): Promise<ProjectMenuViewState[]>;
  deleteProjectMenuViewState(sessionId: string, projectUuid: string): Promise<boolean>;
  setOutgoingDeliveryNotice(notice: OutgoingDeliveryNotice): Promise<void>;
  listOutgoingDeliveryNotices(): Promise<OutgoingDeliveryNotice[]>;
  deleteOutgoingDeliveryNotice(deliveryUuid: string): Promise<boolean>;
}
