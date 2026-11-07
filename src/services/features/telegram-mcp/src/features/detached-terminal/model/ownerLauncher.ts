import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { connectOwner, ownerSocketReachable } from "./localConnection";
import {
  LocalRegistry,
  ownerSpecSchema,
  processStartIdentity,
  type OwnerRecord,
  type OwnerSpec,
} from "./localRegistry";

/** Read-only readiness check closes its socket and acquires no controller. */
export async function probeOwner(record: OwnerRecord): Promise<void> {
  const { socket } = await connectOwner(record);
  socket.end();
}

export function assertCompatibleOwner(
  record: OwnerRecord,
  spec: OwnerSpec,
): void {
  if (fs.realpathSync(record.envPath) !== fs.realpathSync(spec.envPath))
    throw new Error(
      "Running session uses another env profile; attach to it or stop it before changing configuration.",
    );
  if (spec.agentId && record.agentId !== spec.agentId)
    throw new Error(
      "Running session uses another provider (or a plain shell); attach to it or stop it before changing --agent.",
    );
  if (
    spec.browserWsPort !== undefined &&
    record.browserWsPort !== spec.browserWsPort
  )
    throw new Error(
      "Running session uses another browser bridge launch setting; attach or stop it before changing --ws.",
    );
  if (spec.startupHash && record.startupHash !== spec.startupHash)
    throw new Error(
      "Running session has different startup configuration; use attach or stop it before restarting.",
    );
}

export async function launchSessionOwner(input: {
  spec: OwnerSpec;
  registry?: LocalRegistry;
  timeoutMs?: number;
  /** Test seam for a same-package Node fixture; production always uses the CLI. */
  entryArgs?: string[];
}): Promise<OwnerRecord> {
  const spec = ownerSpecSchema.parse({
    ...input.spec,
    cwd: fs.realpathSync(input.spec.cwd),
  });
  const registry = input.registry ?? new LocalRegistry();
  const timeout = input.timeoutMs ?? 20000;
  const deadline = Date.now() + timeout;
  let spawnError: Error | undefined;
  let childExited = false;
  const existing = registry.find(spec);
  if (
    existing &&
    processStartIdentity(existing.pid) === existing.processStart
  ) {
    if (existing.state === "ready") {
      assertCompatibleOwner(existing, spec);
      await probeOwner(existing);
      return existing;
    }
    return waitReady();
  }
  if (existing && !(await registry.recover(existing, ownerSocketReachable)))
    throw new Error("Cannot reclaim ambiguous session owner");
  const requestPath = path.join(registry.root, `launch-${randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(spec), {
    mode: 0o600,
    flag: "wx",
  });
  const entryArgs =
    input.entryArgs ??
    (process.env.TELLYMCP_SOURCE_RUNTIME === "true"
      ? [
          "--import",
          createRequire(path.join(spec.packageRoot, "package.json")).resolve(
            "tsx",
          ),
          path.join(spec.packageRoot, "src", "cli.ts"),
          "__session-owner",
        ]
      : [path.join(spec.packageRoot, "dist", "cli.js"), "__session-owner"]);
  const child = spawn(process.execPath, [...entryArgs, requestPath], {
    cwd: spec.cwd,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", () => {
    childExited = true;
  });
  child.unref();
  try {
    return await waitReady();
  } finally {
    fs.rmSync(requestPath, { force: true });
  }

  async function waitReady(): Promise<OwnerRecord> {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const record = registry.find(spec);
      if (record?.state === "ready") {
        assertCompatibleOwner(record, spec);
        await probeOwner(record);
        return record;
      }
      if (record && processStartIdentity(record.pid) !== record.processStart)
        throw new Error("Owner exited before ready; inspect private owner log");
      if (!record && childExited)
        throw new Error("Owner startup failed; inspect private owner log");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Never signal an unverified PID or delete a live owner's claim on timeout.
    throw new Error(
      "Owner readiness timeout; session state retained for recovery",
    );
  }
}
