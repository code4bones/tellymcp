import { randomUUID } from "node:crypto";

import type { Service, ServiceSchema } from "moleculer";

import { DBMixin } from "@src/lib/mixins/db";
import { TELEGRAM_MCP_ENSUREDB_SERVICE_NAME } from "./ensuredb.service";

export const TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME = "telegramMcp.externalInbox";

const MCP_SCHEMA = process.env.DB_SCHEMA || "mcp";

export type InboxMessageRow = {
  id: string;
  source_integration: string;
  source_message_id: string;
  recipient_namespace: string;
  recipient_subject: string;
  route_namespace: string;
  route_key: string;
  resource_kind: string;
  resource_id: string;
  kind: string;
  requires_acceptance: boolean;
  schema_version: number;
  payload: Record<string, unknown>;
  status: string;
  status_reason: string | null;
  pending_request_id: string | null;
  xchange_message_uuid: string | null;
  attempts: number;
};

export type InboxMessageStatusPatch = {
  status: string;
  statusReason?: string | null;
  pendingRequestId?: string | null;
  xchangeMessageUuid?: string | null;
};

// Statuses a recipient can still act on -- excludes terminal outcomes
// (delivered/rejected/failed) that a self-service "Входящие" list has no
// reason to keep surfacing.
const ACTIVE_INBOX_STATUSES = [
  "pending",
  "processing",
  "offered",
  "awaiting_route_binding",
  "deferred",
  "no_live_session",
];

export type InboxRouteSummary = {
  namespace: string;
  routeKey: string;
  count: number;
};

export type InboxMessageSummary = {
  id: string;
  resourceKind: string;
  resourceId: string;
  status: string;
  title: string;
  summary: string;
  createdAt: string;
};

export type TelegramMcpExternalInboxServiceInstance = Service & {
  putMessageRecord: (
    input: Record<string, unknown>,
  ) => Promise<{ id: string; status: string; deduplicated: boolean }>;
  listResponsesRecord: (input: Record<string, unknown>) => Promise<{
    items: Array<{
      message_id: string;
      status: string;
      status_reason?: string;
      updated_at: string;
    }>;
    next_cursor: string | null;
  }>;
  bindIdentityRecord: (input: Record<string, unknown>) => Promise<{
    namespace: string;
    subject: string;
    gateway_user_uuid: string;
  }>;
  bindRouteRecord: (input: Record<string, unknown>) => Promise<{
    namespace: string;
    route_key: string;
    client_uuid: string;
    local_session_id: string;
  }>;
  claimNextPendingMessage: () => Promise<InboxMessageRow | null>;
  resolveRecipientGatewayUserUuid: (
    namespace: string,
    subject: string,
  ) => Promise<string | null>;
  resolveRouteBinding: (
    namespace: string,
    routeKey: string,
    gatewayUserUuid: string,
  ) => Promise<{ clientUuid: string; localSessionId: string } | null>;
  updateMessageStatus: (
    id: string,
    patch: InboxMessageStatusPatch,
  ) => Promise<void>;
  resolveGatewayUserContact: (
    gatewayUserUuid: string,
  ) => Promise<{ telegramChatId: number; telegramUserId: number } | null>;
  reconcileOrphanedMessages: () => Promise<number>;
  resetRetryableNoLiveSessionMessages: (maxAttempts: number) => Promise<number>;
  getMessageById: (id: string) => Promise<InboxMessageRow | null>;
  listActiveRoutesForTelegramUser: (
    telegramUserId: string | number,
  ) => Promise<InboxRouteSummary[]>;
  listActiveMessagesForRoute: (
    telegramUserId: string | number,
    namespace: string,
    routeKey: string,
  ) => Promise<InboxMessageSummary[]>;
};

type ExternalInboxCarrier = Service & Partial<TelegramMcpExternalInboxServiceInstance> & {
  requireText?: (value: unknown, fieldName: string) => string;
  normalizeOptionalText?: (value: unknown) => string | null;
};

function normalizeOptionalTextValue(value: unknown): string | null {
  const text =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text || null;
}

