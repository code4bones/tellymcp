import { describe, expect, it, vi } from "vitest";

import ExternalInboxService from "../src/services/features/telegram-mcp/external-inbox.service";

type QueryRow = Record<string, unknown>;

type FirstRowEntry = QueryRow | undefined | ((state: HarnessState) => QueryRow | undefined);
type FirstQueue = Record<string, FirstRowEntry[] | undefined>;

type InsertCall = { tableName: string; payload: QueryRow };

type HarnessState = {
  firstByTable: FirstQueue;
  firstIndex: Record<string, number>;
  inserts: InsertCall[];
  updates: Array<{ tableName: string; where: QueryRow; payload: QueryRow }>;
  rawResult: { rows: QueryRow[] };
  broker: { call: ReturnType<typeof vi.fn> };
};

type QueryBuilder = {
  where: (clause: QueryRow | ((builder: QueryBuilder) => void)) => QueryBuilder;
  andWhere: (...args: unknown[]) => QueryBuilder;
  orWhere: (...args: unknown[]) => QueryBuilder;
  orderBy: (...args: unknown[]) => QueryBuilder;
  select: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
  first: (...columns: string[]) => Promise<QueryRow | undefined>;
  insert: (payload: QueryRow) => {
    onConflict: (columns: string[]) => {
      ignore: () => Promise<void>;
      merge: (patch: QueryRow) => Promise<void>;
    };
  };
  update: (payload: QueryRow) => Promise<number>;
};

function createQueryBuilder(
  state: HarnessState,
  tableName: string,
  whereClause: QueryRow = {},
): QueryBuilder {
  const builder: QueryBuilder = {
    where: (clause) => {
      if (typeof clause === "function") {
        clause(builder);
      } else {
        Object.assign(whereClause, clause);
      }
      return builder;
    },
    andWhere: () => builder,
    orWhere: () => builder,
    orderBy: () => builder,
    select: () => builder,
    limit: () => builder,
    async first() {
      const index = state.firstIndex[tableName] ?? 0;
      const entry = state.firstByTable[tableName]?.[index];
      state.firstIndex[tableName] = index + 1;
      return typeof entry === "function" ? entry(state) : entry;
    },
    insert: (payload: QueryRow) => {
      state.inserts.push({ tableName, payload });
      return {
        onConflict: () => ({
          ignore: async () => undefined,
          merge: async () => undefined,
        }),
      };
    },
    update: async (payload: QueryRow) => {
      state.updates.push({ tableName, where: whereClause, payload });
      return 1;
    },
  };
  return builder;
}

function createHarness(firstByTable: FirstQueue = {}) {
  const state: HarnessState = {
    firstByTable,
    firstIndex: {},
    inserts: [],
    updates: [],
    rawResult: { rows: [] },
    broker: { call: vi.fn() },
  };

  const harness = {
    db: {
      raw: vi.fn(async () => state.rawResult),
      withSchema: () => ({
        table: (tableName: string) => createQueryBuilder(state, tableName),
      }),
    },
    broker: state.broker,
    __state: state,
  };

  return harness as unknown as {
    db: {
      raw: ReturnType<typeof vi.fn>;
      withSchema: () => { table: (tableName: string) => QueryBuilder };
    };
    broker: { call: ReturnType<typeof vi.fn> };
    __state: HarnessState;
  } & Record<string, unknown>;
}

