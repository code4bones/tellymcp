import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isGatewayAuthorizationValid(
  authorization: unknown,
  authToken: string | undefined,
): boolean {
  if (typeof authorization !== "string" || !authToken) {
    return false;
  }

  return timingSafeEqual(digest(authorization), digest(`Bearer ${authToken}`));
}
