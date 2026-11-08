import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteXchangeFile,
  ensureXchangeDir,
  writeXchangeFile,
  writeXchangeRelativeFile,
} from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/client";
import {
  closeAllXchangeConnections,
  getXchangeRecord,
  listXchangeRecords,
  markXchangeRecordRead,
  upsertXchangeRecord,
  updateXchangeRecordTags,
} from "../src/services/features/telegram-mcp/src/shared/integrations/xchange/sqliteRecordStore";
import type { XchangeRecord } from "../src/services/features/telegram-mcp/src/entities/xchange/model/types";

const handles = vi.hoisted(() => [] as DatabaseSync[]);
vi.mock(
  "../src/services/features/telegram-mcp/src/shared/lib/sqlite",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/services/features/telegram-mcp/src/shared/lib/sqlite")
      >();
    return {
      ...actual,
      DatabaseSync: class extends actual.DatabaseSync {
        constructor(dbPath: string) {
          super(dbPath);
          handles.push(this);
        }
      },
    };
  },
);
const roots: string[] = [];
afterEach(async () => {
  closeAllXchangeConnections();
  handles.length = 0;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "telly-xchange-safe-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { workspace, outside, exchange: path.join(workspace, ".mcp-xchange") };
}
function record(id = "one"): XchangeRecord {
  return {
    record_id: id,
    session_id: "session",
    category: "local_handoff",
    direction: "local",
    status: "new",
    summary: "fixture",
    body_text: "body",
    action_desc: "",
    tools: [],
    attachments: [],
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
describe("xchange connection lifetime", () => {
  it("reuses one WAL connection/schema across concurrent reads, updates and mark-read", async () => {
    const { workspace } = await fixture();
    await upsertXchangeRecord({}, workspace, ".mcp-xchange", record());
    expect(handles).toHaveLength(1);
    const db = handles[0]!;
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    const exec = vi.spyOn(db, "exec");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        getXchangeRecord({}, workspace, ".mcp-xchange", "session", "one"),
      ),
    );
    await markXchangeRecordRead(
      {},
      workspace,
      ".mcp-xchange",
      "session",
      "one",
    );
    expect(
      (await listXchangeRecords({}, workspace, ".mcp-xchange", "session"))[0]
        ?.status,
    ).toBe("read");
    await updateXchangeRecordTags(
      {},
      workspace,
      ".mcp-xchange",
      "session",
      "one",
      { add: ["complete"], remove: [] },
    );
    expect(
      await getXchangeRecord({}, workspace, ".mcp-xchange", "session", "one"),
    ).toMatchObject({ status: "read", tags: ["complete"] });
    expect(handles).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
    closeAllXchangeConnections();
    expect(() => db.prepare("SELECT 1")).toThrow();
    await expect(
      getXchangeRecord({}, workspace, ".mcp-xchange", "session", "one"),
    ).resolves.toMatchObject({ status: "read" });
    expect(handles).toHaveLength(2);
  });
  it("keeps workspace databases isolated and canonicalizes workspace aliases", async () => {
    const a = await fixture(),
      b = await fixture();
    await upsertXchangeRecord({}, a.workspace, ".mcp-xchange", record("a"));
    await upsertXchangeRecord({}, b.workspace, ".mcp-xchange", record("b"));
    const alias = path.join(a.outside, "workspace-alias");
    await symlink(a.workspace, alias);
    expect(
      await getXchangeRecord({}, alias, ".mcp-xchange", "session", "a"),
    ).not.toBeNull();
    expect(
      await getXchangeRecord({}, b.workspace, ".mcp-xchange", "session", "a"),
    ).toBeNull();
    expect(handles).toHaveLength(2);
  });
  it("refuses a symlink database file", async () => {
    const { workspace, outside, exchange } = await fixture();
    await mkdir(exchange);
    await writeFile(path.join(outside, "db"), "keep");
    await symlink(
      path.join(outside, "db"),
      path.join(exchange, "xchange.sqlite3"),
    );
    await expect(
      upsertXchangeRecord({}, workspace, ".mcp-xchange", record()),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(path.join(outside, "db"), "utf8")).toBe("keep");
    expect(handles).toHaveLength(0);
  });
});
describe("xchange write/delete confinement", () => {
  it("writes nested files, appends, replaces and deletes ordinary files", async () => {
    const { workspace } = await fixture();
    const file = await writeXchangeRelativeFile(
      {},
      workspace,
      ".mcp-xchange",
      "day/picker/file.txt",
      Buffer.from("a"),
    );
    await writeXchangeRelativeFile(
      {},
      workspace,
      ".mcp-xchange",
      "day/picker/file.txt",
      Buffer.from("b"),
      { append: true },
    );
    expect(await readFile(file, "utf8")).toBe("ab");
    await writeXchangeRelativeFile(
      {},
      workspace,
      ".mcp-xchange",
      "day/picker/file.txt",
      Buffer.from("c"),
    );
    expect(await readFile(file, "utf8")).toBe("c");
    await expect(
      deleteXchangeFile({}, workspace, ".mcp-xchange", file),
    ).resolves.toBe(true);
    await expect(
      deleteXchangeFile({}, workspace, ".mcp-xchange", file),
    ).resolves.toBe(true);
  });
  it("rejects symlink exchange roots before creating outside descendants", async () => {
    const { workspace, outside, exchange } = await fixture();
    await symlink(outside, exchange);
    await expect(
      writeXchangeRelativeFile(
        {},
        workspace,
        ".mcp-xchange",
        "nested/file",
        Buffer.from("bad"),
      ),
    ).rejects.toThrow(/symbolic link/);
    await expect(
      readFile(path.join(outside, "nested/file")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects symlink parent directories for writes, appends and deletion", async () => {
    const { workspace, outside, exchange } = await fixture();
    await mkdir(exchange);
    const target = path.join(outside, "keep.txt");
    await writeFile(target, "keep");
    await symlink(outside, path.join(exchange, "link"));
    for (const append of [false, true])
      await expect(
        writeXchangeRelativeFile(
          {},
          workspace,
          ".mcp-xchange",
          "link/keep.txt",
          Buffer.from("bad"),
          { append },
        ),
      ).rejects.toThrow(/symbolic link/);
    await expect(
      deleteXchangeFile(
        {},
        workspace,
        ".mcp-xchange",
        path.join(exchange, "link/keep.txt"),
      ),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(target, "utf8")).toBe("keep");
  });
  it.each([false, true])(
    "rejects leaf symlinks (dangling=%s)",
    async (dangling) => {
      const { workspace, outside, exchange } = await fixture();
      await mkdir(exchange);
      const target = path.join(outside, "keep.txt");
      if (!dangling) await writeFile(target, "keep");
      const link = path.join(exchange, "link.txt");
      await symlink(target, link);
      await expect(
        writeXchangeRelativeFile(
          {},
          workspace,
          ".mcp-xchange",
          "link.txt",
          Buffer.from("bad"),
        ),
      ).rejects.toThrow(/symbolic link/);
      await expect(
        deleteXchangeFile({}, workspace, ".mcp-xchange", link),
      ).rejects.toThrow(/symbolic link/);
      if (!dangling) expect(await readFile(target, "utf8")).toBe("keep");
      else
        await expect(readFile(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );
  it("allocates distinct names concurrently and skips dangling links", async () => {
    const { workspace, outside, exchange } = await fixture();
    await mkdir(exchange);
    await symlink(
      path.join(outside, "missing"),
      path.join(exchange, "note.txt"),
    );
    const files = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeXchangeFile(
          {},
          workspace,
          ".mcp-xchange",
          "note.txt",
          Buffer.from(String(i)),
        ),
      ),
    );
    expect(new Set(files).size).toBe(12);
    expect(
      (await Promise.all(files.map((f) => readFile(f, "utf8")))).sort(),
    ).toEqual(Array.from({ length: 12 }, (_, i) => String(i)).sort());
    await expect(readFile(path.join(outside, "missing"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
  it("rejects a configured exchange directory outside the workspace", async () => {
    const { workspace, outside } = await fixture();
    await expect(ensureXchangeDir({}, workspace, outside)).rejects.toThrow(
      /outside/,
    );
  });
});
