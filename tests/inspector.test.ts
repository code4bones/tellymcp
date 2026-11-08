import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectorBridge } from "../packages/attach-extension-shared/src/background";
import {
  bitmapRect,
  cleanText,
  cleanUrl,
  type SelectionContext,
} from "../packages/attach-extension-shared/src/context";
import { validateInspectorResult } from "../src/services/features/telegram-mcp/src/features/browser/model/inspectorProtocol";
import { InspectorTools } from "../src/services/features/telegram-mcp/src/features/browser/model/inspectorTools";
import type { BrowserService } from "../src/services/features/telegram-mcp/src/features/browser/model/browserService";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const fixture = (): SelectionContext => ({
  schemaVersion: 1,
  selectionId: "selection-1",
  requestId: "request-1",
  timestamp: new Date().toISOString(),
  source: { connectionId: "instance", sessionId: "session", tabId: "7" },
  page: {
    url: "https://example.com/page",
    origin: "https://example.com",
    title: "Metrics",
    viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
  },
  selection: {
    mode: "region",
    rect: { x: 50, y: 50, width: 100, height: 200 },
  },
  redaction: { applied: true, warnings: ["Untrusted page data"] },
});
function harness() {
  let selected: number | null = 7;
  const message = vi.fn().mockResolvedValue({ ok: true });
  const bridge = new InspectorBridge({
    tab: async (id) => ({
      id,
      windowId: 1,
      url: "https://example.com/page?private=token",
      active: true,
    }),
    active: async () => ({ id: 7, windowId: 1 }),
    selected: () => selected,
    inject: vi.fn(),
    message,
    capture: vi.fn(),
  });
  bridge.bind("session", "instance", "Console");
  return {
    bridge,
    message,
    select: (id: number | null) => {
      selected = id;
    },
  };
}
const binding = { sessionId: "session", instanceId: "instance", tabId: 7 };
const sender = { tab: { id: 7 }, frameId: 0 };
afterEach(() => vi.useRealTimers());

