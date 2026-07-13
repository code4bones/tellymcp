import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  BodySizeLimitError,
  MAX_BODY_SIZE,
  MAX_BODY_SIZE_BYTES,
  readLimitedJsonBody,
} from "../src/services/features/telegram-mcp/src/shared/lib/bodyLimits";

function makeRequest(
  chunks: Array<string | Buffer>,
  contentLength?: number,
): IncomingMessage {
  const request = Readable.from(chunks) as IncomingMessage;
  request.headers =
    contentLength === undefined
      ? {}
      : { "content-length": String(contentLength) };
  return request;
}

describe("body limits", () => {
  it("defines the shared limit in MiB", () => {
    expect(MAX_BODY_SIZE).toBe(16);
    expect(MAX_BODY_SIZE_BYTES).toBe(16 * 1024 * 1024);
  });

  it("parses JSON below the limit", async () => {
    await expect(
      readLimitedJsonBody(makeRequest(['{"ok":true}'])),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects an oversized declared content length before reading", async () => {
    await expect(
      readLimitedJsonBody(makeRequest([], MAX_BODY_SIZE_BYTES + 1)),
    ).rejects.toBeInstanceOf(BodySizeLimitError);
  });

  it("rejects an oversized chunked body while streaming", async () => {
    const chunk = Buffer.alloc(MAX_BODY_SIZE_BYTES / 2 + 1, 0x20);
    await expect(
      readLimitedJsonBody(makeRequest([chunk, chunk])),
    ).rejects.toBeInstanceOf(BodySizeLimitError);
  });
});
