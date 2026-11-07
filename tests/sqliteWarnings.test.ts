import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const entry = path.resolve(
  "src/services/features/telegram-mcp/src/shared/lib/sqlite.ts",
);
function run(script: string, flags: string[] = []) {
  return spawnSync(
    process.execPath,
    [...flags, "--import", require.resolve("tsx"), "-e", script],
    {
      env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
}
const load =
  "const before = process.emitWarning; const { DatabaseSync } = require(" +
  JSON.stringify(entry) +
  ");";

describe("SQLite startup warning", () => {
  it("loads a working database quietly and restores the original warning handler", () => {
    const result = run(
      load +
        "const db = new DatabaseSync(':memory:'); console.log(JSON.stringify({ value: db.prepare('SELECT 42 AS value').get().value, restored: process.emitWarning === before })); db.close();",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value: 42, restored: true });
    expect(result.stderr).toBe("");
  });

  it("keeps unrelated experimental/deprecation warnings and later SQLite notices visible", () => {
    const result = run(
      load +
        "process.emitWarning('another feature', 'ExperimentalWarning'); process.emitWarning('deprecation remains', { type: 'DeprecationWarning', code: 'TEST_WARNING' }); process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ExperimentalWarning: another feature");
    expect(result.stderr).toContain(
      "[TEST_WARNING] DeprecationWarning: deprecation remains",
    );
    expect(
      result.stderr.match(/SQLite is an experimental feature/gu),
    ).toHaveLength(1);
  });

  it("restores the handler and propagates the error when SQLite cannot load", () => {
    const result = run(
      "const before = process.emitWarning; try { require(" +
        JSON.stringify(entry) +
        "); process.exitCode = 2; } catch (error) { console.log(JSON.stringify({ restored: process.emitWarning === before, code: error.code })); }",
      ["--no-experimental-sqlite"],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      restored: true,
      code: "ERR_UNKNOWN_BUILTIN_MODULE",
    });
  });
});
