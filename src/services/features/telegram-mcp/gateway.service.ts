import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Service, ServiceSchema } from "moleculer";

import { DBMixin } from "@src/lib/mixins/db";
import type {
  PartnerArtifactRef,
  SendPartnerNoteOutput,
} from "./src/entities/collaboration/model/types";
import { resolveGatewayInReplyTo } from "./src/features/distributed-gateway/model/gatewayReplyResolution";
import { resolveGatewayScopeKey } from "./src/shared/lib/gatewayScope";
import { TELEGRAM_MCP_ENSUREDB_SERVICE_NAME } from "./ensuredb.service";

export const TELEGRAM_MCP_GATEWAY_SERVICE_NAME = "telegramMcp.gateway";

const MCP_SCHEMA = process.env.DB_SCHEME || "mcp";
const DISTRIBUTED_MODE = process.env.DISTRIBUTED_MODE || "client";
const GATEWAY_ENABLED =
  DISTRIBUTED_MODE === "gateway" || DISTRIBUTED_MODE === "both";

type GatewayServiceCarrier = Service & {
  normalizeOptionalText?: (value: unknown) => string | null;
  requireText?: (value: unknown, fieldName: string) => string;
  resolveOwnerUserUuidFilter?: (
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  resolveGatewayUserRouteRecord?: (input: Record<string, unknown>) => Promise<{
    gateway_user_uuid: string;
    telegram_user_id: number;
    telegram_chat_id: number | null;
    telegram_username?: string | null;
    telegram_display_name?: string | null;
  } | null>;
  upsertGatewayUserRecord?: (input: Record<string, unknown>) => Promise<{
    gateway_user_uuid: string;
    created: boolean;
    updated_at: string;
  }>;
  registerClientRecord?: (input: Record<string, unknown>) => Promise<{
    client_uuid: string;
    created: boolean;
    updated_at: string;
  }>;
  createProjectRecord?: (input: Record<string, unknown>) => Promise<{
    project_uuid: string;
    invite_token: string;
    name: string;
    created: boolean;
  }>;
  joinProjectRecord?: (input: Record<string, unknown>) => Promise<{
    project_uuid: string;
    invite_token: string;
    name: string;
    joined: boolean;
  }>;
  registerSessionRecord?: (input: Record<string, unknown>) => Promise<{
    session_uuid: string;
    created: boolean;
    updated_at: string;
  }>;
  unregisterSessionRecord?: (input: Record<string, unknown>) => Promise<{
    local_session_id: string;
    deleted: number;
  }>;
  listClientsRecord?: (input: Record<string, unknown>) => Promise<{
    clients: Array<{
      client_uuid: string;
      client_label: string | null;
      namespace?: string | null;
      node_id?: string | null;
      telegram_username: string | null;
      telegram_display_name: string | null;
      bot_username: string | null;
      last_seen_at?: string;
      updated_at?: string;
      session_count: number;
    }>;
  }>;
  listClientSessionsRecord?: (input: Record<string, unknown>) => Promise<{
    sessions: Array<{
      session_uuid: string;
      client_uuid: string;
      local_session_id: string;
      label: string | null;
      status: string;
      project_uuid?: string;
      project_name?: string | null;
      updated_at?: string;
    }>;
  }>;
  listAllSessionsRecord?: (input: Record<string, unknown>) => Promise<{
    sessions: Array<{
      session_uuid: string;
      client_uuid: string;
      local_session_id: string;
      label: string | null;
      status: string;
      client_label: string | null;
      telegram_username: string | null;
      telegram_display_name: string | null;
      bot_username: string | null;
      project_uuid?: string;
      project_name?: string | null;
      updated_at?: string;
    }>;
  }>;
  listProjectsRecord?: (input: Record<string, unknown>) => Promise<{
    projects: Array<{
      project_uuid: string;
      name: string;
      invite_token: string;
      role: string;
      status: string;
      joined_at?: string;
    }>;
  }>;
  leaveProjectRecord?: (input: Record<string, unknown>) => Promise<{
    project_uuid: string;
    left: boolean;
    project_name?: string;
    notify_client_uuids?: string[];
    member_display_name?: string | null;
    member_telegram_username?: string | null;
  }>;
  deleteProjectRecord?: (input: Record<string, unknown>) => Promise<{
    project_uuid: string;
    deleted: boolean;
    project_name?: string;
    notify_client_uuids?: string[];
  }>;
  listProjectSessionsRecord?: (input: Record<string, unknown>) => Promise<{
    sessions: Array<{
      session_uuid: string;
      project_uuid: string;
      client_uuid: string;
      local_session_id: string;
      label: string | null;
      status: string;
      client_label: string | null;
      telegram_username: string | null;
      bot_username: string | null;
      joined_at?: string;
      updated_at?: string;
    }>;
  }>;
  listSessionHistoryRecord?: (input: Record<string, unknown>) => Promise<{
    history: Array<{
      message_uuid: string;
      kind: string;
      summary: string;
      created_at: string;
      direction: "outgoing" | "incoming";
      project_uuid?: string;
      project_name?: string;
      from_session_id: string;
      from_label: string;
      to_session_id: string;
      to_label: string;
      delivery_status?: string;
    }>;
  }>;
  sendPartnerNoteRecord?: (
    input: Record<string, unknown>,
  ) => Promise<SendPartnerNoteOutput>;
  pollDeliveriesRecord?: (input: Record<string, unknown>) => Promise<{
    deliveries: Array<{
      delivery_uuid: string;
      message_uuid: string;
      share_id: string;
      project_uuid?: string;
      project_name?: string;
      source_actor_label?: string;
      kind: string;
      summary: string;
      message: string;
      expected_reply?: string;
      requires_reply: boolean;
      in_reply_to?: string;
      source_session_uuid: string;
      source_session_label: string;
      source_local_session_id: string;
      target_session_uuid: string;
      target_local_session_id: string;
      target_session_label: string;
      created_at: string;
      note_relative_path: string;
      artifacts: Array<{
        artifact_uuid: string;
        original_name: string;
        mime_type?: string;
        size_bytes?: number;
        storage_ref?: string;
        relative_path?: string;
      }>;
    }>;
  }>;
  ackDeliveriesRecord?: (input: Record<string, unknown>) => Promise<{
    acked: number;
  }>;
  failDeliveriesRecord?: (input: Record<string, unknown>) => Promise<{
    failed: number;
  }>;
  listSenderDeliveryStatusesRecord?: (input: Record<string, unknown>) => Promise<{
    deliveries: Array<{
      delivery_uuid: string;
      share_id: string;
      status: string;
      delivered_at?: string;
      acked_at?: string;
    }>;
  }>;
};

function trimOptionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text ? text : null;
}

function sanitizeArtifactName(value: string): string {
  const withoutControlChars = Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
    .join("");
  return withoutControlChars
    .trim()
    .replace(/[/\\]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^\.+$/u, "file")
    .slice(0, 180) || "file";
}

