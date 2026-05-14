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

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_clients"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_clients", (table) => {
          table.uuid("client_uuid").primary();
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

      if (!(await this.db.schema.withSchema(MCP_SCHEMA).hasTable("gateway_sessions"))) {
        await this.db.schema.withSchema(MCP_SCHEMA).createTable("gateway_sessions", (table) => {
          table.uuid("session_uuid").primary();
          table.uuid("project_uuid").notNullable();
          table.uuid("client_uuid").notNullable();
          table.text("local_session_id").notNullable();
          table.text("label");
          table.text("cwd");
          table.text("tmux_session_name");
          table.text("tmux_window_name");
          table.integer("tmux_window_index");
          table.text("tmux_pane_id");
          table.integer("tmux_pane_index");
          table.text("tmux_target");
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
            .foreign("project_uuid")
            .references("project_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_projects`)
            .onDelete("CASCADE");
          table
            .foreign("client_uuid")
            .references("client_uuid")
            .inTable(`${MCP_SCHEMA}.gateway_clients`)
            .onDelete("CASCADE");
          table.unique(["client_uuid", "local_session_id"]);
          table.index(["project_uuid"], "gateway_sessions_project_idx");
          table.index(["client_uuid"], "gateway_sessions_client_idx");
        });
      }

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
