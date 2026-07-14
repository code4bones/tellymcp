import os from "node:os";

import type { MaintenanceStore } from "../../../shared/api/storage/contract";
import { assertStringBodySize } from "../../../shared/lib/bodyLimits";

export function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

export async function callGatewayJson<T>(input: {
  gatewayPublicUrl: string;
  gatewayAuthToken?: string;
  endpointPath: string;
  body: Record<string, unknown>;
}): Promise<T> {
  const url = normalizeGatewayBaseUrl(input.gatewayPublicUrl);
  url.pathname = `${url.pathname}${input.endpointPath}`.replace(/\/{2,}/gu, "/");
  const serializedBody = JSON.stringify(input.body);
  assertStringBodySize(serializedBody);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.gatewayAuthToken
        ? { authorization: `Bearer ${input.gatewayAuthToken}` }
        : {}),
    },
    body: serializedBody,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Gateway request failed with status ${response.status}: ${message || response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

export async function ensureGatewayClientUuid(input: {
  maintenanceStore: MaintenanceStore;
  gatewayPublicUrl?: string;
  gatewayAuthToken?: string;
  projectName?: string;
  botUsername?: string;
  gatewayScopeToken?: string;
  gatewayUserUuid?: string;
  namespace?: string;
  nodeId?: string;
  systemUsername?: string;
}): Promise<string> {
  const namespace = input.namespace || process.env.NAMESPACE || undefined;
  const nodeId = input.nodeId || process.env.NODE_ID || undefined;
  const systemUsername =
    input.systemUsername ||
    process.env.USER ||
    process.env.LOGNAME ||
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return undefined;
      }
    })();
  const existing = await input.maintenanceStore.getGatewayClientUuid();

  if (!input.gatewayPublicUrl) {
    throw new Error("Gateway client registration requires GATEWAY_PUBLIC_URL.");
  }

  const response = await callGatewayJson<{ client_uuid: string }>({
    gatewayPublicUrl: input.gatewayPublicUrl,
    ...(input.gatewayAuthToken
      ? { gatewayAuthToken: input.gatewayAuthToken }
      : {}),
    endpointPath: "/client/register",
    body: {
      ...(existing ? { client_uuid: existing } : {}),
      client_label:
        input.projectName ||
        [namespace, nodeId].filter(Boolean).join("/") ||
        input.botUsername ||
        "tellymcp client",
      ...(input.botUsername ? { bot_username: input.botUsername } : {}),
      ...(input.gatewayScopeToken ? { gateway_token: input.gatewayScopeToken } : {}),
      ...(input.gatewayUserUuid ? { owner_user_uuid: input.gatewayUserUuid } : {}),
      meta: {
        ...(namespace ? { namespace } : {}),
        ...(nodeId ? { node_id: nodeId } : {}),
        ...(systemUsername ? { system_username: systemUsername } : {}),
        ...(input.gatewayUserUuid
          ? { gateway_user_uuid: input.gatewayUserUuid }
          : {}),
      },
    },
  });

  await input.maintenanceStore.setGatewayClientUuid(response.client_uuid);
  return response.client_uuid;
}
