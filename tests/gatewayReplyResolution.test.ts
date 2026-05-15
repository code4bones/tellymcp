import { describe, expect, it, vi } from "vitest";

import { resolveGatewayInReplyTo } from "../src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayReplyResolution";

describe("resolveGatewayInReplyTo", () => {
  it("returns undefined when in_reply_to is absent", async () => {
    await expect(
      resolveGatewayInReplyTo(undefined, {
        findMessageUuidByMessageUuid: vi.fn(),
        findMessageUuidByShareId: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });

  it("prefers direct message_uuid match", async () => {
    const findByMessage = vi.fn(async () => "message-uuid-1");
    const findByShare = vi.fn(async () => "message-uuid-2");

    await expect(
      resolveGatewayInReplyTo("message-uuid-1", {
        findMessageUuidByMessageUuid: findByMessage,
        findMessageUuidByShareId: findByShare,
      }),
    ).resolves.toBe("message-uuid-1");

    expect(findByShare).not.toHaveBeenCalled();
  });

  it("falls back from share_id to message_uuid", async () => {
    await expect(
      resolveGatewayInReplyTo("share-id-1", {
        findMessageUuidByMessageUuid: async () => undefined,
        findMessageUuidByShareId: async () => "message-uuid-from-share",
      }),
    ).resolves.toBe("message-uuid-from-share");
  });

  it("returns undefined when neither message_uuid nor share_id resolve", async () => {
    await expect(
      resolveGatewayInReplyTo("unknown", {
        findMessageUuidByMessageUuid: async () => undefined,
        findMessageUuidByShareId: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });
});
