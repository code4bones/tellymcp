import { createHash } from "node:crypto";

export function normalizeGatewayToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const token = value.trim();
  return token ? token : null;
}

export function gatewayScopeTokenToScopeKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resolveGatewayScopeKey(input: Record<string, unknown>): string | null {
  const gatewayScopeToken = normalizeGatewayToken(input.gateway_token);
  if (gatewayScopeToken) {
    return gatewayScopeTokenToScopeKey(gatewayScopeToken);
  }

  const scopeKey = normalizeGatewayToken(input.scope_key);
  return scopeKey;
}