describe("inspector context", () => {
  it("strips URL credentials/query/fragment and common plaintext secrets", () => {
    expect(
      cleanUrl("https://user:password@example.com/page?token=private#secret"),
    ).toBe("https://example.com/page");
    expect(cleanUrl("chrome://settings")).toBe("");
    expect(
      Buffer.byteLength(cleanText("界😀".repeat(100), 31)),
    ).toBeLessThanOrEqual(31);
    expect(cleanText("界😀".repeat(100), 31)).not.toContain("�");
    expect(
      cleanText("Bearer abcdef sk-1234567890abcdefghijkl 4111 1111 1111 1111"),
    ).toBe("[redacted] [redacted] [redacted]");
  });
  it("maps CSS rectangles by actual bitmap dimensions including zoom and clipping", () => {
    expect(
      bitmapRect(
        { x: -10, y: 20, width: 110, height: 50 },
        { width: 800, height: 600 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ x: 0, y: 30, width: 150, height: 75 });
    expect(() =>
      bitmapRect(
        { x: 900, y: 0, width: 10, height: 10 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
    ).toThrow();
  });
  it("rejects forged ownership, unsanitized URLs, expiry and mismatched image metadata", () => {
    expect(
      validateInspectorResult(
        { status: "selected", context: fixture() },
        binding,
      ).context?.schemaVersion,
    ).toBe(1);
    for (const mutate of [
      (c: SelectionContext) => {
        c.source.sessionId = "other";
      },
      (c: SelectionContext) => {
        c.page.url += "?secret=yes";
      },
      (c: SelectionContext) => {
        c.timestamp = new Date(Date.now() - 301000).toISOString();
      },
      (c: SelectionContext) => {
        c.selection.rect.width = 2000;
      },
    ]) {
      const context = fixture();
      mutate(context);
      expect(() =>
        validateInspectorResult({ status: "selected", context }, binding),
      ).toThrow();
    }
    expect(() =>
      validateInspectorResult(
        {
          status: "selected",
          context: fixture(),
          image: { png_base64: "AAAA", width: 1, height: 1 },
        },
        binding,
      ),
    ).toThrow();
  });
});

describe("bound inspector queue", () => {
  it("keeps user-approved context private to the exact session/tab and correlates responses", async () => {
    vi.useFakeTimers();
    const { bridge, message, select } = harness();
    await bridge.start(7, "region", "request-1");
    await expect(
      bridge.runtime({ type: "picker_submit", context: fixture() }, sender),
    ).resolves.toMatchObject({ ok: true, status: "queued" });
    expect(
      (
        await bridge.action(7, "inspector_get_selection", {
          session_id: "session",
          include_image: false,
        })
      ).result,
    ).toMatchObject({
      status: "selected",
      context: { source: { sessionId: "session", connectionId: "instance" } },
    });
    await expect(
      bridge.action(7, "inspector_get_selection", { session_id: "other" }),
    ).rejects.toThrow("bound");
    await expect(
      bridge.action(8, "inspector_get_selection", { session_id: "session" }),
    ).rejects.toThrow("bound");
    await expect(
      bridge.action(7, "inspector_response", {
        session_id: "session",
        selection_id: "selection-1",
        request_id: "old",
        explanation: "unsafe stale response",
      }),
    ).rejects.toThrow("expired");
    await bridge.action(7, "inspector_response", {
      session_id: "session",
      selection_id: "selection-1",
      request_id: "request-1",
      explanation: "Visible information only",
    });
    expect(message).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ action: "response", request_id: "request-1" }),
    );
    select(null);
    await expect(
      bridge.action(7, "inspector_get_selection", { session_id: "session" }),
    ).rejects.toThrow();
    select(7);
    await vi.advanceTimersByTimeAsync(300001);
    expect(
      (
        await bridge.action(7, "inspector_get_selection", {
          session_id: "session",
        })
      ).result,
    ).toEqual({ status: "pending" });
    bridge.disconnect();
  });
  it("does not route disconnected, unselected or subframe requests; forgets on navigation", async () => {
    vi.useFakeTimers();
    const { bridge, select } = harness();
    await bridge.start(7, "element");
    await expect(
      bridge.runtime(
        { type: "picker_submit", context: fixture() },
        { ...sender, frameId: 2 },
      ),
    ).rejects.toThrow("top-frame");
    select(8);
    await expect(
      bridge.runtime({ type: "picker_submit", context: fixture() }, sender),
    ).resolves.toMatchObject({ ok: false });
    select(7);
    await bridge.runtime({ type: "picker_submit", context: fixture() }, sender);
    bridge.invalidateTab(7);
    expect(
      (
        await bridge.action(7, "inspector_get_selection", {
          session_id: "session",
        })
      ).result,
    ).toEqual({ status: "pending" });
    bridge.disconnect();
    await expect(
      bridge.action(7, "inspector_get_selection", { session_id: "session" }),
    ).rejects.toThrow("bound");
  });
  it("registers pull, response and cleanup tools with image content rather than base64 in text", async () => {
    const callbacks = new Map<
      string,
      (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    >();
    const inspector = vi.fn().mockResolvedValue({
      session_id: "session",
      status: "selected",
      context: fixture(),
      image: { png_base64: "test-image", width: 1, height: 1 },
    });
    new InspectorTools({ inspector } as unknown as BrowserService).register({
      registerTool: (
        name: string,
        _metadata: unknown,
        callback: (
          args: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>,
      ) => callbacks.set(name, callback),
    } as unknown as McpServer);
    expect([...callbacks.keys()]).toEqual([
      "inspector_start",
      "inspector_get_selection",
      "inspector_highlight",
      "inspector_response",
      "inspector_stop",
    ]);
    const result = await callbacks.get("inspector_get_selection")!({
      session_id: "session",
    });
    expect(inspector).toHaveBeenCalledWith({
      session_id: "session",
      operation: "get_selection",
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "test-image",
    );
    expect(result.content).toContainEqual({
      type: "image",
      data: "test-image",
      mimeType: "image/png",
    });
  });
});
