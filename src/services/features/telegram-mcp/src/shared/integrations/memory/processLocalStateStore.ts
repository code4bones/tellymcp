import type {
  BrowserAttachmentRecord,
  BrowserRecordingRecord,
} from "../../../entities/browser/model/types";
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
import type {
  MaintenanceStore,
  OutgoingDeliveryNotice,
  PendingRequestStore,
  ProjectMenuViewState,
  SessionBindingStore,
  TelegramAdminAuthStore,
  TelegramMenuPayloadStore,
  TelegramUserLocaleStore,
  TelegramXchangeFileMetaStore,
} from "../../api/storage/contract";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets";

export type RuntimeStateStore = SessionBindingStore &
  PendingRequestStore &
  TelegramAdminAuthStore &
  TelegramUserLocaleStore &
  TelegramXchangeFileMetaStore &
  TelegramMenuPayloadStore &
  MaintenanceStore;

type Expiring<T> = { value: T; expiresAt: number };

function principalKey(principal: TelegramPrincipal): string {
  return `${principal.telegramChatId}:${principal.telegramUserId}`;
}

function xchangeKey(sessionId: string, filePath: string): string {
  return `${sessionId}\u0000${filePath}`;
}

export class ProcessLocalStateStore implements RuntimeStateStore {
  private readonly pairCodes = new Map<string, Expiring<PairCodeRecord>>();
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly principalSessions = new Map<string, Set<string>>();
  private readonly principalActiveSessions = new Map<string, string>();
  private readonly locales = new Map<number, string>();
  private readonly authorizedPrincipals = new Map<string, TelegramPrincipal>();
  private readonly requests = new Map<string, PendingRequestRecord>();
  private readonly requestQueue: string[] = [];
  private activeRequestId: string | null = null;
  private readonly menuPayloads = new Map<string, Expiring<TelegramMenuPayloadRecord>>();
  private readonly xchangeFileMetas = new Map<string, TelegramXchangeFileMeta>();
  private readonly browserAttachments = new Map<string, BrowserAttachmentRecord>();
  private readonly browserRecordings = new Map<string, BrowserRecordingRecord>();
  private readonly projectMenuViews = new Map<string, ProjectMenuViewState>();
  private readonly outgoingNotices = new Map<string, OutgoingDeliveryNotice>();
  private gatewayClientUuid: string | null;

  public constructor(input: {
    gatewayClientUuid?: string | undefined;
    onGatewayClientUuidChange?: (clientUuid: string) => void;
  } = {}) {
    this.gatewayClientUuid = input.gatewayClientUuid?.trim() || null;
    this.onGatewayClientUuidChange = input.onGatewayClientUuidChange;
  }

  private readonly onGatewayClientUuidChange:
    | ((clientUuid: string) => void)
    | undefined;

