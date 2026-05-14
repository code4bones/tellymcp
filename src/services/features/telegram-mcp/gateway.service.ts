import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Service, ServiceSchema } from "moleculer";

import { DBMixin } from "@src/lib/mixins/db";
import type {
  PartnerArtifactRef,
  SendPartnerNoteOutput,
} from "./src/entities/collaboration/model/types";
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
      bot_username: string | null;
      joined_at?: string;
      updated_at?: string;
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
      share_index_file_name: string;
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
};

function trimOptionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text ? text : null;
}

function sanitizeArtifactName(value: string): string {
  return value
    .trim()
    .replace(/[\/\\]+/gu, "-")
    .replace(/[\x00-\x1f]+/gu, "-")
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

    async listProjectsRecord(this: GatewayServiceCarrier, input: Record<string, unknown>) {
      const clientUuid = this.requireText?.(input.client_uuid, "client_uuid");
      const rows = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_project_members as m")
        .join("gateway_projects as p", "p.project_uuid", "m.project_uuid")
        .where("m.client_uuid", clientUuid)
        .where("m.status", "active")
        .where("p.is_active", true)
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
        projects: rows.map((row) => ({
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

      return {
        project_uuid: projectUuid,
        left: updated > 0,
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
        .leftJoin("gateway_clients as c", "c.client_uuid", "s.client_uuid")
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
        .select(
          "s.session_uuid",
          "s.project_uuid",
          "s.client_uuid",
          "s.local_session_id",
          "s.label",
          "s.status",
          "s.updated_at",
          "c.client_label",
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
      const kind = this.requireText?.(input.kind, "kind");
      const summary = this.requireText?.(input.summary, "summary");
      const message = this.requireText?.(input.message, "message");
      const expectedReply = this.normalizeOptionalText?.(input.expected_reply);
      const inReplyTo = this.normalizeOptionalText?.(input.in_reply_to);
      const requiresReply =
        typeof input.requires_reply === "boolean"
          ? input.requires_reply
          : kind === "question" || kind === "request";

      const sourceSession = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          client_uuid: clientUuid,
          local_session_id: localSessionId,
          status: "active",
        })
        .first();

      if (!sourceSession) {
        throw new Error(
          `Active project session '${localSessionId}' is not registered for client ${clientUuid}.`,
        );
      }

      const targetSession = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_sessions")
        .where({
          session_uuid: targetSessionId,
          status: "active",
        })
        .first();

      if (!targetSession) {
        throw new Error(`Target project session ${targetSessionId} was not found.`);
      }

      if (sourceSession.project_uuid !== targetSession.project_uuid) {
        throw new Error("Source and target sessions must belong to the same project.");
      }

      const shareId = randomUUID();
      const messageUuid = randomUUID();
      const deliveryUuid = randomUUID();
      const now = new Date().toISOString();

      await this.db.withSchema(MCP_SCHEMA).table("gateway_messages").insert({
        message_uuid: messageUuid,
        project_uuid: sourceSession.project_uuid,
        from_session_uuid: sourceSession.session_uuid,
        to_session_uuid: targetSession.session_uuid,
        kind,
        summary,
        body: message,
        ...(expectedReply ? { expected_reply: expectedReply } : {}),
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        requires_reply: requiresReply,
        meta: this.db.raw(`?::jsonb`, [JSON.stringify({ share_id: shareId })]),
        created_at: now,
      });

      const artifactRefs = Array.isArray(input.artifact_refs)
        ? (input.artifact_refs as PartnerArtifactRef[])
        : [];
      const usedArtifactNames = new Set<string>();

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

        await this.db.withSchema(MCP_SCHEMA).table("gateway_message_artifacts").insert({
          artifact_uuid: randomUUID(),
          message_uuid: messageUuid,
          original_name: path.basename(originalName),
          ...(trimOptionalText(artifact.mime_type)
            ? { mime_type: trimOptionalText(artifact.mime_type) }
            : {}),
          ...(typeof artifact.size_bytes === "number"
            ? { size_bytes: artifact.size_bytes }
            : {}),
          ...(trimOptionalText(artifact.storage_ref)
            ? { storage_ref: trimOptionalText(artifact.storage_ref) }
            : {}),
          relative_path: relativePath,
          meta: this.db.raw(`?::jsonb`, [
            JSON.stringify({
              file_path: trimOptionalText(artifact.file_path),
              relative_path: trimOptionalText(artifact.relative_path),
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
        status: "pending",
        attempt_count: 0,
        available_at: now,
        created_at: now,
      });

      return {
        session_id: localSessionId,
        partner_session_id: targetSession.session_uuid,
        kind: kind as SendPartnerNoteOutput["kind"],
        share_id: shareId,
        note_path: `gateway://shares/${shareId}.md`,
        share_index_path: "gateway://SHARED_INDEX.md",
        copied_artifacts: artifactRefs.map((artifact) =>
          trimOptionalText(artifact.original_name) ||
          trimOptionalText(artifact.relative_path) ||
          trimOptionalText(artifact.file_path) ||
          "file",
        ),
        inbox_message_id: deliveryUuid,
        requires_reply: requiresReply,
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
        .join("gateway_sessions as s_from", "s_from.session_uuid", "m.from_session_uuid")
        .join("gateway_sessions as s_to", "s_to.session_uuid", "m.to_session_uuid")
        .where("d.target_client_uuid", clientUuid)
        .where("d.status", "pending")
        .where("d.available_at", "<=", this.db.fn.now())
        .select(
          "d.delivery_uuid",
          "d.message_uuid",
          "m.kind",
          "m.summary",
          "m.body",
          "m.expected_reply",
          "m.requires_reply",
          "m.in_reply_to",
          "m.meta",
          "m.created_at",
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
      }>>();

      for (const artifact of artifactRows) {
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
            share_index_file_name: "SHARED_INDEX.md",
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

      const updated = await this.db
        .withSchema(MCP_SCHEMA)
        .table("gateway_deliveries")
        .where("target_client_uuid", clientUuid)
        .whereIn("delivery_uuid", deliveryIds)
        .update({
          status: "acked",
          acked_at: new Date().toISOString(),
        });

      return { acked: updated };
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
    listProjectSessions: {
      async handler(this: GatewayServiceCarrier, ctx) {
        if (!GATEWAY_ENABLED) {
          throw new Error("Gateway service is disabled in client mode");
        }
        return this.listProjectSessionsRecord?.(ctx.params as Record<string, unknown>);
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
  },
};

export default TelegramMcpGatewayService;
