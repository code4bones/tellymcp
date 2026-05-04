import { RedisAdapter } from "@grammyjs/storage-redis";

import type {
  PairCodeRecord,
  SessionBinding,
  TelegramPrincipal,
} from "../../../entities/auth/model/types.js";
import type {
  TelegramInboxMessage,
  TelegramMenuPayloadRecord,
} from "../../../entities/inbox/model/types.js";
import type {
  PendingRequestRecord,
  PendingResolution,
} from "../../../entities/request/model/types.js";
import type { SessionContext } from "../../../entities/session/model/types.js";
import type {
  PendingRequestStore,
  SessionBindingStore,
  SessionStore,
  TelegramInboxStore,
  TelegramMenuPayloadStore,
} from "../../api/storage/contract.js";
import { redactSecrets } from "../../lib/redact-secrets/redactSecrets.js";
import type { RedisClient } from "../../../app/providers/redis/client.js";

const KEY_PREFIX = "telegram-mcp";

function sessionKey(sessionId: string): string {
  return `${KEY_PREFIX}:session:${sessionId}`;
}

function bindingKey(sessionId: string): string {
  return `${KEY_PREFIX}:binding:${sessionId}`;
}

function pairCodeKey(code: string): string {
  return `${KEY_PREFIX}:pair-code:${code}`;
}

function requestKey(requestId: string): string {
  return `${KEY_PREFIX}:request:${requestId}`;
}

function principalSessionsKey(principal: TelegramPrincipal): string {
  return `${KEY_PREFIX}:principal:${principal.telegramChatId}:${principal.telegramUserId}:sessions`;
}

function principalActiveSessionKey(principal: TelegramPrincipal): string {
  return `${KEY_PREFIX}:principal:${principal.telegramChatId}:${principal.telegramUserId}:active-session`;
}

function inboxListKey(sessionId: string): string {
  return `${KEY_PREFIX}:inbox:${sessionId}`;
}

function inboxMessageKey(sessionId: string, messageId: string): string {
  return `${KEY_PREFIX}:inbox-message:${sessionId}:${messageId}`;
}

function menuPayloadKey(key: string): string {
  return `${KEY_PREFIX}:menu-payload:${key}`;
}

function activeRequestKey(): string {
  return `${KEY_PREFIX}:pending:active`;
}

function queueKey(): string {
  return `${KEY_PREFIX}:pending:queue`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as T;
}

