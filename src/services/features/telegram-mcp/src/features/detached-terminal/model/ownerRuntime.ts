import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import boundedOwnerLog from "../../../../../../../lib/pinoTargets";

import {
  enableOwnedPtySessions,
  getOwnedPtySession,
  stopPtyTarget,
  stopAllPtyTargets,
} from "../../../shared/integrations/terminal/ptyRegistry";
import { readSessionMarkerState } from "../../../shared/lib/project-identity/projectIdentity";
import {
  createForegroundBroker,
  ensureForegroundPtySession,
} from "../../foreground-terminal/model/foregroundTerminalRuntime";
import {
  ownerSpecSchema,
  LocalRegistry,
  type OwnerSpec,
} from "./localRegistry";
import { startSessionOwner, type OwnerSession } from "./sessionOwner";

export async function createOwnerRuntime(
  spec: OwnerSpec,
): Promise<OwnerSession> {
  // Identity is resolved by the launcher, never guessed from cwd by an attachment.
  const marker = readSessionMarkerState(spec.cwd);
  if (
    marker?.localSessionId !== spec.sessionId ||
    marker.gatewayClientUuid !== spec.clientUuid
  )
    throw new Error("Workspace identity changed before owner startup");
  process.env.TELLYMCP_SESSION_ID = spec.sessionId;
  process.env.TELLYMCP_SESSION_LABEL = spec.sessionLabel;
  if (spec.browserWsPort !== undefined) {
    process.env.BROWSER_ATTACH_ENABLED = "true";
    process.env.BROWSER_ATTACH_WS_PORT = String(spec.browserWsPort);
  }
  enableOwnedPtySessions();
  const handle = await createForegroundBroker(
    spec.envPath,
    spec.packageRoot,
  ).catch((error: unknown) => {
    stopAllPtyTargets(); // Bootstrap may have created the shell before a later service failed.
    throw error;
  });
  let target: string | undefined;
  try {
    if (handle.runtime.config.distributed.mode !== "client")
      throw new Error("Session owners require client runtime mode");
    const session = await ensureForegroundPtySession(handle.runtime);
    target = session.target;
    if (
      session.sessionId !== spec.sessionId ||
      (await handle.runtime.maintenanceStore.getGatewayClientUuid()) !==
        spec.clientUuid
    )
      throw new Error("Owner runtime identity mismatch");
    await handle.broker
      .call("telegramMcp.gatewaySocket.refreshClientHello")
      .catch(() => {
        handle.runtime.logger.warn(
          "Owner hello refresh deferred until gateway reconnect",
        );
      });
    if (spec.agentId)
      await handle.broker.call("telegramMcp.agentRuntime.startRemote", {
        session_id: spec.sessionId,
        agent_id: spec.agentId,
      });
    return {
      stream: getOwnedPtySession(target),
      stop: async () => {
        // One owner runtime per process; its broker owns its provider/browser/MCP services.
        try {
          await handle.broker.stop();
        } finally {
          if (target) stopPtyTarget(target);
        }
      },
    };
  } catch (error) {
    try {
      await handle.broker.stop();
    } finally {
      if (target) stopPtyTarget(target);
    }
    throw error;
  }
}

/** Internal same-package entrypoint. Not a public launch command. */
export async function runOwnerEntrypoint(specPath: string): Promise<void> {
  process.umask(0o077);
  const stat = fs.lstatSync(specPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    stat.size > 16384
  )
    throw new Error("Unsafe owner startup file");
  const spec = ownerSpecSchema.parse(
    JSON.parse(fs.readFileSync(specPath, "utf8")),
  );
  const registry = new LocalRegistry(path.dirname(specPath));
  process.chdir(spec.cwd);
  process.env.LOG_FILE_ENABLED = "true";
  const logKey = createHash("sha256")
    .update(`${spec.clientUuid}:${spec.sessionId}`)
    .digest("hex")
    .slice(0, 24);
  process.env.LOG_FILE_PATH = path.join(registry.root, `owner-${logKey}.log`);
  process.env.TELLYMCP_OWNER_LOG_MAX_BYTES = "1048576";
  const version = (
    JSON.parse(
      fs.readFileSync(path.join(spec.packageRoot, "package.json"), "utf8"),
    ) as { version: string }
  ).version;
  const journal = boundedOwnerLog({ destination: process.env.LOG_FILE_PATH });
  journal.on("error", () => {});
  const log = (event: string, error?: unknown) => {
    journal.write(
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...(error
          ? {
              error:
                error instanceof Error
                  ? (error.stack ?? error.message).slice(0, 8192)
                  : "unknown",
            }
          : {}),
      }) + "\n",
    );
  };
  const onRejection = (error: unknown) => log("runtime_rejection", error);
  const onException = (error: Error) => log("runtime_exception", error);
  // Match foreground reliability: transient broker callbacks do not own PTY life.
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    const handle = await startSessionOwner({
      registry,
      spec,
      packageVersion: version,
      createSession: createOwnerRuntime,
      log,
    });
    fs.rmSync(specPath, { force: true });
    const code = await handle.finished;
    process.exit(code);
  } catch (error) {
    log("startup_failed", error);
    fs.rmSync(specPath, { force: true });
    process.exit(1);
  }
}
