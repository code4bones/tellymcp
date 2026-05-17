import { describe, expect, it } from "vitest";

import {
  buildLiveRelaySessionId,
  parseLiveRelaySessionId,
} from "../src/services/features/telegram-mcp/src/app/webapp/relay";

describe("live relay session id", () => {
  it("builds and parses relay ids without source client", () => {
    const value = buildLiveRelaySessionId(
      "client-uuid-1",
      "telegram-mcp-708ad3c5",
    );

    expect(parseLiveRelaySessionId(value)).toEqual({
      clientUuid: "client-uuid-1",
      localSessionId: "telegram-mcp-708ad3c5",
    });
  });

  it("builds and parses relay ids with source client", () => {
    const value = buildLiveRelaySessionId(
      "target-client-uuid",
      "telegram-mcp-708ad3c5",
      "source-client-uuid",
    );

    expect(parseLiveRelaySessionId(value)).toEqual({
      clientUuid: "target-client-uuid",
      localSessionId: "telegram-mcp-708ad3c5",
      sourceClientUuid: "source-client-uuid",
    });
  });

  it("preserves special characters in local session id", () => {
    const value = buildLiveRelaySessionId(
      "target-client-uuid",
      "session/with spaces?and#chars",
      "source-client-uuid",
    );

    expect(parseLiveRelaySessionId(value)).toEqual({
      clientUuid: "target-client-uuid",
      localSessionId: "session/with spaces?and#chars",
      sourceClientUuid: "source-client-uuid",
    });
  });
});