export class RedisStateStore
  implements
    SessionStore,
    SessionBindingStore,
    PendingRequestStore,
    TelegramInboxStore,
    TelegramMenuPayloadStore
{
  private readonly sessionAdapter: RedisAdapter<SessionContext>;

  public constructor(private readonly redis: RedisClient) {
    this.sessionAdapter = new RedisAdapter<SessionContext>({ instance: redis });
  }

  public async getSession(sessionId: string): Promise<SessionContext | null> {
    const session = await this.sessionAdapter.read(sessionKey(sessionId));
    return session ?? null;
  }

  public async setSession(session: SessionContext): Promise<void> {
    await this.sessionAdapter.write(sessionKey(session.sessionId), session);
  }

  public async clearSession(sessionId: string): Promise<void> {
    await this.sessionAdapter.delete(sessionKey(sessionId));
  }

  public async createPairCode(
    record: PairCodeRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      pairCodeKey(record.code),
      JSON.stringify(record),
      "EX",
      ttlSeconds,
    );
  }

  public async consumePairCode(code: string): Promise<PairCodeRecord | null> {
    const raw = await this.redis.getdel(pairCodeKey(code));
    return parseJson<PairCodeRecord>(raw);
  }

  public async getBinding(sessionId: string): Promise<SessionBinding | null> {
    const raw = await this.redis.get(bindingKey(sessionId));
    return parseJson<SessionBinding>(raw);
  }

  public async setBinding(binding: SessionBinding): Promise<void> {
    const previous = await this.getBinding(binding.sessionId);
    if (
      previous &&
      (previous.telegramChatId !== binding.telegramChatId ||
        previous.telegramUserId !== binding.telegramUserId)
    ) {
      await this.detachSessionFromPrincipal(previous, binding.sessionId);
    }

    await this.redis.set(
      bindingKey(binding.sessionId),
      JSON.stringify(binding),
    );
    await this.redis.sadd(principalSessionsKey(binding), binding.sessionId);
    await this.redis.set(principalActiveSessionKey(binding), binding.sessionId);
  }

  public async clearBinding(sessionId: string): Promise<void> {
    const existing = await this.getBinding(sessionId);
    await this.redis.del(bindingKey(sessionId));
    if (existing) {
      await this.detachSessionFromPrincipal(existing, sessionId);
    }
  }

  public async getActiveSessionIdForPrincipal(
    principal: TelegramPrincipal,
  ): Promise<string | null> {
    return (await this.redis.get(principalActiveSessionKey(principal))) ?? null;
  }

  public async setActiveSessionIdForPrincipal(
    principal: TelegramPrincipal,
    sessionId: string,
  ): Promise<void> {
    const isBound = await this.redis.sismember(
      principalSessionsKey(principal),
      sessionId,
    );
    if (!isBound) {
      await this.redis.sadd(principalSessionsKey(principal), sessionId);
    }
    await this.redis.set(principalActiveSessionKey(principal), sessionId);
  }

  public async listBoundSessionIdsForPrincipal(
    principal: TelegramPrincipal,
  ): Promise<string[]> {
    return this.redis.smembers(principalSessionsKey(principal));
  }

  public async resetRuntimeState(): Promise<void> {
    await this.redis.del(activeRequestKey());
    await this.redis.del(queueKey());
  }

  public async getActive(): Promise<PendingRequestRecord | null> {
    const activeId = await this.redis.get(activeRequestKey());
    if (!activeId) {
      return null;
    }

    const raw = await this.redis.get(requestKey(activeId));
    return parseJson<PendingRequestRecord>(raw);
  }

  public async createPending(request: PendingRequestRecord): Promise<void> {
    await this.redis.set(activeRequestKey(), request.requestId);
    await this.redis.set(
      requestKey(request.requestId),
      JSON.stringify(request),
    );
  }

  public async updatePending(request: PendingRequestRecord): Promise<void> {
    await this.redis.set(
      requestKey(request.requestId),
      JSON.stringify(request),
    );
  }

  public async resolvePending(
    requestId: string,
    resolution: PendingResolution,
  ): Promise<void> {
    const raw = await this.redis.get(requestKey(requestId));
    const current = parseJson<PendingRequestRecord>(raw);

    if (!current) {
      await this.redis.del(activeRequestKey());
      return;
    }

    const next: PendingRequestRecord = {
      ...current,
      status: resolution.status,
      ...(resolution.answer
        ? { answer: redactSecrets(resolution.answer) }
        : {}),
      ...(resolution.receivedAt ? { receivedAt: resolution.receivedAt } : {}),
      ...(resolution.fallbackUsed
        ? { fallbackIfTimeout: resolution.fallbackUsed }
        : {}),
    };

    await this.redis.set(requestKey(requestId), JSON.stringify(next));
    await this.redis.del(activeRequestKey());
  }

  public async enqueue(request: PendingRequestRecord): Promise<void> {
    await this.redis.set(
      requestKey(request.requestId),
      JSON.stringify(request),
    );
    await this.redis.rpush(queueKey(), request.requestId);
  }

  public async dequeueNext(): Promise<PendingRequestRecord | null> {
    const requestId = await this.redis.lpop(queueKey());
    if (!requestId) {
      return null;
    }

    const raw = await this.redis.get(requestKey(requestId));
    return parseJson<PendingRequestRecord>(raw);
  }

  public async createInboxMessage(
    message: TelegramInboxMessage,
  ): Promise<void> {
    await this.redis.set(
      inboxMessageKey(message.sessionId, message.id),
      JSON.stringify(message),
    );
    await this.redis.lpush(inboxListKey(message.sessionId), message.id);
  }

  public async listInboxMessages(
    sessionId: string,
    limit: number,
  ): Promise<TelegramInboxMessage[]> {
    const ids = await this.redis.lrange(inboxListKey(sessionId), 0, limit - 1);
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.redis.mget(
      ...ids.map((messageId) => inboxMessageKey(sessionId, messageId)),
    );

    return rows
      .map((row) => parseJson<TelegramInboxMessage>(row))
      .filter((row): row is TelegramInboxMessage => row !== null);
  }

  public async countInboxMessages(sessionId: string): Promise<number> {
    return this.redis.llen(inboxListKey(sessionId));
  }

  public async getInboxMessage(
    sessionId: string,
    messageId: string,
  ): Promise<TelegramInboxMessage | null> {
    const raw = await this.redis.get(inboxMessageKey(sessionId, messageId));
    return parseJson<TelegramInboxMessage>(raw);
  }

  public async deleteInboxMessage(
    sessionId: string,
    messageId: string,
  ): Promise<boolean> {
    const deletedCount = await this.redis.del(
      inboxMessageKey(sessionId, messageId),
    );
    await this.redis.lrem(inboxListKey(sessionId), 0, messageId);
    return deletedCount > 0;
  }

  public async createMenuPayload(
    record: TelegramMenuPayloadRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      menuPayloadKey(record.key),
      JSON.stringify(record),
      "EX",
      ttlSeconds,
    );
  }

  public async getMenuPayload(
    key: string,
  ): Promise<TelegramMenuPayloadRecord | null> {
    const raw = await this.redis.get(menuPayloadKey(key));
    return parseJson<TelegramMenuPayloadRecord>(raw);
  }

  private async detachSessionFromPrincipal(
    principal: TelegramPrincipal,
    sessionId: string,
  ): Promise<void> {
    const sessionsKey = principalSessionsKey(principal);
    const activeKey = principalActiveSessionKey(principal);

    await this.redis.srem(sessionsKey, sessionId);

    const activeSessionId = await this.redis.get(activeKey);
    if (activeSessionId !== sessionId) {
      return;
    }

    const remaining = await this.redis.smembers(sessionsKey);
    const nextSessionId = remaining[0];
    if (nextSessionId) {
      await this.redis.set(activeKey, nextSessionId);
      return;
    }

    await this.redis.del(activeKey);
  }
}
