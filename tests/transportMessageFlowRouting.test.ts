import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";
import { GatewayHttpService } from "../src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService";
import { buildLiveRelaySessionId } from "../src/services/features/telegram-mcp/src/app/webapp/relay";
import { ProcessLocalStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalStateStore";
import { TransportMessageFlow } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMessageFlow";
import {
  extractIncomingText,
  collectIncomingAttachments,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportContent";
import { buildInboxText } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportFormatting";
import type {
  TelegramMenuContext,
  StoredAttachmentRecord,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";
import {
  ensureTerminalTargetForSession,
  captureTerminalPaneRange,
} from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/client";
import { stopAllPtyTargets } from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

const principal = { telegramChatId: 42, telegramUserId: 7 };
const terminal = {
  shell: "/bin/cat",
  cols: 100,
  rows: 24,
  scrollbackLines: 200,
};
afterEach(() => stopAllPtyTargets());

function fixture() {
  const targets = new Map(
    ["first", "second"].map((sessionId) => [
      sessionId,
      {
        sessionId,
        terminalTarget: ensureTerminalTargetForSession(terminal, {
          sessionId,
          cwd: process.cwd(),
        }),
      },
    ]),
  );
  const processLiveRequest = GatewaySocketService.methods!
    .processLiveRequest as unknown as (
    this: unknown,
    request: unknown,
  ) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
  const callBroker = vi.fn(
    async (
      name: string,
      params: { localSessionId: string; requestType: string; payload: unknown },
    ) => {
      expect(name).toBe("telegramMcp.gatewaySocket.requestLiveRelay");
      const response = await processLiveRequest.call(
        {
          getRuntimeOrThrow: () => ({
            config: { terminal },
            sessionStore: { getSession: async (id: string) => targets.get(id) },
          }),
        },
        {
          request_id: "test",
          request_type: params.requestType,
          local_session_id: params.localSessionId,
          payload: params.payload,
        },
      );
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
  );
  const http = new GatewayHttpService(
    {
      distributed: { mode: "gateway", gatewayAuthToken: "test-only" },
    } as never,
    callBroker as never,
  );
  const callGatewayJson = vi.fn(async (path: string, body: unknown) => {
    const response = {
      statusCode: 200,
      body: "",
      setHeader: vi.fn(),
      end(value: string) {
        this.body = value;
      },
    };
    await http.handleRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer test-only" },
        body,
      } as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      "/gateway" + path,
    );
    const result = JSON.parse(response.body);
    if (response.statusCode !== 200) throw new Error(result.error);
    return result;
  });
  const store = new ProcessLocalStateStore();
  // Old persisted Agent preferences must never influence ordinary Telegram input.
  const legacyRoute = vi.fn(async () => ({ mode: "agent", agentId: "codex" }));
  Object.assign(store, { getConsoleDeliveryRoute: legacyRoute });
  const replyText = vi.fn(async () => undefined);
  const download = vi.fn(async (): Promise<StoredAttachmentRecord[]> => []);
  const flow = new TransportMessageFlow({
    bindingStore: store,
    sessionStore: { getSession: async (sessionId: string) => ({ sessionId }) },
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    extractIncomingText,
    collectIncomingAttachments,
    buildInboxText,
    downloadIncomingAttachments: download,
    callGatewayJson,
    replyText,
    tForContext: async (_ctx: unknown, key: string) => key,
  } as unknown as ConstructorParameters<typeof TransportMessageFlow>[0]);
  const snapshot = (id: string) =>
    captureTerminalPaneRange(
      terminal,
      targets.get(id)!.terminalTarget,
      "-30",
      false,
    );
  return {
    flow,
    store,
    callBroker,
    callGatewayJson,
    legacyRoute,
    replyText,
    download,
    snapshot,
  };
}
function message(text?: string) {
  return {
    from: { id: 7, first_name: "Ada" },
    chat: { id: 42 },
    message: {
      message_id: 1,
      date: Date.now() / 1000,
      ...(text ? { text } : {}),
    },
  } as unknown as TelegramMenuContext;
}
async function waitForOutput(check: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error("Telegram input did not reach the PTY");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Telegram → selected console → real PTY", () => {
  it.each(["first", "second"])(
    "delivers ordinary text to %s, ignoring a legacy Agent preference",
    async (selected) => {
      const f = fixture();
      await f.store.setActiveSessionIdForPrincipal(
        principal,
        buildLiveRelaySessionId("client-1", selected),
      );
      await f.flow.handleInboxCapture(message("TELEGRAM_PTY_CHECK"));
      await waitForOutput(async () =>
        (await f.snapshot(selected)).includes("TELEGRAM_PTY_CHECK"),
      );
      expect(
        await f.snapshot(selected === "first" ? "second" : "first"),
      ).not.toContain("TELEGRAM_PTY_CHECK");
      expect(f.legacyRoute).not.toHaveBeenCalled();
      expect(f.callGatewayJson).toHaveBeenCalledWith(
        "/relay/console-message",
        expect.objectContaining({
          target_client_uuid: "client-1",
          target_local_session_id: selected,
          delivery_mode: "pty",
        }),
      );
      expect(f.callGatewayJson.mock.calls[0]![1]).not.toHaveProperty(
        "agent_id",
      );
      expect(f.callBroker.mock.calls.map(([, p]) => p.payload)).toEqual([
        { action: "text", text: "TELEGRAM_PTY_CHECK" },
        { action: "enter" },
      ]);
    },
  );
  it("delivers long Telegram input across the live relay limit without splitting emoji", async () => {
    const f = fixture();
    await f.store.setActiveSessionIdForPrincipal(
      principal,
      buildLiveRelaySessionId("client-1", "first"),
    );
    const text = "a".repeat(3999) + "😀" + "LONG_END";
    await f.flow.handleInboxCapture(message(text));
    await waitForOutput(async () =>
      (await f.snapshot("first")).includes("LONG_END"),
    );
    const chunks = f.callBroker.mock.calls
      .map(([, p]) => p.payload as { action: string; text?: string })
      .filter((p) => p.action === "text")
      .map((p) => p.text!);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()),
    ).toBe(true);
    expect(
      (f.callBroker.mock.calls.at(-1)![1].payload as { action: string }).action,
    ).toBe("enter");
  });
  it.each(["caption", undefined])(
    "delivers uploaded files with %s to the selected console",
    async (caption) => {
      const f = fixture();
      await f.store.setActiveSessionIdForPrincipal(
        principal,
        buildLiveRelaySessionId("client-1", "second"),
      );
      f.download.mockResolvedValue([
        { filePath: "/tmp/test-only-upload.txt" } as StoredAttachmentRecord,
      ]);
      const ctx = message();
      Object.assign(ctx.message!, {
        document: { file_id: "fixture", file_name: "upload.txt" },
        ...(caption ? { caption } : {}),
      });
      await f.flow.handleInboxCapture(ctx);
      await waitForOutput(async () =>
        (await f.snapshot("second")).includes("test-only-upload.txt"),
      );
      expect(await f.snapshot("first")).not.toContain("test-only-upload.txt");
      expect(f.callGatewayJson).toHaveBeenCalledWith(
        "/relay/console-message",
        expect.objectContaining({
          attachments: ["/tmp/test-only-upload.txt"],
          delivery_mode: "pty",
        }),
      );
    },
  );
  it("reports an unavailable target without submitting to another console", async () => {
    const f = fixture();
    await f.store.setActiveSessionIdForPrincipal(
      principal,
      buildLiveRelaySessionId("client-1", "missing"),
    );
    await f.flow.handleInboxCapture(message("NEVER_REDIRECT"));
    expect(f.replyText).toHaveBeenCalledWith(
      expect.anything(),
      "menu:system.gateway_relay_inbox_failed",
      expect.anything(),
    );
    expect(f.callBroker).toHaveBeenCalledTimes(1);
    expect(await f.snapshot("first")).not.toContain("NEVER_REDIRECT");
    expect(await f.snapshot("second")).not.toContain("NEVER_REDIRECT");
  });
  it("asks for a console when none is selected", async () => {
    const f = fixture();
    await f.flow.handleInboxCapture(message("UNSELECTED"));
    expect(f.callGatewayJson).not.toHaveBeenCalled();
    expect(f.replyText).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("choose a console"),
      expect.anything(),
    );
  });
});
