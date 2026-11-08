import { randomUUID } from "node:crypto";
import knex, { type Knex } from "knex";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const connection = process.env.TELLY_TEST_POSTGRES_URL;
const schema = "telly_debt_test_" + randomUUID().replaceAll("-", "");
let db: Knex;
let methods: NonNullable<
  typeof import("../src/services/features/telegram-mcp/gateway.service").default.methods
>;
let ensure: () => Promise<void>;
const ids = {
  sourceClient: randomUUID(),
  targetClient: randomUUID(),
  source: randomUUID(),
  target: randomUUID(),
  project: randomUUID(),
};
const table = (name: string) => db.withSchema(schema).table(name);
const input = (request_id?: string) => ({
  client_uuid: ids.sourceClient,
  session_id: "source",
  target_session_id: ids.target,
  project_uuid: ids.project,
  kind: "request",
  summary: "fixture",
  message: "original",
  ...(request_id ? { request_id } : {}),
  artifact_refs: [
    {
      file_path: "data.txt",
      original_name: "data.txt",
      content_base64: Buffer.from("artifact").toString("base64"),
    },
  ],
});
const service = () => ({ db, ...methods });
async function enqueue(key?: string) {
  return methods.sendPartnerNoteRecord!.call(service(), input(key));
}
async function count(name: string) {
  return Number((await table(name).count("* as count").first())!.count);
}