const methods = ExternalInboxService.methods as unknown as {
  requireText: (value: unknown, field: string) => string;
  normalizeOptionalText: (value: unknown) => string | null;
  putMessageRecord: (
    this: unknown,
    input: Record<string, unknown>,
  ) => Promise<{ id: string; status: string; deduplicated: boolean }>;
  bindIdentityRecord: (
    this: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  bindRouteRecord: (
    this: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  claimNextPendingMessage: (this: unknown) => Promise<unknown>;
  resetRetryableNoLiveSessionMessages: (
    this: unknown,
    maxAttempts: number,
  ) => Promise<number>;
};

function bindHarnessMethods(harness: ReturnType<typeof createHarness>) {
  return {
    ...harness,
    requireText: methods.requireText,
    normalizeOptionalText: methods.normalizeOptionalText,
  };
}

const validPutInput = {
  source: { integration: "marrow", messageId: "E-MARROW-1" },
  recipient: { externalPrincipal: { namespace: "marrow", subject: "U-1" } },
  route: { namespace: "marrow", key: "P-1" },
  resource: { kind: "task", id: "T-1" },
  kind: "work.offer",
  display: { title: "Fix the thing", summary: "Details" },
  consoleText: "Check task T-1 in project P-1 via your own tools.",
};

describe("external-inbox service: inbox_put", () => {
  it("inserts a new pending message when no (integration, messageId) row exists yet", async () => {
    const harness = createHarness({
      inbox_messages: [
        undefined,
        (state) => ({
          id: state.inserts[0]?.payload.id,
          status: state.inserts[0]?.payload.status,
        }),
      ],
    });
    const result = await methods.putMessageRecord.call(
      bindHarnessMethods(harness),
      validPutInput,
    );

    expect(result).toEqual({
      id: harness.__state.inserts[0]?.payload.id,
      status: "pending",
      deduplicated: false,
    });
    expect(harness.__state.inserts).toHaveLength(1);
    expect(harness.__state.inserts[0]?.tableName).toBe("inbox_messages");
    expect(harness.__state.inserts[0]?.payload).toMatchObject({
      source_integration: "marrow",
      source_message_id: "E-MARROW-1",
      recipient_namespace: "marrow",
      recipient_subject: "U-1",
      route_namespace: "marrow",
      route_key: "P-1",
      resource_kind: "task",
      resource_id: "T-1",
      kind: "work.offer",
      status: "pending",
    });
  });

  it("is idempotent: returns the existing row without inserting when already placed", async () => {
    const harness = createHarness({
      inbox_messages: [{ id: "existing-id", status: "offered" }],
    });
    const result = await methods.putMessageRecord.call(
      bindHarnessMethods(harness),
      validPutInput,
    );

    expect(result).toEqual({
      id: "existing-id",
      status: "offered",
      deduplicated: true,
    });
    expect(harness.__state.inserts).toHaveLength(0);
  });

  it("requires a display.title snapshot since TellyMCP never calls back to hydrate one", async () => {
    const harness = createHarness({ inbox_messages: [undefined] });
    const input = { ...validPutInput, display: { summary: "no title here" } };

    await expect(
      methods.putMessageRecord.call(bindHarnessMethods(harness), input),
    ).rejects.toThrow(/display\.title/);
  });
});

describe("external-inbox service: inbox_bind_route", () => {
  it("rejects a relay-form session_id instead of ever resolving ownership for it", async () => {
    const harness = createHarness();
    await expect(
      methods.bindRouteRecord.call(bindHarnessMethods(harness), {
        namespace: "marrow",
        route_key: "P-1",
        telegram_user_id: 7,
        session_id: "relay~client-1~workspace",
      }),
    ).rejects.toThrow(/relay session links are not accepted/);
    expect(harness.broker.call).not.toHaveBeenCalled();
  });

  it("fails closed when telegram_user_id has no gateway user record", async () => {
    const harness = createHarness({ gateway_users: [undefined] });
    await expect(
      methods.bindRouteRecord.call(bindHarnessMethods(harness), {
        namespace: "marrow",
        route_key: "P-1",
        telegram_user_id: 999,
        session_id: "client-1:workspace",
      }),
    ).rejects.toThrow(/No gateway user is registered/);
    expect(harness.broker.call).not.toHaveBeenCalled();
  });

  it("resolves and persists the live console for a valid canonical session_id", async () => {
    const harness = createHarness({
      gateway_users: [{ gateway_user_uuid: "user-uuid-1" }],
    });
    harness.broker.call.mockResolvedValue({
      client_uuid: "client-1",
      local_session_id: "workspace",
    });

    const result = await methods.bindRouteRecord.call(bindHarnessMethods(harness), {
      namespace: "marrow",
      route_key: "P-1",
      telegram_user_id: 7,
      session_id: "client-1:workspace",
    });

    expect(result).toEqual({
      namespace: "marrow",
      route_key: "P-1",
      client_uuid: "client-1",
      local_session_id: "workspace",
    });
    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gateway.resolveLiveConsole",
      { sessionId: "client-1:workspace", owner_user_uuid: "user-uuid-1" },
      { meta: { internal_call: true } },
    );
  });
});

describe("external-inbox service: claimNextPendingMessage", () => {
  it("returns the claimed row from the atomic claim query", async () => {
    const harness = createHarness();
    harness.__state.rawResult = {
      rows: [{ id: "claimed-1", status: "processing" }],
    };

    const result = await methods.claimNextPendingMessage.call(
      bindHarnessMethods(harness),
    );

    expect(result).toEqual({ id: "claimed-1", status: "processing" });
    expect(harness.db.raw).toHaveBeenCalledOnce();
  });

  it("returns null when nothing is pending", async () => {
    const harness = createHarness();
    harness.__state.rawResult = { rows: [] };

    const result = await methods.claimNextPendingMessage.call(
      bindHarnessMethods(harness),
    );

    expect(result).toBeNull();
  });
});

describe("external-inbox service: resetRetryableNoLiveSessionMessages", () => {
  it("only resets the precheck no_live_session reason, bounded by max attempts", async () => {
    const harness = createHarness();

    const result = await methods.resetRetryableNoLiveSessionMessages.call(
      bindHarnessMethods(harness),
      5,
    );

    expect(result).toBe(1);
    const update = harness.__state.updates.find(
      (entry) => entry.tableName === "inbox_messages",
    );
    expect(update?.where).toEqual({
      status: "no_live_session",
      status_reason: "target console is not currently connected",
    });
    expect(update?.payload).toEqual(
      expect.objectContaining({ status: "pending" }),
    );
  });
});