function requireTextValue(value: unknown, fieldName: string): string {
  const text = normalizeOptionalTextValue(value);
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  return text;
}

const TelegramMcpExternalInboxService: ServiceSchema = {
  name: TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME,
  mixins: [DBMixin],
  dependencies: [TELEGRAM_MCP_ENSUREDB_SERVICE_NAME],

  methods: {
    requireText: requireTextValue,
    normalizeOptionalText: normalizeOptionalTextValue,

    async putMessageRecord(this: ExternalInboxCarrier, input: Record<string, unknown>) {
      const source = (input.source ?? {}) as Record<string, unknown>;
      const recipient = (input.recipient ?? {}) as Record<string, unknown>;
      const externalPrincipal = (recipient.externalPrincipal ?? {}) as Record<
        string,
        unknown
      >;
      const route = (input.route ?? {}) as Record<string, unknown>;
      const resource = (input.resource ?? {}) as Record<string, unknown>;
      const display = (input.display ?? {}) as Record<string, unknown>;

      const sourceIntegration = this.requireText!(
        source.integration,
        "source.integration",
      );
      const sourceMessageId = this.requireText!(
        source.messageId,
        "source.messageId",
      );
      const recipientNamespace = this.requireText!(
        externalPrincipal.namespace,
        "recipient.externalPrincipal.namespace",
      );
      const recipientSubject = this.requireText!(
        externalPrincipal.subject,
        "recipient.externalPrincipal.subject",
      );
      const routeNamespace = this.requireText!(route.namespace, "route.namespace");
      const routeKey = this.requireText!(route.key, "route.key");
      const resourceKind = this.requireText!(resource.kind, "resource.kind");
      const resourceId = this.requireText!(resource.id, "resource.id");
      const kind = this.requireText!(input.kind, "kind");
      // display.title is required: TellyMCP does not call back to the source
      // integration to hydrate a preview, so the source must embed one.
      this.requireText!(display.title, "display.title");
      // consoleText is required: the source integration composes the exact
      // PTY text, Telly only relays it (see inbox-worker's sanitization,
      // which still treats this defensively since it's literal PTY input).
      this.requireText!(input.consoleText, "consoleText");
      const requiresAcceptance = input.requiresAcceptance !== false;
      const schemaVersion =
        typeof input.schemaVersion === "number" ? input.schemaVersion : 1;

      const existing = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({
          source_integration: sourceIntegration,
          source_message_id: sourceMessageId,
        })
        .first("id", "status");
      if (existing) {
        return {
          id: String(existing.id),
          status: String(existing.status),
          deduplicated: true,
        };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .insert({
          id,
          source_integration: sourceIntegration,
          source_message_id: sourceMessageId,
          recipient_namespace: recipientNamespace,
          recipient_subject: recipientSubject,
          route_namespace: routeNamespace,
          route_key: routeKey,
          resource_kind: resourceKind,
          resource_id: resourceId,
          kind,
          requires_acceptance: requiresAcceptance,
          schema_version: schemaVersion,
          payload: this.db.raw(`?::jsonb`, [JSON.stringify(input)]),
          status: "pending",
          created_at: now,
          updated_at: now,
        })
        .onConflict(["source_integration", "source_message_id"])
        .ignore();

      const row = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({
          source_integration: sourceIntegration,
          source_message_id: sourceMessageId,
        })
        .first("id", "status");

      if (!row) {
        throw new Error("Failed to persist inbox message.");
      }

      return {
        id: String(row.id),
        status: String(row.status),
        deduplicated: String(row.id) !== id,
      };
    },

    async listResponsesRecord(this: ExternalInboxCarrier, input: Record<string, unknown>) {
      const integration = this.requireText!(input.integration, "integration");
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(100, Math.trunc(input.limit)))
          : 50;
      const since = this.normalizeOptionalText!(input.since);

      const query = this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({ source_integration: integration })
        .orderBy([
          { column: "updated_at", order: "asc" },
          { column: "id", order: "asc" },
        ])
        .limit(limit)
        .select("id", "source_message_id", "status", "status_reason", "updated_at");

      if (since) {
        const separatorIndex = since.indexOf("|");
        const cursorUpdatedAt =
          separatorIndex > 0 ? since.slice(0, separatorIndex) : since;
        const cursorId = separatorIndex > 0 ? since.slice(separatorIndex + 1) : "";
        query.where((builder) => {
          builder
            .where("updated_at", ">", cursorUpdatedAt)
            .orWhere((inner) =>
              inner
                .where("updated_at", "=", cursorUpdatedAt)
                .andWhere("id", ">", cursorId),
            );
        });
      }

      const rows = await query;
      const items = rows.map((row) => ({
        message_id: String(row.source_message_id),
        status: String(row.status),
        ...(row.status_reason ? { status_reason: String(row.status_reason) } : {}),
        updated_at: new Date(row.updated_at).toISOString(),
      }));
      const last = rows[rows.length - 1];
      const nextCursor = last
        ? `${new Date(last.updated_at).toISOString()}|${String(last.id)}`
        : (since ?? null);

      return { items, next_cursor: nextCursor };
    },

    async bindIdentityRecord(this: ExternalInboxCarrier, input: Record<string, unknown>) {
      const namespace = this.requireText!(input.namespace, "namespace");
      const subject = this.requireText!(input.subject, "subject");
      const telegramUserId = this.requireText!(
        input.telegram_user_id,
        "telegram_user_id",
      );

      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first("gateway_user_uuid");
      if (!user?.gateway_user_uuid) {
        throw new Error(
          `No gateway user is registered for telegram_user_id '${telegramUserId}'.`,
        );
      }

      const now = new Date().toISOString();
      await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_external_principals")
        .insert({
          id: randomUUID(),
          namespace,
          subject,
          gateway_user_uuid: user.gateway_user_uuid,
          created_at: now,
          updated_at: now,
        })
        .onConflict(["namespace", "subject"])
        .merge({ gateway_user_uuid: user.gateway_user_uuid, updated_at: now });

      return {
        namespace,
        subject,
        gateway_user_uuid: String(user.gateway_user_uuid),
      };
    },

    async bindRouteRecord(this: ExternalInboxCarrier, input: Record<string, unknown>) {
      const namespace = this.requireText!(input.namespace, "namespace");
      const routeKey = this.requireText!(input.route_key, "route_key");
      const telegramUserId = this.requireText!(
        input.telegram_user_id,
        "telegram_user_id",
      );
      const sessionId = this.requireText!(input.session_id, "session_id");

      if (sessionId.startsWith("relay~")) {
        throw new Error(
          "inbox_bind_route requires the caller's own canonical client_uuid:local_session_id session_id; relay session links are not accepted here.",
        );
      }

      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first("gateway_user_uuid");
      if (!user?.gateway_user_uuid) {
        throw new Error(
          `No gateway user is registered for telegram_user_id '${telegramUserId}'.`,
        );
      }

      const resolved = (await this.broker.call(
        "telegramMcp.gateway.resolveLiveConsole",
        { sessionId },
        { meta: { internal_call: true } },
      )) as { client_uuid: string; local_session_id: string } | null;
      if (!resolved) {
        throw new Error(`Session '${sessionId}' is not a known live console.`);
      }

      const now = new Date().toISOString();
      await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_route_bindings")
        .insert({
          id: randomUUID(),
          namespace,
          route_key: routeKey,
          gateway_user_uuid: user.gateway_user_uuid,
          client_uuid: resolved.client_uuid,
          local_session_id: resolved.local_session_id,
          created_at: now,
          updated_at: now,
        })
        .onConflict(["namespace", "route_key", "gateway_user_uuid"])
        .merge({
          client_uuid: resolved.client_uuid,
          local_session_id: resolved.local_session_id,
          updated_at: now,
        });

      return {
        namespace,
        route_key: routeKey,
        client_uuid: resolved.client_uuid,
        local_session_id: resolved.local_session_id,
      };
    },

    async claimNextPendingMessage(
      this: ExternalInboxCarrier,
    ): Promise<InboxMessageRow | null> {
      const result = await this.db.raw(
        `update "${MCP_SCHEMA}"."inbox_messages"
            set status = 'processing', attempts = attempts + 1,
                last_attempt_at = now(), updated_at = now()
          where id = (
            select id from "${MCP_SCHEMA}"."inbox_messages"
             where status = 'pending'
             order by created_at
             for update skip locked
             limit 1
          )
          returning *`,
      );
      const row = result.rows?.[0];
      return row ? (row as InboxMessageRow) : null;
    },

    async resolveRecipientGatewayUserUuid(
      this: ExternalInboxCarrier,
      namespace: string,
      subject: string,
    ): Promise<string | null> {
      const row = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_external_principals")
        .where({ namespace, subject })
        .first("gateway_user_uuid");
      return row?.gateway_user_uuid ? String(row.gateway_user_uuid) : null;
    },

    async resolveRouteBinding(
      this: ExternalInboxCarrier,
      namespace: string,
      routeKey: string,
      gatewayUserUuid: string,
    ): Promise<{ clientUuid: string; localSessionId: string } | null> {
      const row = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_route_bindings")
        .where({
          namespace,
          route_key: routeKey,
          gateway_user_uuid: gatewayUserUuid,
        })
        .first("client_uuid", "local_session_id");
      return row
        ? {
            clientUuid: String(row.client_uuid),
            localSessionId: String(row.local_session_id),
          }
        : null;
    },

    async updateMessageStatus(
      this: ExternalInboxCarrier,
      id: string,
      patch: InboxMessageStatusPatch,
    ): Promise<void> {
      await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({ id })
        .update({
          status: patch.status,
          ...(patch.statusReason !== undefined
            ? { status_reason: patch.statusReason }
            : {}),
          ...(patch.pendingRequestId !== undefined
            ? { pending_request_id: patch.pendingRequestId }
            : {}),
          ...(patch.xchangeMessageUuid !== undefined
            ? { xchange_message_uuid: patch.xchangeMessageUuid }
            : {}),
          updated_at: new Date().toISOString(),
        });
    },

    async resolveGatewayUserContact(
      this: ExternalInboxCarrier,
      gatewayUserUuid: string,
    ): Promise<{ telegramChatId: number; telegramUserId: number } | null> {
      const row = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ gateway_user_uuid: gatewayUserUuid })
        .first("telegram_chat_id", "telegram_user_id");
      if (!row || row.telegram_chat_id == null || row.telegram_user_id == null) {
        return null;
      }
      return {
        telegramChatId: Number(row.telegram_chat_id),
        telegramUserId: Number(row.telegram_user_id),
      };
    },

    async reconcileOrphanedMessages(this: ExternalInboxCarrier): Promise<number> {
      // A gateway restart loses any in-memory Telegram-reply waiter, so rows
      // left in "processing"/"offered"/"awaiting_route_binding" by a crashed
      // previous instance would otherwise wait forever. Reset them to
      // "pending" for a fresh attempt, bounded by their existing attempts
      // counter.
      const result = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .whereIn("status", ["processing", "offered", "awaiting_route_binding"])
        .update({ status: "pending", updated_at: new Date().toISOString() });
      return typeof result === "number" ? result : 0;
    },

    async resetRetryableNoLiveSessionMessages(
      this: ExternalInboxCarrier,
      maxAttempts: number,
    ): Promise<number> {
      // Only the precheck statusReason is retried here -- the post-approval
      // race case (console disconnected between Approve and the nudge) is
      // left alone so the recipient is never asked to approve the same
      // offer twice.
      const result = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({
          status: "no_live_session",
          status_reason: "target console is not currently connected",
        })
        .andWhere("attempts", "<", maxAttempts)
        .update({ status: "pending", updated_at: new Date().toISOString() });
      return typeof result === "number" ? result : 0;
    },

    async getMessageById(
      this: ExternalInboxCarrier,
      id: string,
    ): Promise<InboxMessageRow | null> {
      const row = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages")
        .where({ id })
        .first();
      return row ? (row as InboxMessageRow) : null;
    },

    async listActiveRoutesForTelegramUser(
      this: ExternalInboxCarrier,
      telegramUserId: string | number,
    ): Promise<InboxRouteSummary[]> {
      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first("gateway_user_uuid");
      if (!user?.gateway_user_uuid) {
        return [];
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages as m")
        .join("inbox_external_principals as p", function joinPrincipal() {
          this.on("p.namespace", "=", "m.recipient_namespace").andOn(
            "p.subject",
            "=",
            "m.recipient_subject",
          );
        })
        .where("p.gateway_user_uuid", user.gateway_user_uuid)
        .whereIn("m.status", ACTIVE_INBOX_STATUSES)
        .groupBy("m.route_namespace", "m.route_key")
        .select(
          "m.route_namespace as namespace",
          "m.route_key as route_key",
          this.db.raw("count(*)::int as count"),
          this.db.raw("max(m.updated_at) as last_activity_at"),
        )
        .orderBy("last_activity_at", "desc");

      return rows.map((row) => ({
        namespace: String(row.namespace),
        routeKey: String(row.route_key),
        count: Number(row.count),
      }));
    },

    async listActiveMessagesForRoute(
      this: ExternalInboxCarrier,
      telegramUserId: string | number,
      namespace: string,
      routeKey: string,
    ): Promise<InboxMessageSummary[]> {
      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first("gateway_user_uuid");
      if (!user?.gateway_user_uuid) {
        return [];
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("inbox_messages as m")
        .join("inbox_external_principals as p", function joinPrincipal() {
          this.on("p.namespace", "=", "m.recipient_namespace").andOn(
            "p.subject",
            "=",
            "m.recipient_subject",
          );
        })
        .where("p.gateway_user_uuid", user.gateway_user_uuid)
        .andWhere("m.route_namespace", namespace)
        .andWhere("m.route_key", routeKey)
        .whereIn("m.status", ACTIVE_INBOX_STATUSES)
        .orderBy("m.created_at", "asc")
        .select(
          "m.id",
          "m.resource_kind",
          "m.resource_id",
          "m.status",
          "m.payload",
          "m.created_at",
        );

      return rows.map((row) => {
        const payload = (
          typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
        ) as Record<string, unknown> | null;
        const display = (payload?.display ?? {}) as Record<string, unknown>;
        const title =
          typeof display.title === "string" && display.title.trim()
            ? display.title.trim()
            : String(row.resource_id);
        const summary =
          typeof display.summary === "string" ? display.summary.trim() : "";
        return {
          id: String(row.id),
          resourceKind: String(row.resource_kind),
          resourceId: String(row.resource_id),
          status: String(row.status),
          title,
          summary,
          createdAt: new Date(row.created_at as string).toISOString(),
        };
      });
    },
  },

  actions: {
    put: {
      params: { $$strict: false },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.putMessageRecord!(ctx.params as Record<string, unknown>);
      },
    },
    responses: {
      params: {
        integration: "string",
        since: { type: "string", optional: true },
        limit: { type: "number", optional: true },
      },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.listResponsesRecord!(ctx.params as Record<string, unknown>);
      },
    },
    bindIdentity: {
      params: {
        namespace: "string",
        subject: "string",
        telegram_user_id: { type: "any" },
      },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.bindIdentityRecord!(ctx.params as Record<string, unknown>);
      },
    },
    bindRoute: {
      params: {
        namespace: "string",
        route_key: "string",
        telegram_user_id: { type: "any" },
        session_id: "string",
      },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.bindRouteRecord!(ctx.params as Record<string, unknown>);
      },
    },
    listActiveRoutes: {
      params: { telegram_user_id: { type: "any" } },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.listActiveRoutesForTelegramUser!(
          ctx.params.telegram_user_id as string | number,
        );
      },
    },
    listActiveMessages: {
      params: {
        telegram_user_id: { type: "any" },
        namespace: "string",
        route_key: "string",
      },
      async handler(this: ExternalInboxCarrier, ctx) {
        return this.listActiveMessagesForRoute!(
          ctx.params.telegram_user_id as string | number,
          ctx.params.namespace as string,
          ctx.params.route_key as string,
        );
      },
    },
  },
};

export default TelegramMcpExternalInboxService;
