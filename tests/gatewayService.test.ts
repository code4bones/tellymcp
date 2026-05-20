import { describe, expect, it } from "vitest";

import GatewayService from "../src/services/features/telegram-mcp/gateway.service";

type QueryRow = Record<string, unknown>;

type QueryState = {
  tableName: string;
  rowsByTable: Record<string, QueryRow[]>;
  firstIndexes: Record<string, number>;
  inserts: Array<{ tableName: string; payload: QueryRow }>;
};

type GatewayServiceMethods = {
  normalizeOptionalText: (value: unknown) => string | null;
  requireText: (value: unknown, fieldName: string) => string;
  sendPartnerNoteRecord: (input: Record<string, unknown>) => Promise<{
    session_id: string;
    partner_session_id: string;
    project_name?: string;
    target_actor_label?: string;
    target_session_label?: string;
    kind: string;
    share_id: string;
    delivery_status: string;
    note_path: string;
    xchange_record_id: string;
    copied_artifacts: string[];
    inbox_message_id: string;
    requires_reply: boolean;
    delivery_uuid: string;
    target_client_uuid: string;
    delivery: {
      in_reply_to?: string;
      artifacts: Array<{ relative_path: string; original_name: string }>;
    };
  }>;
};

type GatewayServiceHarness = {
  db: {
    fn: { now: () => string };
    raw: (sql: string, values: unknown[]) => { sql: string; values: unknown[] };
    withSchema: (schema: string) => {
      table: (tableName: string) => QueryBuilder;
    };
  };
  normalizeOptionalText: GatewayServiceMethods["normalizeOptionalText"];
  requireText: GatewayServiceMethods["requireText"];
  sendPartnerNoteRecord: GatewayServiceMethods["sendPartnerNoteRecord"];
  __state: QueryState;
};

type QueryBuilder = {
  leftJoin: (...args: unknown[]) => QueryBuilder;
  where: (...args: unknown[]) => QueryBuilder;
  whereRaw: (...args: unknown[]) => QueryBuilder;
  select: (...args: unknown[]) => QueryBuilder;
  orderBy: (...args: unknown[]) => QueryBuilder;
  first: () => Promise<QueryRow | undefined>;
  insert: (payload: QueryRow) => Promise<void>;
};

const methods = GatewayService.methods as unknown as GatewayServiceMethods;

function createQueryBuilder(state: QueryState, tableName: string): QueryBuilder {
  return {
    leftJoin: () => createQueryBuilder(state, tableName),
    where: () => createQueryBuilder(state, tableName),
    whereRaw: () => createQueryBuilder(state, tableName),
    select: () => createQueryBuilder(state, tableName),
    orderBy: () => createQueryBuilder(state, tableName),
    async first() {
      const index = state.firstIndexes[tableName] ?? 0;
      const row = state.rowsByTable[tableName]?.[index];
      state.firstIndexes[tableName] = index + 1;
      return row;
    },
    async insert(payload: QueryRow) {
      state.inserts.push({ tableName, payload });
    },
  };
}

function createHarness(rowsByTable: Record<string, QueryRow[]>): GatewayServiceHarness {
  const state: QueryState = {
    rowsByTable,
    firstIndexes: {},
    inserts: [],
    tableName: "",
  };

  return {
    db: {
      fn: {
        now: () => "now()",
      },
      raw: (sql: string, values: unknown[]) => ({ sql, values }),
      withSchema: () => ({
        table: (tableName: string) => createQueryBuilder(state, tableName),
      }),
    },
    normalizeOptionalText: methods.normalizeOptionalText,
    requireText: methods.requireText,
    sendPartnerNoteRecord: methods.sendPartnerNoteRecord,
    __state: state,
  };
}

describe("gateway service sendPartnerNoteRecord", () => {
  it("creates queued message, delivery, and deduplicated artifact paths", async () => {
    const harness = createHarness({
      "gateway_sessions as s": [
        {
          session_uuid: "target-session-uuid",
          project_uuid: "project-1",
          project_name: "Project One",
          client_uuid: "target-client-uuid",
          local_session_id: "backend-local",
          label: "backend",
          target_actor_label: "Петр Олесов",
        },
      ],
      gateway_sessions: [
        {
          session_uuid: "source-session-uuid",
          project_uuid: "project-1",
          client_uuid: "source-client-uuid",
          local_session_id: "left-local",
          label: "leftDev",
        },
      ],
      gateway_messages: [
        undefined,
        { message_uuid: "resolved-message-uuid" },
      ] as unknown as QueryRow[],
    });

    const result = await harness.sendPartnerNoteRecord({
      client_uuid: "source-client-uuid",
      session_id: "left-local",
      target_session_id: "target-session-uuid",
      project_uuid: "project-1",
      kind: "reply",
      summary: "Системное время backend",
      message: "Время: 2026-05-16 01:06:34",
      in_reply_to: "share-id-123",
      requires_reply: false,
      artifact_refs: [
        {
          original_name: "wicardd.conf",
          content_base64: Buffer.from("first", "utf8").toString("base64"),
        },
        {
          original_name: "wicardd.conf",
          content_base64: Buffer.from("second", "utf8").toString("base64"),
        },
      ],
    });

    expect(result.session_id).toBe("left-local");
    expect(result.partner_session_id).toBe("target-session-uuid");
    expect(result.project_name).toBe("Project One");
    expect(result.target_actor_label).toBe("Петр Олесов");
    expect(result.target_session_label).toBe("backend");
    expect(result.kind).toBe("reply");
    expect(result.delivery_status).toBe("queued");
    expect(result.copied_artifacts).toEqual(["wicardd.conf", "wicardd.conf"]);
    expect(result.delivery.in_reply_to).toBe("resolved-message-uuid");
    expect(result.delivery.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          original_name: "wicardd.conf",
          relative_path: expect.stringContaining("/wicardd.conf"),
        }),
        expect.objectContaining({
          original_name: "wicardd.conf",
          relative_path: expect.stringContaining("/wicardd--1.conf"),
        }),
      ]),
    );

    const messageInsert = harness.__state.inserts.find(
      (entry) => entry.tableName === "gateway_messages",
    );
    expect(messageInsert?.payload).toEqual(
      expect.objectContaining({
        kind: "reply",
        summary: "Системное время backend",
        in_reply_to: "resolved-message-uuid",
        requires_reply: false,
      }),
    );

    const artifactInserts = harness.__state.inserts.filter(
      (entry) => entry.tableName === "gateway_message_artifacts",
    );
    expect(artifactInserts).toHaveLength(2);

    const deliveryInsert = harness.__state.inserts.find(
      (entry) => entry.tableName === "gateway_deliveries",
    );
    expect(deliveryInsert?.payload).toEqual(
      expect.objectContaining({
        target_client_uuid: "target-client-uuid",
        target_session_uuid: "target-session-uuid",
        status: "queued",
      }),
    );
  });

  it("rejects target sessions outside the requested project", async () => {
    const harness = createHarness({
      "gateway_sessions as s": [
        {
          session_uuid: "target-session-uuid",
          project_uuid: "project-2",
          project_name: "Other Project",
          client_uuid: "target-client-uuid",
          local_session_id: "backend-local",
          label: "backend",
        },
      ],
    });

    await expect(
      harness.sendPartnerNoteRecord({
        client_uuid: "source-client-uuid",
        session_id: "left-local",
        target_session_id: "target-session-uuid",
        project_uuid: "project-1",
        kind: "question",
        summary: "Где проект?",
        message: "Проверь проект",
      }),
    ).rejects.toThrow("Target session does not belong to the requested project.");
  });
});