describe.runIf(Boolean(connection))(
  "gateway queue with real PostgreSQL",
  () => {
    beforeAll(async () => {
      vi.stubEnv("DB_SCHEMA", schema);
      const [{ default: gateway }, { default: ensureService }] =
        await Promise.all([
          import("../src/services/features/telegram-mcp/gateway.service"),
          import("../src/services/features/telegram-mcp/ensuredb.service"),
        ]);
      methods = gateway.methods as typeof methods;
      db = knex({ client: "pg", connection, pool: { min: 0, max: 12 } });
      ensure = () =>
        (ensureService.methods as typeof methods).ensureGatewaySchema!.call({
          db,
        });
      for (let attempt = 0; ; attempt++) {
        try {
          await db.raw("SELECT 1");
          break;
        } catch (error) {
          if (attempt >= 99) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await ensure();
      await table("gateway_clients").insert([
        { client_uuid: ids.sourceClient },
        { client_uuid: ids.targetClient },
      ]);
      await table("gateway_projects").insert({
        project_uuid: ids.project,
        name: "debt tests",
        invite_token: randomUUID(),
      });
      await table("gateway_sessions").insert([
        {
          session_uuid: ids.source,
          client_uuid: ids.sourceClient,
          local_session_id: "source",
          label: "source",
          status: "active",
        },
        {
          session_uuid: ids.target,
          client_uuid: ids.targetClient,
          local_session_id: "target",
          label: "target",
          status: "active",
        },
      ]);
      await table("gateway_project_consoles").insert([
        {
          project_console_uuid: randomUUID(),
          project_uuid: ids.project,
          client_uuid: ids.sourceClient,
          local_session_id: "source",
          gateway_session_uuid: ids.source,
          status: "active",
        },
        {
          project_console_uuid: randomUUID(),
          project_uuid: ids.project,
          client_uuid: ids.targetClient,
          local_session_id: "target",
          gateway_session_uuid: ids.target,
          status: "active",
        },
      ]);
    }, 30000);
    beforeEach(async () => {
      await table("gateway_messages").delete();
    });
    afterAll(async () => {
      if (db) {
        try {
          expect(schema.startsWith("telly_debt_test_")).toBe(true);
          await db.raw("DROP SCHEMA IF EXISTS ?? CASCADE", [schema]);
        } finally {
          await db.destroy();
        }
      }
      vi.unstubAllEnvs();
    });
    it.each(["gateway_message_artifacts", "gateway_deliveries"])(
      "rolls back messages/artifacts/delivery if %s fails",
      async (name) => {
        await db.raw(
          "CREATE FUNCTION ??.fail_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected failure'; END$$",
          [schema],
        );
        await db.raw(
          "CREATE TRIGGER fail_enqueue BEFORE INSERT ON ??.?? FOR EACH ROW EXECUTE FUNCTION ??.fail_enqueue()",
          [schema, name, schema],
        );
        try {
          await expect(enqueue("rollback")).rejects.toThrow("injected failure");
        } finally {
          await db.raw("DROP TRIGGER fail_enqueue ON ??.??", [schema, name]);
          await db.raw("DROP FUNCTION ??.fail_enqueue()", [schema]);
        }
        expect(await count("gateway_messages")).toBe(0);
        expect(await count("gateway_message_artifacts")).toBe(0);
        expect(await count("gateway_deliveries")).toBe(0);
        await expect(enqueue("rollback")).resolves.toMatchObject({
          delivery_status: "queued",
        });
      },
    );
    it("serializes concurrent retries and rehydrates their identical receipt without duplicating artifact bytes in meta", async () => {
      const [a, b] = await Promise.all([enqueue("same"), enqueue("same")]);
      expect(b).toEqual(a);
      expect(await count("gateway_messages")).toBe(1);
      expect(await count("gateway_message_artifacts")).toBe(1);
      expect(await count("gateway_deliveries")).toBe(1);
      expect(a.delivery.artifacts[0].content_base64).toBe(
        Buffer.from("artifact").toString("base64"),
      );
      const row = await table("gateway_messages").first();
      expect(
        row!.meta.enqueue_receipt.delivery.artifacts[0].content_base64,
      ).toBeUndefined();
      await expect(
        methods.sendPartnerNoteRecord!.call(service(), {
          ...input("same"),
          message: "changed",
        }),
      ).rejects.toThrow("different partner-note content");
      expect(await count("gateway_messages")).toBe(1);
    });
    it("keeps deliberate new requests independent without a retry key", async () => {
      const a = await enqueue(),
        b = await enqueue();
      expect(a.share_id).not.toBe(b.share_id);
      expect(await count("gateway_messages")).toBe(2);
    });
    it("claims each delivery once across competing consumers and reclaims an expired lease", async () => {
      const note = await enqueue();
      const claim = () =>
        methods.pollDeliveriesRecord!.call(service(), {
          client_uuid: ids.targetClient,
          local_session_ids: ["target"],
          limit: 50,
        });
      const batches = await Promise.all(Array.from({ length: 8 }, claim));
      const deliveries = batches.flatMap((batch) => batch.deliveries);
      expect(deliveries.map((d) => d.delivery_uuid)).toEqual([
        note.delivery_uuid,
      ]);
      expect((await claim()).deliveries).toEqual([]);
      await table("gateway_deliveries")
        .where("delivery_uuid", note.delivery_uuid)
        .update({ available_at: db.raw("now() - interval '1 second'") });
      expect((await claim()).deliveries).toHaveLength(1);
      expect((await table("gateway_deliveries").first())!.attempt_count).toBe(
        2,
      );
    });
    it("filters owner sessions, schedules transient failures and never redelivers ACKed work", async () => {
      const note = await enqueue();
      expect(
        (
          await methods.pollDeliveriesRecord!.call(service(), {
            client_uuid: ids.targetClient,
            local_session_ids: ["other"],
          })
        ).deliveries,
      ).toEqual([]);
      await methods.pollDeliveriesRecord!.call(service(), {
        client_uuid: ids.targetClient,
        delivery_ids: [note.delivery_uuid],
      });
      expect(
        await methods.failDeliveriesRecord!.call(service(), {
          client_uuid: ids.targetClient,
          delivery_ids: [note.delivery_uuid],
          retryable: true,
          error_text: "not ready",
        }),
      ).toMatchObject({ retrying: 1, deliveries: [] });
      expect((await table("gateway_deliveries").first())!.status).toBe(
        "queued",
      );
      expect(
        (
          await methods.ackDeliveriesRecord!.call(service(), {
            client_uuid: ids.sourceClient,
            delivery_ids: [note.delivery_uuid],
          })
        ).acked,
      ).toBe(0);
      await methods.ackDeliveriesRecord!.call(service(), {
        client_uuid: ids.targetClient,
        delivery_ids: [note.delivery_uuid],
      });
      for (const retryable of [false, true]) {
        expect(
          await methods.failDeliveriesRecord!.call(service(), {
            client_uuid: ids.targetClient,
            delivery_ids: [note.delivery_uuid],
            retryable,
            error_text: "late duplicate attempt",
          }),
        ).toMatchObject({ failed: 0, deliveries: [] });
      }
      expect((await table("gateway_deliveries").first())!.status).toBe(
        "delivered",
      );
      await table("gateway_deliveries").update({
        available_at: db.raw("now() - interval '1 second'"),
      });
      expect(
        (
          await methods.pollDeliveriesRecord!.call(service(), {
            client_uuid: ids.targetClient,
          })
        ).deliveries,
      ).toEqual([]);
    });
    it("migrates an existing messages table without losing records", async () => {
      const note = await enqueue();
      await db.raw("DROP INDEX ??.??", [
        schema,
        "gateway_messages_request_key_unique",
      ]);
      await db.schema
        .withSchema(schema)
        .alterTable("gateway_messages", (t) => t.dropColumn("request_key"));
      await ensure();
      await ensure();
      expect(
        (await table("gateway_messages")
          .where("message_uuid", note.delivery.message_uuid)
          .first())!.body,
      ).toBe("original");
      expect(
        await db.schema
          .withSchema(schema)
          .hasColumn("gateway_messages", "request_key"),
      ).toBe(true);
      await expect(enqueue("after-migration")).resolves.toMatchObject({
        delivery_status: "queued",
      });
    });
  },
);
