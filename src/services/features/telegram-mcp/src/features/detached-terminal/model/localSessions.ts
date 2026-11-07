import fs from "node:fs";
import { createHash } from "node:crypto";
import { readSessionMarkerState } from "../../../shared/lib/project-identity/projectIdentity";
import {
  LocalRegistry,
  processStartIdentity,
  type OwnerRecord,
} from "./localRegistry";
import { connectOwner, ownerSocketReachable } from "./localConnection";
import { FrameType } from "./localProtocol";

/** Persist only a digest; never put profile contents or credentials in discovery. */
export function startupFingerprint(
  envPath: string,
  environment: NodeJS.ProcessEnv,
): string {
  const relevant = Object.entries(environment)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        (/^(GATEWAY_|TERMINAL_|BROWSER_|MCP_|TELEGRAM_|DISTRIBUTED_|LOG_)/u.test(
          key,
        ) ||
          [
            "NODE_ID",
            "NAMESPACE",
            "PROJECT_NAME",
            "TELLYMCP_HTTP_PROXY",
            "TELLYMCP_NO_PROXY",
          ].includes(key)),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(fs.readFileSync(envPath))
    .update(JSON.stringify(relevant))
    .digest("hex");
}

export function resolveLocalOwner(
  registry: LocalRegistry,
  handle?: string,
  cwd = process.cwd(),
): OwnerRecord {
  const records = registry.list();
  if (handle) {
    const record = records.find((value) => value.instance === handle);
    if (!record)
      throw new Error("Local session handle not found. Use tellymcp sessions.");
    return record;
  }
  const canonicalCwd = fs.realpathSync(cwd),
    marker = readSessionMarkerState(canonicalCwd);
  if (!marker?.gatewayClientUuid)
    throw new Error(
      "No workspace session identity. Use tellymcp run or supply a handle from sessions.",
    );
  const matching = records.filter(
    (record) =>
      record.cwd === canonicalCwd &&
      record.clientUuid === marker.gatewayClientUuid &&
      record.sessionId === marker.localSessionId,
  );
  if (matching.length !== 1)
    throw new Error(
      "No running owner for this workspace session. Use tellymcp sessions or run.",
    );
  return matching[0]!;
}

export async function listLocalSessions(registry: LocalRegistry) {
  return Promise.all(
    registry.list().map(async (record) => {
      const base = {
        handle: record.instance,
        client_uuid: record.clientUuid,
        local_session_id: record.sessionId,
        session_label: record.sessionLabel,
        cwd: record.cwd,
        owner_pid: record.pid,
        agent_id: record.agentId ?? null,
      };
      if (processStartIdentity(record.pid) !== record.processStart)
        return { ...base, state: "exited", attached: null, pty_pid: null };
      try {
        const connection = await connectOwner(record);
        connection.socket.end();
        return {
          ...base,
          state: "running",
          attached: connection.attached,
          pty_pid: connection.ptyPid,
        };
      } catch {
        return { ...base, state: "unavailable", attached: null, pty_pid: null };
      }
    }),
  );
}

export async function stopLocalOwner(
  registry: LocalRegistry,
  record: OwnerRecord,
): Promise<void> {
  if (processStartIdentity(record.pid) !== record.processStart) {
    if (!(await registry.recover(record, ownerSocketReachable)))
      throw new Error(
        "Cannot safely clean this stale owner; socket ownership is ambiguous.",
      );
    return;
  }
  const connection = await connectOwner(record);
  let error: Error | undefined;
  connection.socket.on("data", (data) => {
    try {
      for (const frame of connection.decoder.push(data)) {
        if (frame.type !== FrameType.Control)
          throw new Error("Unexpected stop response");
        const message = JSON.parse(frame.payload.toString("utf8")) as Record<
          string,
          unknown
        >;
        if (message.type === "error")
          throw new Error("Stop rejected: " + String(message.code));
      }
    } catch (failure) {
      error =
        failure instanceof Error ? failure : new Error("Invalid stop response");
    }
  });
  connection.socket.on("error", (failure) => {
    error = failure;
  });
  try {
    connection.writer.control({ type: "stop" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!registry.list().some((value) => value.instance === record.instance))
        return;
      if (error) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      "Owner is still shutting down; inspect sessions before retrying.",
    );
  } finally {
    connection.socket.destroy();
  }
}