function allocateArtifactRelativePath(
  shareId: string,
  preferredName: string,
  usedNames: Set<string>,
): string {
  const sanitized = sanitizeArtifactName(preferredName);
  const ext = path.extname(sanitized);
  const base = ext ? sanitized.slice(0, -ext.length) : sanitized;
  let candidate = sanitized;
  let index = 1;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}--${index}${ext}`;
    index += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return `shares/files/${shareId}/${candidate}`;
}

function readClientMeta(
  client: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!client?.meta || typeof client.meta !== "object" || Array.isArray(client.meta)) {
    return {};
  }

  return client.meta as Record<string, unknown>;
}

const TelegramMcpGatewayService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_SERVICE_NAME,
  mixins: [DBMixin],
  dependencies: [TELEGRAM_MCP_ENSUREDB_SERVICE_NAME],

  methods: {
    normalizeOptionalText(this: GatewayServiceCarrier, value: unknown): string | null {
      const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
      return text ? text : null;
    },

    requireText(this: GatewayServiceCarrier, value: unknown, fieldName: string): string {
      const text = this.normalizeOptionalText?.(value);
      if (!text) {
        throw new Error(`${fieldName} is required`);
      }
      return text;
    },

    async resolveOwnerUserUuidFilter(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ): Promise<string | null> {
      const explicitOwnerUserUuid = this.normalizeOptionalText?.(input.owner_user_uuid);
      if (explicitOwnerUserUuid) {
        return explicitOwnerUserUuid;
      }

      const telegramUserId = this.normalizeOptionalText?.(input.telegram_user_id);
      if (!telegramUserId) {
        return null;
      }

      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first("gateway_user_uuid");

      return user?.gateway_user_uuid
        ? String(user.gateway_user_uuid)
        : "__missing_gateway_user__";
    },

    async upsertGatewayUserRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const telegramUserId = this.requireText?.(input.telegram_user_id, "telegram_user_id");
      const telegramChatId = this.normalizeOptionalText?.(input.telegram_chat_id);
      const telegramUsername = this.normalizeOptionalText?.(input.telegram_username);
      const telegramDisplayName = this.normalizeOptionalText?.(input.telegram_display_name);
      const now = new Date().toISOString();

      const existing = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ telegram_user_id: telegramUserId })
        .first();

      if (existing) {
        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_users")
          .where({ gateway_user_uuid: existing.gateway_user_uuid })
          .update({
            ...(telegramChatId ? { telegram_chat_id: telegramChatId } : {}),
            ...(telegramUsername ? { telegram_username: telegramUsername } : {}),
            ...(telegramDisplayName ? { telegram_display_name: telegramDisplayName } : {}),
            updated_at: now,
            last_auth_at: now,
          });

        return {
          gateway_user_uuid: String(existing.gateway_user_uuid),
          created: false,
          updated_at: now,
        };
      }

      const gatewayUserUuid = randomUUID();
      await this.db.withSchema(MCP_SCHEMA).table("gateway_users").insert({
        gateway_user_uuid: gatewayUserUuid,
        telegram_user_id: telegramUserId,
        ...(telegramChatId ? { telegram_chat_id: telegramChatId } : {}),
        ...(telegramUsername ? { telegram_username: telegramUsername } : {}),
        ...(telegramDisplayName ? { telegram_display_name: telegramDisplayName } : {}),
        created_at: now,
        updated_at: now,
        last_auth_at: now,
      });

      return {
        gateway_user_uuid: gatewayUserUuid,
        created: true,
        updated_at: now,
      };
    },

    async resolveGatewayUserRouteRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const explicitGatewayUserUuid =
        this.normalizeOptionalText?.(input.gateway_user_uuid);
      const clientUuid = this.normalizeOptionalText?.(input.client_uuid);

      let gatewayUserUuid = explicitGatewayUserUuid;
      if (!gatewayUserUuid && clientUuid) {
        const client = await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_clients")
          .where({ client_uuid: clientUuid })
          .first("owner_user_uuid");
        gatewayUserUuid =
          client?.owner_user_uuid ? String(client.owner_user_uuid) : null;
      }

      if (!gatewayUserUuid) {
        return null;
      }

      const user = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_users")
        .where({ gateway_user_uuid: gatewayUserUuid })
        .first(
          "gateway_user_uuid",
          "telegram_user_id",
          "telegram_chat_id",
          "telegram_username",
          "telegram_display_name",
        );
      if (!user?.gateway_user_uuid || !user.telegram_user_id) {
        return null;
      }

      return {
        gateway_user_uuid: String(user.gateway_user_uuid),
        telegram_user_id: Number(user.telegram_user_id),
        telegram_chat_id:
          typeof user.telegram_chat_id === "number"
            ? user.telegram_chat_id
            : user.telegram_chat_id
              ? Number(user.telegram_chat_id)
              : null,
        ...(user.telegram_username
          ? { telegram_username: String(user.telegram_username) }
          : {}),
        ...(user.telegram_display_name
          ? { telegram_display_name: String(user.telegram_display_name) }
          : {}),
      };
    },

    async registerClientRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid =
        this.normalizeOptionalText?.(input.client_uuid) || randomUUID();
      const now = new Date().toISOString();
      const scopeKey = resolveGatewayScopeKey(input);
      const clientLabel = this.normalizeOptionalText?.(input.client_label);
      const botUsername = this.normalizeOptionalText?.(input.bot_username);
      const tokenFingerprint = this.normalizeOptionalText?.(input.bot_token_fingerprint);
      const ownerUserUuid =
        this.normalizeOptionalText?.(input.owner_user_uuid) ||
        (input.meta &&
        typeof input.meta === "object" &&
        !Array.isArray(input.meta) &&
        typeof (input.meta as Record<string, unknown>).gateway_user_uuid === "string"
          ? this.normalizeOptionalText?.(
              (input.meta as Record<string, unknown>).gateway_user_uuid,
            )
          : null);
      const meta =
        input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
          ? input.meta
          : {};

      const existing = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_clients")
        .where({ client_uuid: clientUuid })
        .first();

      if (existing) {
        const existingScopeKey = this.normalizeOptionalText?.(existing.scope_key);
        if (existingScopeKey && scopeKey && existingScopeKey !== scopeKey) {
          throw new Error("Client is already bound to a different gateway scope.");
        }

        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_clients")
          .where({ client_uuid: clientUuid })
          .update({
            ...(ownerUserUuid ? { owner_user_uuid: ownerUserUuid } : {}),
            ...(scopeKey ? { scope_key: scopeKey } : {}),
            ...(clientLabel ? { client_label: clientLabel } : {}),
            ...(botUsername ? { bot_username: botUsername } : {}),
            ...(tokenFingerprint ? { bot_token_fingerprint: tokenFingerprint } : {}),
            meta: this.db.raw(`?::jsonb`, [JSON.stringify(meta)]),
            updated_at: now,
            last_seen_at: now,
          });

        return {
          client_uuid: clientUuid,
          created: false,
          updated_at: now,
        };
      }

      await this.db.withSchema(MCP_SCHEMA).table("gateway_clients").insert({
        client_uuid: clientUuid,
        ...(ownerUserUuid ? { owner_user_uuid: ownerUserUuid } : {}),
        ...(scopeKey ? { scope_key: scopeKey } : {}),
        ...(clientLabel ? { client_label: clientLabel } : {}),
        ...(botUsername ? { bot_username: botUsername } : {}),
        ...(tokenFingerprint ? { bot_token_fingerprint: tokenFingerprint } : {}),
        meta: this.db.raw(`?::jsonb`, [JSON.stringify(meta)]),
        created_at: now,
        updated_at: now,
        last_seen_at: now,
      });

      return {
        client_uuid: clientUuid,
        created: true,
        updated_at: now,
      };
    },

    async createProjectRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const name = this.requireText?.(input.name, "name");

      const client = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_clients")
        .where({ client_uuid: clientUuid })
        .first();
      if (!client) {
        throw new Error(`Client ${clientUuid} is not registered`);
      }

      const clientMeta = readClientMeta(client as Record<string, unknown>);
      const ownerTelegramUserId = this.normalizeOptionalText?.(
        clientMeta.telegram_user_id,
      );
      const ownerTelegramUsername = this.normalizeOptionalText?.(
        clientMeta.telegram_username,
      );
      const ownerDisplayName = this.normalizeOptionalText?.(
        clientMeta.telegram_display_name,
      );

      const projectUuid = randomUUID();
      const inviteToken = randomUUID();
      const now = new Date().toISOString();

      await this.db.withSchema(MCP_SCHEMA).table("gateway_projects").insert({
        project_uuid: projectUuid,
        name,
        invite_token: inviteToken,
        created_by_client_uuid: clientUuid,
        ...(ownerTelegramUserId
          ? { owner_telegram_user_id: ownerTelegramUserId }
          : {}),
        ...(ownerTelegramUsername
          ? { owner_telegram_username: ownerTelegramUsername }
          : {}),
        ...(ownerDisplayName ? { owner_display_name: ownerDisplayName } : {}),
        is_active: true,
        created_at: now,
        updated_at: now,
      });

      await this.db.withSchema(MCP_SCHEMA).table("gateway_project_members").insert({
        project_uuid: projectUuid,
        client_uuid: clientUuid,
        role: "owner",
        status: "active",
        ...(ownerTelegramUserId ? { telegram_user_id: ownerTelegramUserId } : {}),
        ...(ownerTelegramUsername ? { telegram_username: ownerTelegramUsername } : {}),
        ...(ownerDisplayName ? { display_name: ownerDisplayName } : {}),
        joined_at: now,
      });

      return {
        project_uuid: projectUuid,
        invite_token: inviteToken,
        name,
        created: true,
      };
    },

    async joinProjectRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const inviteToken = this.requireText?.(input.invite_token, "invite_token");

      const client = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_clients")
        .where({ client_uuid: clientUuid })
        .first();
      if (!client) {
        throw new Error(`Client ${clientUuid} is not registered`);
      }

      const clientMeta = readClientMeta(client as Record<string, unknown>);
      const memberTelegramUserId = this.normalizeOptionalText?.(
        clientMeta.telegram_user_id,
      );
      const memberTelegramUsername = this.normalizeOptionalText?.(
        clientMeta.telegram_username,
      );
      const memberDisplayName = this.normalizeOptionalText?.(
        clientMeta.telegram_display_name,
      );
      const memberScopeKey = this.normalizeOptionalText?.(
        (client as Record<string, unknown>).scope_key,
      );

      const project = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_projects as p")
        .leftJoin("gateway_clients as owner_client", "owner_client.client_uuid", "p.created_by_client_uuid")
        .where({ "p.invite_token": inviteToken, "p.is_active": true })
        .select(
          "p.*",
          "owner_client.scope_key as owner_scope_key",
        )
        .first();
      if (!project) {
        throw new Error("Project invite token is invalid or inactive");
      }

      const ownerScopeKey = this.normalizeOptionalText?.(
        (project as Record<string, unknown>).owner_scope_key,
      );
      if (memberScopeKey && ownerScopeKey && memberScopeKey !== ownerScopeKey) {
        throw new Error("Project belongs to a different gateway scope.");
      }

      const existing = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          project_uuid: project.project_uuid,
          client_uuid: clientUuid,
        })
        .first();

      if (existing) {
        const notifyRows =
          existing.status !== "active"
            ? await this.db
                .withSchema(MCP_SCHEMA)
                .table("gateway_project_members")
                .where({
                  project_uuid: project.project_uuid,
                  status: "active",
                })
                .whereNot({
                  client_uuid: clientUuid,
                })
                .distinct("client_uuid")
            : [];

        if (existing.status !== "active") {
          await this.db
            .withSchema(MCP_SCHEMA)
            .table("gateway_project_members")
            .where({
              project_uuid: project.project_uuid,
              client_uuid: clientUuid,
            })
            .update({
              status: "active",
              ...(memberTelegramUserId
                ? { telegram_user_id: memberTelegramUserId }
                : {}),
              ...(memberTelegramUsername
                ? { telegram_username: memberTelegramUsername }
                : {}),
              ...(memberDisplayName ? { display_name: memberDisplayName } : {}),
              joined_at: new Date().toISOString(),
            });
        }

        return {
          project_uuid: project.project_uuid,
          invite_token: project.invite_token,
          name: project.name,
          joined: false,
          ...(notifyRows.length > 0
            ? {
                notify_client_uuids: notifyRows
                  .map((row) => String(row.client_uuid))
                  .filter(Boolean),
              }
            : {}),
          member_display_name: memberDisplayName ?? null,
          member_telegram_username: memberTelegramUsername ?? null,
        };
      }

      await this.db.withSchema(MCP_SCHEMA).table("gateway_project_members").insert({
        project_uuid: project.project_uuid,
        client_uuid: clientUuid,
        role: "member",
        status: "active",
        ...(memberTelegramUserId ? { telegram_user_id: memberTelegramUserId } : {}),
        ...(memberTelegramUsername ? { telegram_username: memberTelegramUsername } : {}),
        ...(memberDisplayName ? { display_name: memberDisplayName } : {}),
        joined_at: new Date().toISOString(),
      });

      const notifyRows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          project_uuid: project.project_uuid,
          status: "active",
        })
        .whereNot({
          client_uuid: clientUuid,
        })
        .distinct("client_uuid");

      return {
        project_uuid: project.project_uuid,
        invite_token: project.invite_token,
        name: project.name,
        joined: true,
        ...(notifyRows.length > 0
          ? {
              notify_client_uuids: notifyRows
                .map((row) => String(row.client_uuid))
                .filter(Boolean),
            }
          : {}),
        member_display_name: memberDisplayName ?? null,
        member_telegram_username: memberTelegramUsername ?? null,
      };
    },

    async registerSessionRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const projectUuid = this.requireText?.(input.project_uuid, "project_uuid");
      const localSessionId = this.requireText?.(input.local_session_id, "local_session_id");
      const now = new Date().toISOString();

      const membership = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          project_uuid: projectUuid,
          client_uuid: clientUuid,
          status: "active",
        })
        .first();
      if (!membership) {
        throw new Error(
          `Client ${clientUuid} is not an active member of project ${projectUuid}`,
        );
      }

      const existing = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          project_uuid: projectUuid,
          client_uuid: clientUuid,
          local_session_id: localSessionId,
        })
        .first();

      const payload = {
        project_uuid: projectUuid,
        client_uuid: clientUuid,
        local_session_id: localSessionId,
        ...(this.normalizeOptionalText?.(input.label)
          ? { label: this.normalizeOptionalText?.(input.label) }
          : {}),
        ...(this.normalizeOptionalText?.(input.cwd)
          ? { cwd: this.normalizeOptionalText?.(input.cwd) }
          : {}),
        ...(this.normalizeOptionalText?.(input.tmux_session_name)
          ? { tmux_session_name: this.normalizeOptionalText?.(input.tmux_session_name) }
          : {}),
        ...(this.normalizeOptionalText?.(input.tmux_window_name)
          ? { tmux_window_name: this.normalizeOptionalText?.(input.tmux_window_name) }
          : {}),
        ...(Number.isInteger(input.tmux_window_index)
          ? { tmux_window_index: input.tmux_window_index }
          : {}),
        ...(this.normalizeOptionalText?.(input.tmux_pane_id)
          ? { tmux_pane_id: this.normalizeOptionalText?.(input.tmux_pane_id) }
          : {}),
        ...(Number.isInteger(input.tmux_pane_index)
          ? { tmux_pane_index: input.tmux_pane_index }
          : {}),
        ...(this.normalizeOptionalText?.(input.tmux_target)
          ? { tmux_target: this.normalizeOptionalText?.(input.tmux_target) }
          : {}),
        status: this.normalizeOptionalText?.(input.status) || "active",
        meta: this.db.raw(`?::jsonb`, [
          JSON.stringify(
            input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
              ? input.meta
              : {},
          ),
        ]),
        updated_at: now,
      };

      if (existing) {
        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_sessions")
          .where({
            project_uuid: projectUuid,
            client_uuid: clientUuid,
          })
          .whereNot({
            local_session_id: localSessionId,
          })
          .update({
            status: "inactive",
            updated_at: now,
          });

        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_sessions")
          .where({ session_uuid: existing.session_uuid })
          .update(payload);

        return {
          session_uuid: existing.session_uuid,
          created: false,
          updated_at: now,
        };
      }

      const sessionUuid = randomUUID();
      await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          project_uuid: projectUuid,
          client_uuid: clientUuid,
        })
        .whereNot({
          local_session_id: localSessionId,
        })
        .update({
          status: "inactive",
          updated_at: now,
        });
      await this.db.withSchema(MCP_SCHEMA).table("gateway_sessions").insert({
        session_uuid: sessionUuid,
        ...payload,
        created_at: now,
      });

      return {
        session_uuid: sessionUuid,
        created: true,
        updated_at: now,
      };
    },

    async listClientsRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown> = {},
    ) {
      const scopeKey = resolveGatewayScopeKey(input);
      const ownerUserUuid = await this.resolveOwnerUserUuidFilter?.(input);
      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_clients as c")
        .leftJoin("gateway_sessions as s", "c.client_uuid", "s.client_uuid")
        .modify((query) => {
          if (scopeKey) {
            query.where("c.scope_key", scopeKey);
          }
          if (ownerUserUuid) {
            query.where("c.owner_user_uuid", ownerUserUuid);
          }
        })
        .groupBy(
          "c.client_uuid",
          "c.client_label",
          this.db.raw("nullif(c.meta->>'namespace', '')"),
          this.db.raw("nullif(c.meta->>'node_id', '')"),
          this.db.raw("nullif(c.meta->>'system_username', '')"),
          this.db.raw("nullif(c.meta->>'telegram_username', '')"),
          this.db.raw("nullif(c.meta->>'telegram_display_name', '')"),
          "c.bot_username",
          "c.last_seen_at",
          "c.updated_at",
        )
        .select(
          "c.client_uuid",
          "c.client_label",
          this.db.raw("nullif(c.meta->>'namespace', '') as namespace"),
          this.db.raw("nullif(c.meta->>'node_id', '') as node_id"),
          this.db.raw("nullif(c.meta->>'system_username', '') as system_username"),
          this.db.raw("nullif(c.meta->>'telegram_username', '') as telegram_username"),
          this.db.raw("nullif(c.meta->>'telegram_display_name', '') as telegram_display_name"),
          "c.bot_username",
          "c.last_seen_at",
          "c.updated_at",
          this.db.raw(
            "count(case when s.status = 'active' then s.session_uuid end) as session_count",
          ),
        )
        .orderBy("c.last_seen_at", "desc")
        .orderBy("c.client_uuid", "asc");

      this.logger.info("Gateway clients list queried", {
        count: rows.length,
        clientUuids: rows
          .map((row: Record<string, unknown>) => String(row.client_uuid ?? ""))
          .filter(Boolean),
        ...(scopeKey ? { scopeKey } : {}),
      });

      return {
        clients: rows.map((row: Record<string, unknown>) => ({
          client_uuid: String(row.client_uuid),
          client_label: row.client_label ? String(row.client_label) : null,
          namespace: row.namespace ? String(row.namespace) : null,
          node_id: row.node_id ? String(row.node_id) : null,
          system_username: row.system_username ? String(row.system_username) : null,
          telegram_username: row.telegram_username ? String(row.telegram_username) : null,
          telegram_display_name: row.telegram_display_name ? String(row.telegram_display_name) : null,
          bot_username: row.bot_username ? String(row.bot_username) : null,
          ...(row.last_seen_at ? { last_seen_at: String(row.last_seen_at) } : {}),
          ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
          session_count: Number(row.session_count || 0),
        })),
      };
    },

    async listClientSessionsRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const scopeKey = resolveGatewayScopeKey(input);
      const ownerUserUuid = await this.resolveOwnerUserUuidFilter?.(input);
      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions as s")
        .join("gateway_clients as c", "c.client_uuid", "s.client_uuid")
        .leftJoin("gateway_projects as p", "p.project_uuid", "s.project_uuid")
        .where("s.client_uuid", clientUuid)
        .where("s.status", "active")
        .modify((query) => {
          if (scopeKey) {
            query.where("c.scope_key", scopeKey);
          }
          if (ownerUserUuid) {
            query.where("c.owner_user_uuid", ownerUserUuid);
          }
        })
        .select(
          "s.session_uuid",
          "s.client_uuid",
          "s.local_session_id",
          "s.label",
          "s.status",
          "s.project_uuid",
          "s.updated_at",
          "p.name as project_name",
        )
        .orderByRaw("coalesce(s.label, s.local_session_id) asc")
        .orderBy("s.updated_at", "desc");

      this.logger.info("Gateway client sessions queried", {
        clientUuid,
        count: rows.length,
        ...(scopeKey ? { scopeKey } : {}),
        localSessionIds: rows
          .map((row: Record<string, unknown>) => String(row.local_session_id ?? ""))
          .filter(Boolean),
      });

      return {
        sessions: rows.map((row: Record<string, unknown>) => ({
          session_uuid: String(row.session_uuid),
          client_uuid: String(row.client_uuid),
          local_session_id: String(row.local_session_id),
          label: row.label ? String(row.label) : null,
          status: String(row.status),
          ...(row.project_uuid ? { project_uuid: String(row.project_uuid) } : {}),
          ...(row.project_name ? { project_name: String(row.project_name) } : {}),
          ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
        })),
      };
    },

    async listAllSessionsRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown> = {},
    ) {
      const scopeKey = resolveGatewayScopeKey(input);
      const ownerUserUuid = await this.resolveOwnerUserUuidFilter?.(input);
      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions as s")
        .leftJoin("gateway_projects as p", "p.project_uuid", "s.project_uuid")
        .leftJoin("gateway_clients as c", "c.client_uuid", "s.client_uuid")
        .where("s.status", "active")
        .modify((query) => {
          if (scopeKey) {
            query.where("c.scope_key", scopeKey);
          }
          if (ownerUserUuid) {
            query.where("c.owner_user_uuid", ownerUserUuid);
          }
        })
        .select(
          "s.session_uuid",
          "s.client_uuid",
          "s.local_session_id",
          "s.label",
          "s.status",
          "s.project_uuid",
          "s.updated_at",
          "p.name as project_name",
          "c.client_label",
          "c.bot_username",
          this.db.raw("nullif(c.meta->>'system_username', '') as system_username"),
          this.db.raw("nullif(c.meta->>'telegram_username', '') as telegram_username"),
          this.db.raw(
            "nullif(c.meta->>'telegram_display_name', '') as telegram_display_name",
          ),
        )
        .orderBy("s.client_uuid", "asc")
        .orderByRaw("coalesce(s.label, s.local_session_id) asc")
        .orderBy("s.updated_at", "desc");

      this.logger.info("Gateway all sessions queried", {
        count: rows.length,
        ...(scopeKey ? { scopeKey } : {}),
      });

      return {
        sessions: rows.map((row: Record<string, unknown>) => ({
          session_uuid: String(row.session_uuid),
          client_uuid: String(row.client_uuid),
          local_session_id: String(row.local_session_id),
          label: row.label ? String(row.label) : null,
          status: String(row.status),
          client_label: row.client_label ? String(row.client_label) : null,
          system_username: row.system_username
            ? String(row.system_username)
            : null,
          telegram_username: row.telegram_username
            ? String(row.telegram_username)
            : null,
          telegram_display_name: row.telegram_display_name
            ? String(row.telegram_display_name)
            : null,
          bot_username: row.bot_username ? String(row.bot_username) : null,
          ...(row.project_uuid ? { project_uuid: String(row.project_uuid) } : {}),
          ...(row.project_name ? { project_name: String(row.project_name) } : {}),
          ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
        })),
      };
    },

    async unregisterSessionRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const localSessionId = this.requireText?.(input.local_session_id, "local_session_id");

      const deleted = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          client_uuid: clientUuid,
          local_session_id: localSessionId,
        })
        .del();

      return {
        local_session_id: localSessionId,
        deleted,
      };
    },

    async listProjectsRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const localSessionId = this.normalizeOptionalText?.(input.local_session_id);
      const scopeKey = resolveGatewayScopeKey(input);
      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members as m")
        .join("gateway_projects as p", "p.project_uuid", "m.project_uuid")
        .join("gateway_clients as c", "c.client_uuid", "m.client_uuid")
        .where("m.client_uuid", clientUuid)
        .where("m.status", "active")
        .where("p.is_active", true)
        .modify((query) => {
          if (localSessionId) {
            query.join("gateway_sessions as s", function joinProjectSession() {
              this.on("s.project_uuid", "=", "m.project_uuid")
                .andOn("s.client_uuid", "=", "m.client_uuid");
            });
            query.where("s.status", "active");
            query.where("s.local_session_id", localSessionId);
          }
          if (scopeKey) {
            query.where("c.scope_key", scopeKey);
          }
        })
        .select(
          "p.project_uuid",
          "p.name",
          "p.invite_token",
          "m.role",
          "m.status",
          "m.joined_at",
        )
        .orderBy("p.name", "asc");

      return {
        projects: rows.map((row: Record<string, unknown>) => ({
          project_uuid: row.project_uuid,
          name: row.name,
          invite_token: row.invite_token,
          role: row.role,
          status: row.status,
          ...(row.joined_at ? { joined_at: String(row.joined_at) } : {}),
        })),
      };
    },

    async leaveProjectRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const projectUuid = this.requireText?.(input.project_uuid, "project_uuid");

      const client = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_clients")
        .where({ client_uuid: clientUuid })
        .first();
      const membership = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          client_uuid: clientUuid,
          project_uuid: projectUuid,
        })
        .first();
      const project = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_projects")
        .where({ project_uuid: projectUuid })
        .first();

      const clientMeta = readClientMeta((client as Record<string, unknown>) ?? {});
      const memberDisplayName =
        this.normalizeOptionalText?.(membership?.display_name) ??
        this.normalizeOptionalText?.(clientMeta.telegram_display_name) ??
        null;
      const memberTelegramUsername =
        this.normalizeOptionalText?.(membership?.telegram_username) ??
        this.normalizeOptionalText?.(clientMeta.telegram_username) ??
        null;

      const updated = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          client_uuid: clientUuid,
          project_uuid: projectUuid,
        })
        .update({
          status: "left",
        });

      if (updated > 0) {
        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_sessions")
          .where({
            client_uuid: clientUuid,
            project_uuid: projectUuid,
          })
          .update({
            status: "inactive",
            updated_at: new Date().toISOString(),
          });
      }

      const notifyRows =
        updated > 0
          ? await this.db
              .withSchema(MCP_SCHEMA)
              .table("gateway_project_members")
              .where({
                project_uuid: projectUuid,
                status: "active",
              })
              .whereNot({
                client_uuid: clientUuid,
              })
              .distinct("client_uuid")
          : [];

      if (updated > 0 && notifyRows.length === 0) {
        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_projects")
          .where({ project_uuid: projectUuid })
          .update({
            is_active: false,
            updated_at: new Date().toISOString(),
          });
      }

      return {
        project_uuid: projectUuid,
        left: updated > 0,
        ...(project?.name ? { project_name: project.name } : {}),
        ...(notifyRows.length > 0
          ? {
              notify_client_uuids: notifyRows
                .map((row) => String(row.client_uuid))
                .filter(Boolean),
            }
          : {}),
        ...(memberDisplayName ? { member_display_name: memberDisplayName } : {}),
        ...(memberTelegramUsername
          ? { member_telegram_username: memberTelegramUsername }
          : {}),
      };
    },

    async deleteProjectRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const projectUuid = this.requireText?.(input.project_uuid, "project_uuid");

      const project = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_projects")
        .where({ project_uuid: projectUuid, is_active: true })
        .first();
      if (!project) {
        throw new Error("Project was not found or is already inactive.");
      }

      const ownerMembership = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          client_uuid: clientUuid,
          project_uuid: projectUuid,
          status: "active",
          role: "owner",
        })
        .first();
      if (!ownerMembership) {
        throw new Error("Only the project owner can delete this project.");
      }

      const notifyRows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          project_uuid: projectUuid,
          status: "active",
        })
        .distinct("client_uuid");

      const deleted = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_projects")
        .where({ project_uuid: projectUuid })
        .del();

      await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({ project_uuid: projectUuid })
        .update({
          status: "inactive",
          updated_at: new Date().toISOString(),
        });

      return {
        project_uuid: projectUuid,
        deleted: deleted > 0,
        ...(project.name ? { project_name: project.name } : {}),
        ...(notifyRows.length > 0
          ? {
              notify_client_uuids: notifyRows
                .map((row) => String(row.client_uuid))
                .filter(Boolean),
            }
          : {}),
      };
    },

    async listProjectSessionsRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const projectUuid = this.requireText?.(input.project_uuid, "project_uuid");

      const membership = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members")
        .where({
          client_uuid: clientUuid,
          project_uuid: projectUuid,
          status: "active",
        })
        .first();

      if (!membership) {
        throw new Error(
          `Client ${clientUuid} is not an active member of project ${projectUuid}`,
        );
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions as s")
        .distinctOn("s.client_uuid")
        .leftJoin("gateway_clients as c", "c.client_uuid", "s.client_uuid")
        .leftJoin("gateway_users as u", "u.gateway_user_uuid", "c.owner_user_uuid")
        .leftJoin("gateway_project_members as m", function joinMember() {
          this.on("m.project_uuid", "=", "s.project_uuid").andOn(
            "m.client_uuid",
            "=",
            "s.client_uuid",
          );
        })
        .where("s.project_uuid", projectUuid)
        .where("s.status", "active")
        .where("m.status", "active")
        .orderBy("s.client_uuid", "asc")
        .orderBy("s.created_at", "asc")
        .orderBy("s.updated_at", "desc")
        .select(
          "s.session_uuid",
          "s.project_uuid",
          "s.client_uuid",
          "s.local_session_id",
          "s.label",
          "s.status",
          "s.updated_at",
          "c.client_label",
          this.db.raw(
            "coalesce(nullif(u.telegram_display_name, ''), nullif(m.display_name, ''), nullif(c.meta->>'telegram_display_name', '')) as display_name",
          ),
          this.db.raw(
            "coalesce(nullif(u.telegram_username, ''), nullif(m.telegram_username, ''), nullif(c.meta->>'telegram_username', '')) as telegram_username",
          ),
          this.db.raw("nullif(c.meta->>'system_username', '') as system_username"),
          "c.bot_username",
          "m.joined_at",
        )
        .orderByRaw("coalesce(s.label, s.local_session_id) asc")
        .orderBy("s.updated_at", "desc");

      return {
        sessions: rows.map((row) => ({
          session_uuid: row.session_uuid,
          project_uuid: row.project_uuid,
          client_uuid: row.client_uuid,
          local_session_id: row.local_session_id,
          label: row.label ?? null,
          status: row.status,
          client_label: row.client_label ?? null,
          display_name: row.display_name ?? null,
          telegram_username: row.telegram_username ?? null,
          system_username: row.system_username ?? null,
          bot_username: row.bot_username ?? null,
          ...(row.joined_at ? { joined_at: String(row.joined_at) } : {}),
          ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
        })),
      };
    },

    async sendPartnerNoteRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const localSessionId = this.requireText?.(input.session_id, "session_id");
      const targetSessionId = this.requireText?.(
        input.target_session_id,
        "target_session_id",
      );
      const requestedProjectUuid = this.normalizeOptionalText?.(input.project_uuid);
      const kind = this.requireText?.(input.kind, "kind");
      const summary = this.requireText?.(input.summary, "summary");
      const message = this.requireText?.(input.message, "message");
      const expectedReply = this.normalizeOptionalText?.(input.expected_reply);
      const inReplyTo = this.normalizeOptionalText?.(input.in_reply_to);
      const requiresReply =
        typeof input.requires_reply === "boolean"
          ? input.requires_reply
          : kind === "question" || kind === "request";

      const targetSession = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions as s")
        .leftJoin("gateway_clients as c", "c.client_uuid", "s.client_uuid")
        .leftJoin("gateway_projects as p", "p.project_uuid", "s.project_uuid")
        .where({
          "s.session_uuid": targetSessionId,
          "s.status": "active",
        })
        .select(
          "s.*",
          "p.name as project_name",
          this.db.raw(
            "coalesce(nullif(c.meta->>'telegram_display_name', ''), nullif(c.meta->>'telegram_username', ''), c.client_label, c.bot_username) as target_actor_label",
          ),
        )
        .first();

      if (!targetSession) {
        throw new Error(`Target project session ${targetSessionId} was not found.`);
      }

      if (
        requestedProjectUuid &&
        requestedProjectUuid !== String(targetSession.project_uuid)
      ) {
        throw new Error("Target session does not belong to the requested project.");
      }

      const sourceSession = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          project_uuid: String(targetSession.project_uuid),
          client_uuid: clientUuid,
          local_session_id: localSessionId,
          status: "active",
        })
        .first();

      if (!sourceSession) {
        throw new Error(
          `Active project session '${localSessionId}' is not registered for client ${clientUuid} in project ${targetSession.project_uuid}.`,
        );
      }

      const shareId = randomUUID();
      const messageUuid = randomUUID();
      const deliveryUuid = randomUUID();
      const now = new Date().toISOString();
      const resolvedInReplyTo = await resolveGatewayInReplyTo(inReplyTo ?? undefined, {
        findMessageUuidByMessageUuid: async (messageUuid) => {
          const directReplyTarget = await this.db
            .withSchema(MCP_SCHEMA)
            .table("gateway_messages")
            .where({ message_uuid: messageUuid })
            .select("message_uuid")
            .first();

          return directReplyTarget?.message_uuid
            ? String(directReplyTarget.message_uuid)
            : undefined;
        },
        findMessageUuidByShareId: async (shareId) => {
          const shareReplyTarget = await this.db
            .withSchema(MCP_SCHEMA)
            .table("gateway_messages")
            .whereRaw("meta->>'share_id' = ?", [shareId])
            .select("message_uuid")
            .orderBy("created_at", "desc")
            .first();

          return shareReplyTarget?.message_uuid
            ? String(shareReplyTarget.message_uuid)
            : undefined;
        },
      });

      await this.db.withSchema(MCP_SCHEMA).table("gateway_messages").insert({
        message_uuid: messageUuid,
        project_uuid: sourceSession.project_uuid,
        from_session_uuid: sourceSession.session_uuid,
        to_session_uuid: targetSession.session_uuid,
        kind,
        summary,
        body: message,
        ...(expectedReply ? { expected_reply: expectedReply } : {}),
        ...(resolvedInReplyTo ? { in_reply_to: resolvedInReplyTo } : {}),
        requires_reply: requiresReply,
        meta: this.db.raw(`?::jsonb`, [JSON.stringify({ share_id: shareId })]),
        created_at: now,
      });

      const artifactRefs = Array.isArray(input.artifact_refs)
        ? (input.artifact_refs as PartnerArtifactRef[])
        : [];
      const usedArtifactNames = new Set<string>();
      const queuedArtifacts: Array<{
        artifact_uuid: string;
        original_name: string;
        mime_type?: string;
        size_bytes?: number;
        storage_ref?: string;
        relative_path: string;
        content_base64?: string;
      }> = [];

      for (const artifact of artifactRefs) {
        const originalName =
          trimOptionalText(artifact.original_name) ||
          trimOptionalText(artifact.relative_path) ||
          trimOptionalText(artifact.file_path) ||
          "file";
        const relativePath = allocateArtifactRelativePath(
          shareId,
          path.basename(originalName),
          usedArtifactNames,
        );
        const mimeType = trimOptionalText(artifact.mime_type) ?? undefined;
        const storageRef = trimOptionalText(artifact.storage_ref) ?? undefined;
        const contentBase64 =
          trimOptionalText(artifact.content_base64) ?? undefined;
        const queuedArtifact = {
          artifact_uuid: randomUUID(),
          original_name: path.basename(originalName),
          ...(mimeType ? { mime_type: mimeType } : {}),
          ...(typeof artifact.size_bytes === "number"
            ? { size_bytes: artifact.size_bytes }
            : {}),
          ...(storageRef ? { storage_ref: storageRef } : {}),
          relative_path: relativePath,
          ...(contentBase64 ? { content_base64: contentBase64 } : {}),
        };
        queuedArtifacts.push(queuedArtifact);

        await this.db.withSchema(MCP_SCHEMA).table("gateway_message_artifacts").insert({
          artifact_uuid: queuedArtifact.artifact_uuid,
          message_uuid: messageUuid,
          original_name: queuedArtifact.original_name,
          ...(queuedArtifact.mime_type
            ? { mime_type: queuedArtifact.mime_type }
            : {}),
          ...(typeof queuedArtifact.size_bytes === "number"
            ? { size_bytes: queuedArtifact.size_bytes }
            : {}),
          ...(queuedArtifact.storage_ref
            ? { storage_ref: queuedArtifact.storage_ref }
            : {}),
          relative_path: relativePath,
          meta: this.db.raw(`?::jsonb`, [
            JSON.stringify({
              file_path: trimOptionalText(artifact.file_path),
              relative_path: trimOptionalText(artifact.relative_path),
              content_base64: trimOptionalText(artifact.content_base64),
            }),
          ]),
          created_at: now,
        });
      }

      await this.db.withSchema(MCP_SCHEMA).table("gateway_deliveries").insert({
        delivery_uuid: deliveryUuid,
        message_uuid: messageUuid,
        target_client_uuid: targetSession.client_uuid,
        target_session_uuid: targetSession.session_uuid,
        status: "queued",
        attempt_count: 0,
        available_at: now,
        created_at: now,
      });

      return {
        session_id: localSessionId,
        partner_session_id: targetSession.session_uuid,
        ...(targetSession.project_name
          ? { project_name: targetSession.project_name }
          : {}),
        ...(targetSession.target_actor_label
          ? { target_actor_label: targetSession.target_actor_label }
          : {}),
        ...(targetSession.label
          ? { target_session_label: targetSession.label }
          : {}),
        kind: kind as SendPartnerNoteOutput["kind"],
        share_id: shareId,
        delivery_status: "queued",
        note_path: `gateway://shares/${shareId}.md`,
        xchange_record_id: shareId,
        copied_artifacts: artifactRefs.map((artifact) =>
          trimOptionalText(artifact.original_name) ||
          trimOptionalText(artifact.relative_path) ||
          trimOptionalText(artifact.file_path) ||
          "file",
        ),
        inbox_message_id: deliveryUuid,
        requires_reply: requiresReply,
        delivery_uuid: deliveryUuid,
        target_client_uuid: targetSession.client_uuid,
        delivery: {
          delivery_uuid: deliveryUuid,
          message_uuid: messageUuid,
          share_id: shareId,
          ...(targetSession.project_name
            ? { project_name: targetSession.project_name }
            : {}),
          source_actor_label:
            sourceSession.label ?? sourceSession.local_session_id,
          kind,
          summary,
          message,
          ...(expectedReply ? { expected_reply: expectedReply } : {}),
          requires_reply: requiresReply,
          ...(resolvedInReplyTo ? { in_reply_to: resolvedInReplyTo } : {}),
          source_session_uuid: sourceSession.session_uuid,
          source_session_label:
            sourceSession.label ?? sourceSession.local_session_id,
          source_local_session_id: sourceSession.local_session_id,
          target_session_uuid: targetSession.session_uuid,
          target_local_session_id: targetSession.local_session_id,
          target_session_label:
            targetSession.label ?? targetSession.local_session_id,
          created_at: now,
          note_relative_path: `shares/${shareId}.md`,
          artifacts: queuedArtifacts,
        },
      };
    },

    async pollDeliveriesRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(50, Math.trunc(input.limit)))
          : 20;

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries as d")
        .join("gateway_messages as m", "m.message_uuid", "d.message_uuid")
        .join("gateway_projects as p", "p.project_uuid", "m.project_uuid")
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .join("gateway_sessions as s_to", "s_to.session_uuid", "m.to_session_uuid")
        .leftJoin("gateway_clients as c_from", "c_from.client_uuid", "s_from.client_uuid")
        .where("d.target_client_uuid", clientUuid)
        .where("d.status", "queued")
        .where("d.available_at", "<=", this.db.fn.now())
        .select(
          "d.delivery_uuid",
          "d.message_uuid",
          "p.project_uuid",
          "m.kind",
          "m.summary",
          "m.body",
          "m.expected_reply",
          "m.requires_reply",
          "m.in_reply_to",
          "m.meta",
          "m.created_at",
          "p.name as project_name",
          this.db.raw(
            "coalesce(nullif(c_from.meta->>'telegram_display_name', ''), nullif(c_from.meta->>'telegram_username', ''), c_from.client_label, c_from.bot_username) as source_actor_label",
          ),
          "s_from.session_uuid as source_session_uuid",
          "s_from.local_session_id as source_local_session_id",
          "s_from.label as source_session_label",
          "s_to.session_uuid as target_session_uuid",
          "s_to.local_session_id as target_local_session_id",
          "s_to.label as target_session_label",
        )
        .orderBy("m.created_at", "asc")
        .limit(limit);

      const messageIds = rows.map((row) => row.message_uuid);
      const artifactRows = messageIds.length
        ? await this.db
            .withSchema(MCP_SCHEMA)
            .table("gateway_message_artifacts")
            .whereIn("message_uuid", messageIds)
            .select(
              "artifact_uuid",
              "message_uuid",
              "original_name",
              "mime_type",
              "size_bytes",
              "storage_ref",
              "relative_path",
              "meta",
            )
            .orderBy("created_at", "asc")
        : [];

      const artifactsByMessage = new Map<string, Array<{
        artifact_uuid: string;
        original_name: string;
        mime_type?: string;
        size_bytes?: number;
        storage_ref?: string;
        relative_path?: string;
        content_base64?: string;
      }>>();

      for (const artifact of artifactRows) {
        const meta =
          artifact.meta && typeof artifact.meta === "object" ? artifact.meta : {};
        const list = artifactsByMessage.get(artifact.message_uuid) ?? [];
        list.push({
          artifact_uuid: artifact.artifact_uuid,
          original_name: artifact.original_name,
          ...(artifact.mime_type ? { mime_type: artifact.mime_type } : {}),
          ...(typeof artifact.size_bytes === "number"
            ? { size_bytes: Number(artifact.size_bytes) }
            : {}),
          ...(artifact.storage_ref ? { storage_ref: artifact.storage_ref } : {}),
          ...(artifact.relative_path ? { relative_path: artifact.relative_path } : {}),
          ...(typeof (meta as { content_base64?: unknown }).content_base64 === "string"
            ? {
                content_base64: (meta as { content_base64: string }).content_base64,
              }
            : {}),
        });
        artifactsByMessage.set(artifact.message_uuid, list);
      }

      return {
        deliveries: rows.map((row) => {
          const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
          const shareId =
            typeof (meta as { share_id?: unknown }).share_id === "string"
              ? (meta as { share_id: string }).share_id
              : row.message_uuid;
          return {
            delivery_uuid: row.delivery_uuid,
            message_uuid: row.message_uuid,
            share_id: shareId,
            ...(row.project_uuid ? { project_uuid: row.project_uuid } : {}),
            ...(row.project_name ? { project_name: row.project_name } : {}),
            ...(row.source_actor_label
              ? { source_actor_label: row.source_actor_label }
              : {}),
            kind: row.kind,
            summary: row.summary,
            message: row.body,
            ...(row.expected_reply ? { expected_reply: row.expected_reply } : {}),
            requires_reply: Boolean(row.requires_reply),
            ...(row.in_reply_to ? { in_reply_to: row.in_reply_to } : {}),
            source_session_uuid: row.source_session_uuid,
            source_session_label:
              row.source_session_label ?? row.source_local_session_id,
            source_local_session_id: row.source_local_session_id,
            target_session_uuid: row.target_session_uuid,
            target_local_session_id: row.target_local_session_id,
            target_session_label:
              row.target_session_label ?? row.target_local_session_id,
            created_at: String(row.created_at),
            note_relative_path: `shares/${shareId}.md`,
            artifacts: artifactsByMessage.get(row.message_uuid) ?? [],
          };
        }),
      };
    },

    async ackDeliveriesRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const deliveryIds = Array.isArray(input.delivery_ids)
        ? input.delivery_ids
            .map((item) => this.normalizeOptionalText?.(item))
            .filter((item): item is string => Boolean(item))
        : [];

      if (deliveryIds.length === 0) {
        throw new Error("delivery_ids must contain at least one id");
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries as d")
        .join("gateway_messages as m", "m.message_uuid", "d.message_uuid")
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .where("d.target_client_uuid", clientUuid)
        .whereIn("d.delivery_uuid", deliveryIds)
        .select(
          "d.delivery_uuid",
          "d.delivered_at",
          "d.acked_at",
          "s_from.client_uuid as source_client_uuid",
          this.db.raw(`coalesce(m.meta->>'share_id', '') as share_id`),
        );

      const updated = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries")
        .where("target_client_uuid", clientUuid)
        .whereIn("delivery_uuid", deliveryIds)
        .update({
          status: "delivered",
          acked_at: new Date().toISOString(),
        });

      return {
        acked: updated,
        deliveries: rows.map((row) => ({
          delivery_uuid: row.delivery_uuid,
          share_id: String(row.share_id || ""),
          status: "delivered",
          source_client_uuid: row.source_client_uuid,
          ...(row.delivered_at ? { delivered_at: String(row.delivered_at) } : {}),
          acked_at: new Date().toISOString(),
        })),
      };
    },

    async failDeliveriesRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const deliveryIds = Array.isArray(input.delivery_ids)
        ? input.delivery_ids
            .map((item) => this.normalizeOptionalText?.(item))
            .filter((item): item is string => Boolean(item))
        : [];
      const errorText = this.normalizeOptionalText?.(input.error_text);

      if (deliveryIds.length === 0) {
        throw new Error("delivery_ids must contain at least one id");
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries as d")
        .join("gateway_messages as m", "m.message_uuid", "d.message_uuid")
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .where("d.target_client_uuid", clientUuid)
        .whereIn("d.delivery_uuid", deliveryIds)
        .select(
          "d.delivery_uuid",
          "d.delivered_at",
          "d.acked_at",
          "s_from.client_uuid as source_client_uuid",
          this.db.raw(`coalesce(m.meta->>'share_id', '') as share_id`),
        );

      const updated = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries")
        .where("target_client_uuid", clientUuid)
        .whereIn("delivery_uuid", deliveryIds)
        .update({
          status: "failed",
          ...(errorText ? { last_error: errorText } : {}),
          acked_at: new Date().toISOString(),
        });

      return {
        failed: updated,
        deliveries: rows.map((row) => ({
          delivery_uuid: row.delivery_uuid,
          share_id: String(row.share_id || ""),
          status: "failed",
          source_client_uuid: row.source_client_uuid,
          ...(row.delivered_at ? { delivered_at: String(row.delivered_at) } : {}),
          acked_at: new Date().toISOString(),
        })),
      };
    },

    async listSenderDeliveryStatusesRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(200, Math.trunc(input.limit)))
          : 100;

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries as d")
        .join("gateway_messages as m", "m.message_uuid", "d.message_uuid")
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .where("s_from.client_uuid", clientUuid)
        .whereIn("d.status", ["delivered", "failed"])
        .select(
          "d.delivery_uuid",
          "d.status",
          "d.delivered_at",
          "d.acked_at",
          this.db.raw(`coalesce(m.meta->>'share_id', '') as share_id`),
        )
        .orderBy("d.acked_at", "desc")
        .limit(limit);

      return {
        deliveries: rows.map((row) => ({
          delivery_uuid: row.delivery_uuid,
          share_id: String(row.share_id || ""),
          status: row.status,
          ...(row.delivered_at ? { delivered_at: String(row.delivered_at) } : {}),
          ...(row.acked_at ? { acked_at: String(row.acked_at) } : {}),
        })),
      };
    },

    async listSessionHistoryRecord(
      this: GatewayServiceCarrier,
      input: Record<string, unknown>,
    ) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const localSessionId = this.requireText?.(
        input.local_session_id,
        "local_session_id",
      );
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(20, Math.trunc(input.limit)))
          : 5;

      const sessionRows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          client_uuid: clientUuid,
          local_session_id: localSessionId,
          status: "active",
        })
        .select("session_uuid");

      const sessionUuids = sessionRows
        .map((row) => this.normalizeOptionalText?.(row.session_uuid))
        .filter((row): row is string => Boolean(row));

      if (sessionUuids.length === 0) {
        return { history: [] };
      }

      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_messages as m")
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .join("gateway_sessions as s_to", "s_to.session_uuid", "m.to_session_uuid")
        .leftJoin("gateway_projects as p", "p.project_uuid", "m.project_uuid")
        .leftJoin("gateway_deliveries as d", "d.message_uuid", "m.message_uuid")
        .where((builder) => {
          builder
            .whereIn("m.from_session_uuid", sessionUuids)
            .orWhereIn("m.to_session_uuid", sessionUuids);
        })
        .select(
          "m.message_uuid",
          "m.kind",
          "m.summary",
          "m.created_at",
          "p.project_uuid",
          "p.name as project_name",
          "s_from.session_uuid as from_session_uuid",
          "s_from.local_session_id as from_local_session_id",
          "s_from.label as from_session_label",
          "s_to.session_uuid as to_session_uuid",
          "s_to.local_session_id as to_local_session_id",
          "s_to.label as to_session_label",
          "d.status as delivery_status",
        )
        .orderBy("m.created_at", "desc")
        .limit(limit);

      const currentSessionSet = new Set(sessionUuids);

      return {
        history: rows.map((row) => {
          const outgoing = currentSessionSet.has(String(row.from_session_uuid));
          return {
            message_uuid: String(row.message_uuid),
            kind: String(row.kind),
            summary: String(row.summary || ""),
            created_at: String(row.created_at),
            direction: outgoing ? "outgoing" : "incoming",
            ...(row.project_uuid ? { project_uuid: String(row.project_uuid) } : {}),
            ...(row.project_name ? { project_name: String(row.project_name) } : {}),
            from_session_id: String(row.from_local_session_id),
            from_label: String(row.from_session_label || row.from_local_session_id),
            to_session_id: String(row.to_local_session_id),
            to_label: String(row.to_session_label || row.to_local_session_id),
            ...(row.delivery_status
              ? { delivery_status: String(row.delivery_status) }
              : {}),
          };
        }),
      };
    },
  },

  actions: {
    upsertGatewayUser: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.upsertGatewayUserRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    resolveGatewayUserRoute: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.resolveGatewayUserRouteRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    registerClient: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.registerClientRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    createProject: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.createProjectRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    joinProject: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.joinProjectRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    registerSession: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.registerSessionRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listClients: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listClientsRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listClientSessions: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listClientSessionsRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listAllSessions: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listAllSessionsRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    unregisterSession: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.unregisterSessionRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listProjects: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listProjectsRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    leaveProject: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.leaveProjectRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    deleteProject: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.deleteProjectRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listProjectSessions: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listProjectSessionsRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listSessionHistory: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listSessionHistoryRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    sendPartnerNote: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.sendPartnerNoteRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    pollDeliveries: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.pollDeliveriesRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    ackDeliveries: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.ackDeliveriesRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    failDeliveries: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.failDeliveriesRecord?.(ctx.params as Record<string, unknown>);
      },
    },
    listSenderDeliveryStatuses: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listSenderDeliveryStatusesRecord?.(ctx.params as Record<string, unknown>);
      },
    },
  },
};

export default TelegramMcpGatewayService;
