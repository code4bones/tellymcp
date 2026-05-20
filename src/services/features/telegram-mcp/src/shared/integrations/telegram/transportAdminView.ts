import {
  buildAdminClientTitle,
} from "./transportUtils";
import type {
  AdminClientSessionViewRecord,
  AdminClientViewRecord,
  GatewayClientRecord,
  GatewayClientSessionRecord,
  GatewayConnectedClientRecord,
} from "./transportTypes";

export function mergeGatewayAdminClients(input: {
  registeredClients: GatewayClientRecord[];
  connectedClients: GatewayConnectedClientRecord[];
}): AdminClientViewRecord[] {
  const merged = new Map<string, AdminClientViewRecord>();

  for (const client of input.registeredClients) {
    merged.set(client.client_uuid, {
      ...client,
      is_registered: true,
    });
  }

  for (const client of input.connectedClients) {
    const existing = merged.get(client.client_uuid);
    const connectedSessionLabels = client.session_tools
      .map((item) => item.session_label?.trim() || item.local_session_id.trim())
      .filter(Boolean)
      .slice(0, 3);

    merged.set(client.client_uuid, {
      client_uuid: client.client_uuid,
      client_label: existing?.client_label ?? null,
      namespace: existing?.namespace ?? client.namespace ?? null,
      node_id: existing?.node_id ?? client.node_id ?? null,
      telegram_username: existing?.telegram_username ?? null,
      telegram_display_name: existing?.telegram_display_name ?? null,
      bot_username: existing?.bot_username ?? null,
      ...(existing?.last_seen_at ? { last_seen_at: existing.last_seen_at } : {}),
      ...(existing?.updated_at ? { updated_at: existing.updated_at } : {}),
      ...(typeof existing?.session_count === "number"
        ? { session_count: existing.session_count }
        : {}),
      is_registered: existing?.is_registered ?? false,
      is_connected: true,
      connected_session_count: client.session_tools.length,
      connected_session_labels: connectedSessionLabels,
    });
  }

  return Array.from(merged.values()).sort((left, right) =>
    buildAdminClientTitle(left).localeCompare(buildAdminClientTitle(right)),
  );
}

export function mergeGatewayAdminClientSessions(input: {
  clientUuid: string;
  scope: "collab" | "all";
  collabSessions: GatewayClientSessionRecord[];
  connectedClient?: GatewayConnectedClientRecord | null;
}): AdminClientSessionViewRecord[] {
  if (input.scope === "collab") {
    return input.collabSessions.map((session) => ({
      ...session,
      is_collab: true,
    }));
  }

  const merged = new Map<string, AdminClientSessionViewRecord>();

  for (const session of input.collabSessions) {
    merged.set(session.local_session_id, {
      ...session,
      is_collab: true,
    });
  }

  for (const sessionTool of input.connectedClient?.session_tools ?? []) {
    const key = sessionTool.local_session_id;
    const existing = merged.get(key);

    merged.set(key, {
      session_uuid: existing?.session_uuid ?? key,
      client_uuid: input.clientUuid,
      local_session_id: key,
      label: existing?.label ?? sessionTool.session_label ?? key,
      status: existing?.status ?? "connected",
      ...(existing?.project_uuid ? { project_uuid: existing.project_uuid } : {}),
      ...(existing?.project_name ? { project_name: existing.project_name } : {}),
      ...(existing?.updated_at ? { updated_at: existing.updated_at } : {}),
      is_connected: true,
      is_collab: existing?.is_collab ?? false,
    });
  }

  return Array.from(merged.values()).sort((left, right) =>
    (left.label ?? left.local_session_id).localeCompare(
      right.label ?? right.local_session_id,
    ),
  );
}

export function buildAdminClientsMenuText(input: {
  title: string;
  empty: string;
  connectedCountLabel: string;
  registeredCountLabel: string;
  legend: string;
  clients: AdminClientViewRecord[];
}): string {
  const lines = [input.title, ""];

  if (input.clients.length === 0) {
    lines.push(input.empty);
    return lines.join("\n");
  }

  lines.push(input.connectedCountLabel);
  lines.push(input.registeredCountLabel);
  lines.push("");
  lines.push(input.legend);

  return lines.join("\n");
}
