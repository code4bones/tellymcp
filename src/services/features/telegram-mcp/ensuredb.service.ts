import type { Service, ServiceSchema } from "moleculer";

import { DBMixin } from "@src/lib/mixins/db";

export const TELEGRAM_MCP_ENSUREDB_SERVICE_NAME = "telegramMcp.ensuredb";
const DISTRIBUTED_MODE = process.env.DISTRIBUTED_MODE || "client";
const GATEWAY_ENABLED =
  DISTRIBUTED_MODE === "gateway" || DISTRIBUTED_MODE === "both";

type EnsureDbServiceCarrier = Service & {
  ensureGatewaySchema?: () => Promise<void>;
};

const MCP_SCHEMA = process.env.DB_SCHEME || "mcp";

const TelegramMcpEnsureDbService: ServiceSchema = {
  name: TELEGRAM_MCP_ENSUREDB_SERVICE_NAME,
  mixins: [DBMixin],

  methods: {
    async ensureGatewaySchema(this: EnsureDbServiceCarrier): Promise<void> {
      await this.db.raw(`create schema if not exists "${MCP_SCHEMA}"`);

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_users"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_users", (table) => {
          table.uuid("gateway_user_uuid").primary();
          table.bigInteger("telegram_user_id").notNullable().unique();
          table.bigInteger("telegram_chat_id");
          table.text("telegram_username");
          table.text("telegram_display_name");
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .timestamp("updated_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table.timestamp("last_auth_at", { useTz: true });
        });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_clients"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_clients", (table) => {
          table.uuid("client_uuid").primary();
          table.uuid("owner_user_uuid");
          table.text("scope_key");
          table.text("client_label");
          table.text("bot_token_fingerprint");
          table.text("bot_username");
          table.jsonb("meta").notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .timestamp("updated_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table.timestamp("last_seen_at", { useTz: true });
          table
            .foreign("owner_user_uuid")
            .references("gateway_user_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_users`)
            .onDelete("SET NULL");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_clients")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_clients",
          "owner_user_uuid",
        ))
      ) {
        await this.db.schema.withSchema(MCP_SCHEMA).alterTable("gateway_clients", (table) => {
          table.uuid("owner_user_uuid");
          table
            .foreign("owner_user_uuid")
            .references("gateway_user_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_users`)
            .onDelete("SET NULL");
        });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_projects"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_projects", (table) => {
          table.uuid("project_uuid").primary();
          table.text("name").notNullable();
          table.text("invite_token").notNullable().unique();
          table
            .uuid("created_by_client_uuid")
            .references("client_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_clients`)
            .onDelete("RESTRICT");
          table.bigInteger("owner_telegram_user_id");
          table.text("owner_telegram_username");
          table.text("owner_display_name");
          table.boolean("is_active").notNullable().defaultTo(true);
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .timestamp("updated_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
        });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_project_members"))) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .createTable("gateway_project_members", (table) => {
            table.uuid("project_uuid").notNullable();
            table.uuid("client_uuid").notNullable();
            table.text("role").notNullable().defaultTo("member");
            table.text("status").notNullable().defaultTo("active");
            table.bigInteger("telegram_user_id");
            table.text("telegram_username");
            table.text("display_name");
            table
              .timestamp("joined_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table.primary(["project_uuid", "client_uuid"]);
            table
              .foreign("project_uuid")
              .references("project_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_projects`)
              .onDelete("CASCADE");
            table
              .foreign("client_uuid")
              .references("client_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_clients`)
              .onDelete("CASCADE");
          });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_project_consoles"))) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .createTable("gateway_project_consoles", (table) => {
            table.uuid("project_console_uuid").primary();
            table.uuid("project_uuid").notNullable();
            table.uuid("client_uuid").notNullable();
            table.text("local_session_id").notNullable();
            table.uuid("gateway_session_uuid");
            table.text("status").notNullable().defaultTo("active");
            table
              .timestamp("joined_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .timestamp("updated_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .foreign("project_uuid")
              .references("project_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_projects`)
              .onDelete("CASCADE");
            table
              .foreign("client_uuid")
              .references("client_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_clients`)
              .onDelete("CASCADE");
            table
              .foreign("gateway_session_uuid")
              .references("session_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_sessions`)
              .onDelete("SET NULL");
            table.unique(
              ["project_uuid", "client_uuid", "local_session_id"],
              "gateway_project_consoles_project_client_local_unique",
            );
            table.index(["project_uuid"], "gateway_project_consoles_project_idx");
            table.index(["client_uuid"], "gateway_project_consoles_client_idx");
          });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_live_consoles"))) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .createTable("gateway_live_consoles", (table) => {
            table.uuid("live_console_uuid").primary();
            table.uuid("client_uuid").notNullable();
            table.text("connection_id").notNullable();
            table.text("local_session_id").notNullable();
            table.text("session_label");
            table.text("cwd");
            table.text("tools_hash");
            table.uuid("gateway_user_uuid");
            table.text("client_label");
            table.text("system_username");
            table.text("namespace");
            table.text("node_id");
            table.text("package_version");
            table.text("protocol_version");
            table.jsonb("meta").notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
            table
              .timestamp("connected_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .timestamp("last_seen_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .foreign("client_uuid")
              .references("client_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_clients`)
              .onDelete("CASCADE");
            table
              .foreign("gateway_user_uuid")
              .references("gateway_user_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_users`)
              .onDelete("SET NULL");
            table.unique(
              ["client_uuid", "local_session_id"],
              "gateway_live_consoles_client_local_unique",
            );
            table.index(["connection_id"], "gateway_live_consoles_connection_idx");
            table.index(["client_uuid"], "gateway_live_consoles_client_idx");
            table.index(["gateway_user_uuid"], "gateway_live_consoles_owner_idx");
          });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_sessions"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_sessions", (table) => {
          table.uuid("session_uuid").primary();
          table.uuid("client_uuid").notNullable();
          table.text("local_session_id").notNullable();
          table.text("label");
          table.text("cwd");
          table.text("terminal_target");
          table.text("status").notNullable().defaultTo("active");
          table.jsonb("meta").notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .timestamp("updated_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .foreign("client_uuid")
            .references("client_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_clients`)
            .onDelete("CASCADE");
          table.unique(
            ["client_uuid", "local_session_id"],
            "gateway_sessions_client_local_unique",
          );
          table.index(["client_uuid"], "gateway_sessions_client_idx");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_clients")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_clients",
          "scope_key",
        ))
      ) {
        await this.db.schema.withSchema(MCP_SCHEMA).alterTable("gateway_clients", (table) => {
          table.text("scope_key");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_projects")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_projects",
          "owner_telegram_user_id",
        ))
      ) {
        await this.db.schema.withSchema(MCP_SCHEMA).alterTable("gateway_projects", (table) => {
          table.bigInteger("owner_telegram_user_id");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_projects")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_projects",
          "owner_telegram_username",
        ))
      ) {
        await this.db.schema.withSchema(MCP_SCHEMA).alterTable("gateway_projects", (table) => {
          table.text("owner_telegram_username");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_projects")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_projects",
          "owner_display_name",
        ))
      ) {
        await this.db.schema.withSchema(MCP_SCHEMA).alterTable("gateway_projects", (table) => {
          table.text("owner_display_name");
        });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_project_members")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_project_members",
          "telegram_user_id",
        ))
      ) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .alterTable("gateway_project_members", (table) => {
            table.bigInteger("telegram_user_id");
          });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_project_members")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_project_members",
          "telegram_username",
        ))
      ) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .alterTable("gateway_project_members", (table) => {
            table.text("telegram_username");
          });
      }

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_project_members")) &&
        !(await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_project_members",
          "display_name",
        ))
      ) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .alterTable("gateway_project_members", (table) => {
            table.text("display_name");
          });
      }

      await this.db.raw(
        `
        CREATE INDEX IF NOT EXISTS gateway_clients_scope_idx
        ON "${MCP_SCHEMA}"."gateway_clients" ("scope_key")
        `,
      );

      await this.db.raw(
        `
        CREATE INDEX IF NOT EXISTS gateway_clients_owner_user_idx
        ON "${MCP_SCHEMA}"."gateway_clients" ("owner_user_uuid")
        `,
      );

      await this.db.raw(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS gateway_live_consoles_client_local_unique
        ON "${MCP_SCHEMA}"."gateway_live_consoles" ("client_uuid", "local_session_id")
        `,
      );

      await this.db.raw(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS gateway_sessions_client_local_unique
        ON "${MCP_SCHEMA}"."gateway_sessions" ("client_uuid", "local_session_id")
        `,
      );

      if (
        (await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_sessions")) &&
        (await this.db.schema.withSchema(MCP_SCHEMA).hasColumn(
          "gateway_sessions",
          "project_uuid",
        ))
      ) {
        await this.db.raw(
          `
          ALTER TABLE "${MCP_SCHEMA}"."gateway_sessions"
          ALTER COLUMN "project_uuid" DROP NOT NULL
          `,
        );
      }

      await this.db.raw(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS gateway_project_consoles_project_client_local_unique
        ON "${MCP_SCHEMA}"."gateway_project_consoles" ("project_uuid", "client_uuid", "local_session_id")
        `,
      );


      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_session_links"))) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .createTable("gateway_session_links", (table) => {
            table.uuid("link_uuid").primary();
            table.uuid("project_uuid").notNullable();
            table.uuid("left_session_uuid").notNullable();
            table.uuid("right_session_uuid").notNullable();
            table.text("status").notNullable().defaultTo("active");
            table
              .timestamp("created_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .foreign("project_uuid")
              .references("project_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_projects`)
              .onDelete("CASCADE");
            table
              .foreign("left_session_uuid")
              .references("session_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_sessions`)
              .onDelete("CASCADE");
            table
              .foreign("right_session_uuid")
              .references("session_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_sessions`)
              .onDelete("CASCADE");
            table.unique(["left_session_uuid", "right_session_uuid"]);
            table.index(["project_uuid"], "gateway_session_links_project_idx");
          });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_messages"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_messages", (table) => {
          table.uuid("message_uuid").primary();
          table.uuid("project_uuid").notNullable();
          table.uuid("from_session_uuid").notNullable();
          table.uuid("to_session_uuid").notNullable();
          table.text("kind").notNullable();
          table.text("summary").notNullable();
          table.text("body").notNullable();
          table.text("expected_reply");
          table.boolean("requires_reply").notNullable().defaultTo(false);
          table.uuid("in_reply_to");
          table.jsonb("meta").notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .foreign("project_uuid")
            .references("project_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_projects`)
            .onDelete("CASCADE");
          table
            .foreign("from_session_uuid")
            .references("session_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_sessions`)
            .onDelete("CASCADE");
          table
            .foreign("to_session_uuid")
            .references("session_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_sessions`)
            .onDelete("CASCADE");
          table
            .foreign("in_reply_to")
            .references("message_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_messages`)
            .onDelete("SET NULL");
          table.index(["to_session_uuid", "created_at"], "gateway_messages_target_idx");
        });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_message_artifacts"))) {
        await this.db.schema
          .withSchema(MCP_SCHEMA)
          .createTable("gateway_message_artifacts", (table) => {
            table.uuid("artifact_uuid").primary();
            table.uuid("message_uuid").notNullable();
            table.text("original_name").notNullable();
            table.text("mime_type");
            table.bigInteger("size_bytes");
            table.text("storage_ref");
            table.text("public_url");
            table.text("relative_path");
            table.jsonb("meta").notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
            table
              .timestamp("created_at", { useTz: true })
              .notNullable()
              .defaultTo(this.db.fn.now());
            table
              .foreign("message_uuid")
              .references("message_uuid")
              .inTable(`${MCP_SCHEMA}.gateway_messages`)
              .onDelete("CASCADE");
            table.index(["message_uuid"], "gateway_message_artifacts_message_idx");
          });
      }

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_deliveries"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_deliveries", (table) => {
          table.uuid("delivery_uuid").primary();
          table.uuid("message_uuid").notNullable();
          table.uuid("target_client_uuid").notNullable();
          table.uuid("target_session_uuid").notNullable();
          table.text("status").notNullable().defaultTo("pending");
          table.integer("attempt_count").notNullable().defaultTo(0);
          table.text("last_error");
          table
            .timestamp("available_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table.timestamp("delivered_at", { useTz: true });
          table.timestamp("acked_at", { useTz: true });
          table
            .timestamp("created_at", { useTz: true })
            .notNullable()
            .defaultTo(this.db.fn.now());
          table
            .foreign("message_uuid")
            .references("message_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_messages`)
            .onDelete("CASCADE");
          table
            .foreign("target_client_uuid")
            .references("client_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_clients`)
            .onDelete("CASCADE");
          table
            .foreign("target_session_uuid")
            .references("session_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_sessions`)
            .onDelete("CASCADE");
          table.index(
            ["target_client_uuid", "status", "available_at"],
            "gateway_deliveries_poll_idx",
          );
        });
      }
    },
  },

  async started(this: EnsureDbServiceCarrier) {
    if (!GATEWAY_ENABLED) {
      this.logger.info("Skipping telegram_mcp gateway database bootstrap", {
        mode: DISTRIBUTED_MODE,
      });
      return;
    }

    this.logger.info("Ensuring telegram_mcp gateway database schema", {
      schema: MCP_SCHEMA,
    });
    await this.ensureGatewaySchema?.();
    this.logger.info("telegram_mcp gateway database schema is ready", {
      schema: MCP_SCHEMA,
    });
  },
};

export default TelegramMcpEnsureDbService;
