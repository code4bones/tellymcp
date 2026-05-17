import { describe, expect, it } from "vitest";

import {
  BackendError,
  buildUnhandledBackendErrorCode,
  wrapUnhandledBackendError,
} from "@src/lib/mixins/session.errors";

describe("BackendError", () => {
  it("stores runtime error fields without GraphQL extensions", () => {
    const err = new BackendError("boom", 502, "XC_TELEGRAMMCP_SEND", { retryable: false });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("boom");
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("XC_TELEGRAMMCP_SEND");
    expect(err.data).toEqual({ retryable: false });
    expect("extensions" in err).toBe(false);
  });

  it("builds XC codes for unhandled action errors", () => {
    expect(buildUnhandledBackendErrorCode("telegramMcp.sendPartnerNote")).toBe(
      "XC_TELEGRAMMCP.SENDPARTNERNOTE"
    );
  });

  it("wraps generic errors into BackendError with XC code", () => {
    const err = wrapUnhandledBackendError(new Error("network"), "telegramMcp.gateway");

    expect(err).toBeInstanceOf(BackendError);
    expect(err.message).toBe("network");
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("XC_TELEGRAMMCP.GATEWAY");
  });
});
