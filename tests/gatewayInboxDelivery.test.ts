import { describe, expect, it, vi } from "vitest";
import GatewayService from "../src/services/features/telegram-mcp/gateway.service";

type Row = Record<string, unknown>;
const createDelivery = (
  GatewayService.methods as unknown as {
    createInboxDeliveryRecord(this: unknown, input: Row): Promise<Row>;
  }
).createInboxDeliveryRecord;

function createHarness() {
  const tables: Record<string, Row[]> = {
    gateway_sessions: [
      {
        session_uuid: "target-1",
        client_uuid: "client-1",
        local_session_id: "Vita",
      },
      {
        session_uuid: "target-2",
        client_uuid: "client-2",
        local_session_id: "WebTerm",
      },
    ],
    gateway_messages: [],
    gateway_deliveries: [],
  };
  const db = {
    withSchema: () => ({
      table: (name: string) => {
        let filter: Row = {};
        const builder = {
          where: (where: Row) => {
            filter = where;
            return builder;
          },
          first: async () =>
            tables[name]?.find((row) =>
              Object.entries(filter).every(([k, v]) => row[k] === v),
            ),
          insert: (row: Row) => ({
            onConflict: (key: string) => ({
              ignore: async () => {
                if (
                  !tables[name]!.some((existing) => existing[key] === row[key])
                )
                  tables[name]!.push({ ...row });
              },
            }),
          }),
        };
        return builder;
      },
    }),
    transaction: async (run: (tx: unknown) => Promise<void>) => {
      const snapshot = structuredClone(tables);
      try {
        await run(db);
      } catch (error) {
        Object.assign(tables, snapshot);
        throw error;
      }
    },
  };
  const harness = {
    db,
    requireText: (value: unknown) => String(value),
    ensureInboxSystemActorRecord: vi.fn(async () => ({
      projectUuid: "system-project",
      sessionUuid: "system-session",
    })),
  };
  return { harness, tables };
}

const input = {
  inbox_message_id: "11111111-1111-4111-8111-111111111111",
  target_client_uuid: "client-1",
  target_local_session_id: "Vita",
  kind: "inbox-offer",
  summary: "Task T-1",
  message: "Claim T-1",
};

describe("gateway inbox delivery retries", () => {
  it("reuses the xchange record and delivery when PTY delivery is retried", async () => {
    const { harness, tables } = createHarness();
    const first = await createDelivery.call(harness, input);
    tables.gateway_deliveries![0]!.status = "delivered";
    const retried = await createDelivery.call(harness, input);
    expect(retried).toEqual(first);
    expect(tables.gateway_messages).toHaveLength(1);
    expect(tables.gateway_deliveries).toHaveLength(1);
    expect(tables.gateway_deliveries![0]!.status).toBe("delivered");
  });
  it("prevents an existing xchange record from being duplicated in another console", async () => {
    const { harness, tables } = createHarness();
    await createDelivery.call(harness, input);
    await expect(
      createDelivery.call(harness, {
        ...input,
        target_client_uuid: "client-2",
        target_local_session_id: "WebTerm",
      }),
    ).rejects.toThrow(/already queued for another console/);
    expect(tables.gateway_messages).toHaveLength(1);
    expect(tables.gateway_deliveries).toHaveLength(1);
    expect(tables.gateway_messages![0]!.to_session_uuid).toBe("target-1");
  });
});

describe("legacy inbox deliveries", () => {
  it("reuses a delivery made before inbox UUIDs became the idempotency key", async () => {
    const { harness, tables } = createHarness();
    tables.gateway_messages!.push({
      message_uuid: "legacy-message",
      to_session_uuid: "target-1",
    });
    tables.gateway_deliveries!.push({
      message_uuid: "legacy-message",
      delivery_uuid: "legacy-delivery",
      status: "delivered",
    });
    await expect(
      createDelivery.call(harness, {
        ...input,
        message_uuid: "legacy-message",
      }),
    ).resolves.toEqual({
      message_uuid: "legacy-message",
      delivery_uuid: "legacy-delivery",
    });
    expect(tables.gateway_messages).toHaveLength(1);
    expect(tables.gateway_deliveries).toHaveLength(1);
  });
});
