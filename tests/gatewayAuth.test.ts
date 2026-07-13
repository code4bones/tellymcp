import { describe, expect, it } from "vitest";

import { isGatewayAuthorizationValid } from "../src/services/features/telegram-mcp/src/shared/lib/gatewayAuth";

describe("gateway authorization", () => {
  it("requires an explicitly configured token", () => {
    expect(isGatewayAuthorizationValid(undefined, undefined)).toBe(false);
    expect(isGatewayAuthorizationValid("Bearer anything", undefined)).toBe(
      false,
    );
  });

  it("accepts only an exact bearer value", () => {
    expect(
      isGatewayAuthorizationValid(
        "Bearer transport-secret",
        "transport-secret",
      ),
    ).toBe(true);
    expect(
      isGatewayAuthorizationValid("Bearer wrong-secret", "transport-secret"),
    ).toBe(false);
    expect(
      isGatewayAuthorizationValid(
        "bearer transport-secret",
        "transport-secret",
      ),
    ).toBe(false);
  });
});
