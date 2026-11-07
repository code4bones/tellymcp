import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { LocalRegistry } from "../../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry.ts";
import { launchSessionOwner } from "../../src/services/features/telegram-mcp/src/features/detached-terminal/model/ownerLauncher.ts";

const require = createRequire(import.meta.url);
const requestPath = process.argv.at(-1);
const spec = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const record = await launchSessionOwner({
  spec,
  registry: new LocalRegistry(path.dirname(requestPath)),
  entryArgs: [
    "--import",
    require.resolve("tsx"),
    path.resolve("tests/fixtures/sessionOwner.mjs"),
  ],
});
fs.writeFileSync(
  path.join(path.dirname(requestPath), "launcher-result.json"),
  JSON.stringify(record),
  { mode: 0o600 },
);
// Natural launcher exit closes its PTY descriptors. The owner must outlive it.
process.exit(0);
