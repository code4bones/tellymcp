import type { MaintenanceStore } from "../../../shared/api/storage/contract";

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.gatewayAuthToken
        ? { authorization: `Bearer ${input.gatewayAuthToken}` }
        : {}),
    },
    body: JSON.stringify(input.body),
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
}): Promise<string> {
  const existing = await input.maintenanceStore.getGatewayClientUuid();
  if (existing) {
    return existing;
  }

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
      client_label:
        input.projectName ||
        input.botUsername ||
        "tellymcp client",
      ...(input.botUsername ? { bot_username: input.botUsername } : {}),
      meta: {},
    },
  });

  await input.maintenanceStore.setGatewayClientUuid(response.client_uuid);
  return response.client_uuid;
}
