import { randomUUID } from "node:crypto";

import type { Service, ServiceSchema } from "moleculer";

import { DBMixin } from "@src/lib/mixins/db";
import { TELEGRAM_MCP_ENSUREDB_SERVICE_NAME } from "./ensuredb.service";

export const TELEGRAM_MCP_GATEWAY_SERVICE_NAME = "telegramMcp.gateway";

const MCP_SCHEMA = process.env.DB_SCHEME || "mcp";
const DISTRIBUTED_MODE = process.env.DISTRIBUTED_MODE || "client";
const GATEWAY_ENABLED =
  DISTRIBUTED_MODE === "gateway" || DISTRIBUTED_MODE === "both";

type GatewayServiceCarrier = Service & {
  normalizeOptionalText?: (value: unknown) => string | null;
  requireText?: (value: unknown, fieldName: string) => string;
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
};

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

    async registerClientRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid =
        this.normalizeOptionalText?.(input.client_uuid) || randomUUID();
      const now = new Date().toISOString();
      const clientLabel = this.normalizeOptionalText?.(input.client_label);
      const botUsername = this.normalizeOptionalText?.(input.bot_username);
      const tokenFingerprint = this.normalizeOptionalText?.(input.bot_token_fingerprint);
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
        await this.db
          .withSchema(MCP_SCHEMA)
          .table("gateway_clients")
          .where({ client_uuid: clientUuid })
          .update({
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

      const projectUuid = randomUUID();
      const inviteToken = randomUUID();
      const now = new Date().toISOString();

      await this.db.withSchema(MCP_SCHEMA).table("gateway_projects").insert({
        project_uuid: projectUuid,
        name,
        invite_token: inviteToken,
        created_by_client_uuid: clientUuid,
        is_active: true,
        created_at: now,
        updated_at: now,
      });

      await this.db.withSchema(MCP_SCHEMA).table("gateway_project_members").insert({
        project_uuid: projectUuid,
        client_uuid: clientUuid,
        role: "owner",
        status: "active",
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

      const project = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_projects")
        .where({ invite_token: inviteToken, is_active: true })
        .first();
      if (!project) {
        throw new Error("Project invite token is invalid or inactive");
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
              joined_at: new Date().toISOString(),
            });
        }

        return {
          project_uuid: project.project_uuid,
          invite_token: project.invite_token,
          name: project.name,
          joined: false,
        };
      }

      await this.db.withSchema(MCP_SCHEMA).table("gateway_project_members").insert({
        project_uuid: project.project_uuid,
        client_uuid: clientUuid,
        role: "member",
        status: "active",
        joined_at: new Date().toISOString(),
      });

      return {
        project_uuid: project.project_uuid,
        invite_token: project.invite_token,
        name: project.name,
        joined: true,
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
          .where({ session_uuid: existing.session_uuid })
          .update(payload);

        return {
          session_uuid: existing.session_uuid,
          created: false,
          updated_at: now,
        };
      }

      const sessionUuid = randomUUID();
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
  },

  actions: {
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
  },
};

export default TelegramMcpGatewayService;
