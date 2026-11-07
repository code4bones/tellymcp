import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  LocalRegistry,
  ownerSpecSchema,
} from "../../src/services/features/telegram-mcp/src/features/detached-terminal/model/localRegistry.ts";
import { startSessionOwner } from "../../src/services/features/telegram-mcp/src/features/detached-terminal/model/sessionOwner.ts";
import {
  enableOwnedPtySessions,
  ensurePtySession,
  getOwnedPtySession,
  stopPtyTarget,
} from "../../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry.ts";

process.umask(0o077);
const requestPath = process.argv.at(-1);
const spec = ownerSpecSchema.parse(
  JSON.parse(fs.readFileSync(requestPath, "utf8")),
);
const registry = new LocalRegistry(path.dirname(requestPath));
const handle = await startSessionOwner({
  registry,
  spec,
  packageVersion: "test",
  createSession: async () => {
    fs.appendFileSync(
      path.join(spec.cwd, "owner-starts.txt"),
      `${process.pid}\n`,
      { mode: 0o600 },
    );
    enableOwnedPtySessions();
    const target = ensurePtySession(
      { shell: "/bin/sh", cols: 80, rows: 24, scrollbackLines: 100 },
      { sessionId: spec.sessionId, cwd: spec.cwd },
    );
    const stream = getOwnedPtySession(target);
    return {
      stream,
      stop: async () => {
        stopPtyTarget(target);
        await stream.dispose();
      },
    };
  },
});
fs.rmSync(requestPath, { force: true });
process.exit(await handle.finished);
