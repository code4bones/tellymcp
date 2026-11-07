import { createRequire } from "node:module";

type SqliteModule = typeof import("node:sqlite");
const experimentalNotice =
  "SQLite is an experimental feature and might change at any time";

function loadSqlite(): SqliteModule {
  const emitWarning = process.emitWarning;
  // The built-in emits this notice synchronously on first require. Scope the
  // filter to that load, keeping other warnings and the caller's handler intact.
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const options = args[0];
    const type =
      warning instanceof Error
        ? warning.name
        : typeof options === "string"
          ? options
          : options && typeof options === "object" && "type" in options
            ? options.type
            : undefined;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message === experimentalNotice)
      return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return createRequire(__filename)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export const DatabaseSync = loadSqlite().DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
