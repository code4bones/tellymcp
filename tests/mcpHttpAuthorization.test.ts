import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { resolveMcpHttpAuthorization } from "../src/services/features/telegram-mcp/src/app/http";

function makeRequest(authorization?: string): IncomingMessage {
  return {
    headers: authorization ? { authorization } : {},
  } as IncomingMessage;
}

describe("resolveMcpHttpAuthorization inbox_bearer mode", () => {
  it("authorizes as inbox_bearer when the dedicated inbox token matches", () => {
    const mode = resolveMcpHttpAuthorization(
      makeRequest("Bearer inbox-secret"),
      "transport-secret",
      null,
      "inbox-secret",
    );
    expect(mode).toBe("inbox_bearer");
  });

  it("falls back to the general bearer mode when the inbox token does not match", () => {
    const mode = resolveMcpHttpAuthorization(
      makeRequest("Bearer transport-secret"),
      "transport-secret",
      null,
      "inbox-secret",
    );
    expect(mode).toBe("internal_bearer");
  });

  it("rejects a caller presenting neither token", () => {
    const mode = resolveMcpHttpAuthorization(
      makeRequest("Bearer something-else"),
      "transport-secret",
      null,
      "inbox-secret",
    );
    expect(mode).toBeNull();
  });

  it("does not grant inbox_bearer when no inbox token is configured", () => {
    const mode = resolveMcpHttpAuthorization(
      makeRequest("Bearer transport-secret"),
      "transport-secret",
      null,
    );
    expect(mode).toBe("internal_bearer");
  });
});
