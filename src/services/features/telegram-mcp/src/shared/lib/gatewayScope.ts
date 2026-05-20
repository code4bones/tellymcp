import { createHash } from "node:crypto";

export function normalizeGatewayToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const token = value.trim();
  return token ? token : null;
}

export function gatewayTokenToScopeKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resolveGatewayScopeKey(input: Record<string, unknown>): string | null {
  const gatewayToken = normalizeGatewayToken(input.gateway_token);
  if (gatewayToken) {
    return gatewayTokenToScopeKey(gatewayToken);
  }

  const scopeKey = normalizeGatewayToken(input.scope_key);
  return scopeKey;
}
