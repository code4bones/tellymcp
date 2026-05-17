import { describe, expect, it } from "vitest";

import {
  hasLocalTargetSession,
  hasOutgoingDeliveryNotice,
} from "../src/services/features/telegram-mcp/gateway-loopback";

describe("gateway loopback helpers", () => {
  it("detects whether a local target session exists", () => {
    expect(hasLocalTargetSession(null)).toBe(false);
    expect(hasLocalTargetSession(undefined)).toBe(false);
    expect(hasLocalTargetSession({ sessionId: "leftDev" })).toBe(true);
  });

  it("checks outgoing delivery notice presence by delivery uuid", () => {
    expect(
      hasOutgoingDeliveryNotice(
        [
          {
            deliveryUuid: "delivery-1",
            sessionId: "leftDev",
            telegramChatId: 1,
            telegramMessageId: 2,
            shareId: "share-1",
            kind: "question",
            summary: "summary",
          },
        ],
        "delivery-1",
      ),
    ).toBe(true);

    expect(
      hasOutgoingDeliveryNotice(
        [
          {
            deliveryUuid: "delivery-1",
            sessionId: "leftDev",
            telegramChatId: 1,
            telegramMessageId: 2,
            shareId: "share-1",
            kind: "question",
            summary: "summary",
          },
        ],
        "delivery-2",
      ),
    ).toBe(false);
  });
});