  public async createPairCode(record: PairCodeRecord, ttlSeconds: number): Promise<boolean> {
    const existing = this.readExpiring(this.pairCodes, record.code);
    if (existing) return false;
    this.pairCodes.set(record.code, { value: record, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  public async consumePairCode(code: string): Promise<PairCodeRecord | null> {
    const record = this.readExpiring(this.pairCodes, code);
    this.pairCodes.delete(code);
    return record;
  }

  public async getBinding(sessionId: string): Promise<SessionBinding | null> {
    return this.bindings.get(sessionId) ?? null;
  }

  public async setBinding(binding: SessionBinding): Promise<void> {
    const previous = this.bindings.get(binding.sessionId);
    if (previous) this.detachSession(previous, binding.sessionId);
    this.bindings.set(binding.sessionId, binding);
    const key = principalKey(binding);
    const sessions = this.principalSessions.get(key) ?? new Set<string>();
    sessions.add(binding.sessionId);
    this.principalSessions.set(key, sessions);
    this.principalActiveSessions.set(key, binding.sessionId);
  }

  public async clearBinding(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    if (binding) this.detachSession(binding, sessionId);
  }

  public async getActiveSessionIdForPrincipal(principal: TelegramPrincipal): Promise<string | null> {
    return this.principalActiveSessions.get(principalKey(principal)) ?? null;
  }

  public async getActiveSessionIdForTelegramUser(telegramUserId: number): Promise<string | null> {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.telegramUserId === telegramUserId) {
        return this.principalActiveSessions.get(principalKey(binding)) ?? sessionId;
      }
    }
    return null;
  }

  public async clearActiveSessionIdForPrincipal(principal: TelegramPrincipal): Promise<void> {
    this.principalActiveSessions.delete(principalKey(principal));
  }

  public async setActiveSessionIdForPrincipal(principal: TelegramPrincipal, sessionId: string): Promise<void> {
    const key = principalKey(principal);
    const sessions = this.principalSessions.get(key) ?? new Set<string>();
    sessions.add(sessionId);
    this.principalSessions.set(key, sessions);
    this.principalActiveSessions.set(key, sessionId);
  }

  public async listBoundSessionIdsForPrincipal(principal: TelegramPrincipal): Promise<string[]> {
    return Array.from(this.principalSessions.get(principalKey(principal)) ?? []);
  }

  public async listBoundPrincipals(): Promise<TelegramPrincipal[]> {
    const principals = new Map<string, TelegramPrincipal>();
    for (const binding of this.bindings.values()) {
      principals.set(principalKey(binding), {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      });
    }
    return Array.from(principals.values());
  }

  public async resetRuntimeState(): Promise<void> {
    this.activeRequestId = null;
    this.requestQueue.length = 0;
  }

  public async getActive(): Promise<PendingRequestRecord | null> {
    return this.activeRequestId ? this.requests.get(this.activeRequestId) ?? null : null;
  }

  public async createPending(request: PendingRequestRecord): Promise<void> {
    this.requests.set(request.requestId, request);
    this.activeRequestId = request.requestId;
  }

  public async updatePending(request: PendingRequestRecord): Promise<void> {
    this.requests.set(request.requestId, request);
  }

  public async resolvePending(requestId: string, resolution: PendingResolution): Promise<void> {
    const current = this.requests.get(requestId);
    if (current) {
      this.requests.set(requestId, {
        ...current,
        status: resolution.status,
        ...(resolution.answer ? { answer: redactSecrets(resolution.answer) } : {}),
        ...(resolution.receivedAt ? { receivedAt: resolution.receivedAt } : {}),
        ...(resolution.fallbackUsed ? { fallbackIfTimeout: resolution.fallbackUsed } : {}),
      });
    }
    this.activeRequestId = null;
  }

  public async enqueue(request: PendingRequestRecord): Promise<void> {
    this.requests.set(request.requestId, request);
    this.requestQueue.push(request.requestId);
  }

  public async dequeueNext(): Promise<PendingRequestRecord | null> {
    const requestId = this.requestQueue.shift();
    return requestId ? this.requests.get(requestId) ?? null : null;
  }

  public async createMenuPayload(record: TelegramMenuPayloadRecord, ttlSeconds: number): Promise<void> {
    this.menuPayloads.set(record.key, { value: record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  public async getMenuPayload(key: string): Promise<TelegramMenuPayloadRecord | null> {
    return this.readExpiring(this.menuPayloads, key);
  }

  public async getUserLocale(telegramUserId: number): Promise<string | null> {
    return this.locales.get(telegramUserId) ?? null;
  }

  public async setUserLocale(telegramUserId: number, locale: string): Promise<void> {
    this.locales.set(telegramUserId, locale);
  }

  public async isAdminAuthorized(principal: TelegramPrincipal): Promise<boolean> {
    return this.authorizedPrincipals.has(principalKey(principal));
  }

  public async setAdminAuthorized(principal: TelegramPrincipal): Promise<void> {
    this.authorizedPrincipals.set(principalKey(principal), principal);
  }

  public async clearAdminAuthorized(principal: TelegramPrincipal): Promise<void> {
    this.authorizedPrincipals.delete(principalKey(principal));
  }

  public async listAdminAuthorizedPrincipals(): Promise<TelegramPrincipal[]> {
    return Array.from(this.authorizedPrincipals.values());
  }

  public async setXchangeFileMeta(meta: TelegramXchangeFileMeta): Promise<void> {
    this.xchangeFileMetas.set(xchangeKey(meta.sessionId, meta.filePath), meta);
  }

  public async listXchangeFileMetas(sessionId: string): Promise<TelegramXchangeFileMeta[]> {
    return Array.from(this.xchangeFileMetas.values())
      .filter((meta) => meta.sessionId === sessionId)
      .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
  }

  public async getXchangeFileMeta(sessionId: string, filePath: string): Promise<TelegramXchangeFileMeta | null> {
    return this.xchangeFileMetas.get(xchangeKey(sessionId, filePath)) ?? null;
  }

  public async deleteXchangeFileMeta(sessionId: string, filePath: string): Promise<boolean> {
    return this.xchangeFileMetas.delete(xchangeKey(sessionId, filePath));
  }

  public async pruneAll(): Promise<{ deletedKeys: number }> {
    const deletedKeys = this.countEntries();
    this.pairCodes.clear(); this.bindings.clear(); this.principalSessions.clear();
    this.principalActiveSessions.clear(); this.locales.clear(); this.authorizedPrincipals.clear();
    this.requests.clear(); this.requestQueue.length = 0; this.activeRequestId = null;
    this.menuPayloads.clear(); this.xchangeFileMetas.clear(); this.browserAttachments.clear();
    this.browserRecordings.clear(); this.projectMenuViews.clear(); this.outgoingNotices.clear();
    this.gatewayClientUuid = null;
    return { deletedKeys };
  }

  public async getGatewayClientUuid(): Promise<string | null> { return this.gatewayClientUuid; }

  public async setGatewayClientUuid(clientUuid: string): Promise<void> {
    this.gatewayClientUuid = clientUuid;
    this.onGatewayClientUuidChange?.(clientUuid);
  }

  public async getBrowserAttachment(sessionId: string): Promise<BrowserAttachmentRecord | null> {
    return this.browserAttachments.get(sessionId) ?? null;
  }
  public async setBrowserAttachment(record: BrowserAttachmentRecord): Promise<void> {
    this.browserAttachments.set(record.sessionId, record);
  }
  public async clearBrowserAttachment(sessionId: string): Promise<void> { this.browserAttachments.delete(sessionId); }
  public async getBrowserRecording(sessionId: string): Promise<BrowserRecordingRecord | null> {
    return this.browserRecordings.get(sessionId) ?? null;
  }
  public async setBrowserRecording(record: BrowserRecordingRecord): Promise<void> {
    this.browserRecordings.set(record.sessionId, record);
  }
  public async clearBrowserRecording(sessionId: string): Promise<void> { this.browserRecordings.delete(sessionId); }

  public async setProjectMenuViewState(state: ProjectMenuViewState): Promise<void> {
    this.projectMenuViews.set(xchangeKey(state.projectUuid, state.sessionId), state);
  }
  public async listProjectMenuViewStates(projectUuid: string): Promise<ProjectMenuViewState[]> {
    return Array.from(this.projectMenuViews.values()).filter((state) => state.projectUuid === projectUuid);
  }
  public async deleteProjectMenuViewState(sessionId: string, projectUuid: string): Promise<boolean> {
    return this.projectMenuViews.delete(xchangeKey(projectUuid, sessionId));
  }
  public async setOutgoingDeliveryNotice(notice: OutgoingDeliveryNotice): Promise<void> {
    this.outgoingNotices.set(notice.deliveryUuid, notice);
  }
  public async listOutgoingDeliveryNotices(): Promise<OutgoingDeliveryNotice[]> {
    return Array.from(this.outgoingNotices.values());
  }
  public async deleteOutgoingDeliveryNotice(deliveryUuid: string): Promise<boolean> {
    return this.outgoingNotices.delete(deliveryUuid);
  }

  private readExpiring<T>(store: Map<string, Expiring<T>>, key: string): T | null {
    const record = store.get(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) { store.delete(key); return null; }
    return record.value;
  }

  private detachSession(principal: TelegramPrincipal, sessionId: string): void {
    const key = principalKey(principal);
    const sessions = this.principalSessions.get(key);
    sessions?.delete(sessionId);
    if (!sessions?.size) this.principalSessions.delete(key);
    if (this.principalActiveSessions.get(key) === sessionId) {
      const next = sessions?.values().next().value as string | undefined;
      if (next) this.principalActiveSessions.set(key, next);
      else this.principalActiveSessions.delete(key);
    }
  }

  private countEntries(): number {
    return this.pairCodes.size + this.bindings.size + this.locales.size +
      this.authorizedPrincipals.size + this.requests.size + this.menuPayloads.size +
      this.xchangeFileMetas.size + this.browserAttachments.size + this.browserRecordings.size +
      this.projectMenuViews.size + this.outgoingNotices.size + (this.gatewayClientUuid ? 1 : 0);
  }
}
