import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { BrowserAttachServer } from "../src/services/features/telegram-mcp/src/features/browser-attach/model/browserAttachServer";
import { BrowserPickerDelivery } from "../src/services/features/telegram-mcp/src/features/browser-attach/model/browserPickerDelivery";
import type {
  MaintenanceStore,
  SessionStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import {
  getXchangeRecord,
  listXchangeRecords,
  upsertXchangeRecord,
} from "../src/services/features/telegram-mcp/src/shared/integrations/xchange/sqliteRecordStore";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import { PickerDeliveryClient } from "../packages/attach-extension-shared/src/background";
import type { SelectionContext } from "../packages/attach-extension-shared/src/context";
import { TerminalInputService } from "../src/services/features/telegram-mcp/src/features/terminal-input/model/terminalInputService";
import { stopPtyTarget } from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzksAAAAASUVORK5CYII=";
const selection = () => ({
  status: "selected",
  context: {
    schemaVersion: 1,
    selectionId: "selection",
    requestId: "request",
    timestamp: new Date().toISOString(),
    source: { sessionId: "console", connectionId: "chrome-test", tabId: "7" },
    page: {
      url: "https://example.test/",
      origin: "https://example.test",
      title: "Fixture",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    },
    selection: { mode: "region", rect: { x: 1, y: 1, width: 10, height: 10 } },
    question: "Explain this part",
    redaction: { applied: true, warnings: [] },
    screenshot: {
      mimeType: "image/png",
      width: 1,
      height: 1,
      attachmentId: "selection",
    },
  },
  image: { png_base64: png, width: 1, height: 1 },
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "telly-picker-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const config = {
    terminal: {},
    exchange: { dir: ".mcp-xchange" },
    project: { sessionId: "console" },
  } as AppConfig;
  const sessions = {
    getSession: vi.fn(async () => ({ sessionId: "console", cwd })),
    setSession: vi.fn(async () => {}),
  } as unknown as SessionStore;
  return { cwd, config, sessions };
}

describe("Picker artifact delivery", () => {
  it("persists only marker metadata and the live DOM read command for a marks request", async () => {
    const { cwd, config, sessions } = await fixture();
    const source = selection();
    const groupId = "3df84258-c4a3-4c97-8a10-6518a282ef7e";
    const { screenshot: _screenshot, ...context } = source.context;
    const result = {
      status: "selected",
      context: {
        ...context,
        selection: {
          mode: "marks",
          rect: source.context.selection.rect,
          marks: {
            groupId,
            selector: `[data-ai-picker="${groupId}"]`,
            itemIds: [1, 3],
          },
        },
      },
    };
    const notify = vi.fn().mockResolvedValue({ ok: true });
    const service = new BrowserPickerDelivery(config, sessions, {
      submitHumanMessage: notify,
    });
    const input = {
      sessionId: "console",
      instanceId: "chrome-test",
      tabId: 7,
      result,
      assertBound: async () => {},
    };
    const receipt = await service.deliver(input);
    const body = JSON.parse(
      await readFile(
        path.join(receipt.artifact_path, "selection.json"),
        "utf8",
      ),
    );
    expect(body.context.selection.marks.itemIds).toEqual([1, 3]);
    expect(body.read).toEqual({
      tool: "browser_dom",
      arguments: {
        session_id: "console",
        selector: `[data-ai-picker="${groupId}"]`,
        instance_id: "chrome-test",
        tab_id: 7,
        all: true,
        limit: 50,
        include_html: true,
        include_text: true,
      },
    });
    expect(body.context.selection.element).toBeUndefined();
    expect(body.image_path).toBeUndefined();
    await expect(
      readFile(path.join(receipt.artifact_path, "selection.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const record = await getXchangeRecord(
      config.terminal,
      cwd,
      config.exchange.dir,
      "console",
      receipt.artifact_id,
    );
    expect(record!.tools).toContain("browser_dom");
    for (const mutate of [
      (value: typeof result) => {
        value.context.selection.marks.selector = "body";
      },
      (value: typeof result) => {
        value.context.selection.marks.itemIds = [1, 1];
      },
    ]) {
      const malformed = structuredClone(result);
      mutate(malformed);
      await expect(
        service.deliver({ ...input, result: malformed }),
      ).rejects.toThrow();
    }
    await expect(
      service.deliver({ ...input, result: { ...result, image: source.image } }),
    ).rejects.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("writes question, image and reply metadata before one notification; retries survive a service restart", async () => {
    const { cwd, config, sessions } = await fixture();
    const notify = vi.fn(async () => {
      const records = await listXchangeRecords(
        config.terminal,
        cwd,
        config.exchange.dir,
        "console",
      );
      expect(records).toHaveLength(1);
      const artifact = JSON.parse(
        await readFile(records[0]!.note_path!, "utf8"),
      );
      expect(artifact.context.question).toBe("Explain this part");
      expect(artifact.response.arguments).toEqual({
        session_id: "console",
        request_id: "request",
        selection_id: "selection",
      });
      expect(
        await readFile(
          path.join(path.dirname(records[0]!.note_path!), "selection.png"),
        ),
      ).toEqual(Buffer.from(png, "base64"));
      return { ok: true } as never;
    });
    const service = new BrowserPickerDelivery(config, sessions, {
      submitHumanMessage: notify,
    });
    const input = {
      sessionId: "console",
      instanceId: "chrome-test",
      tabId: 7,
      result: selection(),
      assertBound: vi.fn(async () => {}),
    };
    const [first, duplicate] = await Promise.all([
      service.deliver(input),
      service.deliver(input),
    ]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ ok: true, saved: true, notified: true });
    expect(first.artifact_path).toMatch(
      /\.mcp-xchange[/\\]\d{4}-\d{2}-\d{2}[/\\]picker[/\\]picker-[a-f0-9]{32}$/,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      session_id: "console",
      source_label: "Browser Picker",
    });
    expect(JSON.stringify(notify.mock.calls)).not.toContain(
      "Explain this part",
    );
    const restart = new BrowserPickerDelivery(config, sessions, {
      submitHumanMessage: notify,
    });
    expect(await restart.deliver(input)).toEqual(first);
    expect(notify).toHaveBeenCalledTimes(1);
    const record = await getXchangeRecord(
      config.terminal,
      cwd,
      config.exchange.dir,
      "console",
      first.artifact_id,
    );
    expect(record).toMatchObject({
      category: "local_handoff",
      kind: "browser_picker",
      requires_reply: true,
    });
    expect(record!.tags).toContain("picker-notified");
    const changed = structuredClone(input.result);
    changed.context.question = "Changed without a new request ID";
    await expect(
      restart.deliver({ ...input, result: changed }),
    ).rejects.toThrow("reused");
    await upsertXchangeRecord(config.terminal, cwd, config.exchange.dir, {
      ...record!,
      tags: ["browser-picker", "picker-notifying"],
    });
    expect(await restart.deliver(input)).toMatchObject({
      ok: false,
      saved: true,
      notified: false,
      error: expect.stringContaining("uncertain"),
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("preserves artifacts on notification failure, allows explicit retry and rejects forged or expired sources", async () => {
    const { cwd, config, sessions } = await fixture();
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("No PTY"))
      .mockResolvedValue({ ok: true });
    const service = new BrowserPickerDelivery(config, sessions, {
      submitHumanMessage: notify,
    });
    const input = {
      sessionId: "console",
      instanceId: "chrome-test",
      tabId: 7,
      result: selection(),
      assertBound: vi.fn(async () => {}),
    };
    const failure = await service.deliver(input);
    expect(failure).toMatchObject({ ok: false, saved: true, notified: false });
    expect(
      JSON.parse(
        await readFile(
          path.join(failure.artifact_path, "selection.json"),
          "utf8",
        ),
      ),
    ).toHaveProperty("context.question", "Explain this part");
    expect(await service.deliver(input)).toMatchObject({
      ok: true,
      notified: true,
    });
    for (const change of [
      (value: ReturnType<typeof selection>) => {
        value.context.source.connectionId = "forged";
      },
      (value: ReturnType<typeof selection>) => {
        value.context.source.sessionId = "other";
      },
      (value: ReturnType<typeof selection>) => {
        value.context.page.url += "?token=secret";
      },
      (value: ReturnType<typeof selection>) => {
        value.context.timestamp = new Date(Date.now() - 300001).toISOString();
      },
      (value: ReturnType<typeof selection>) => {
        value.image.width = 4;
      },
    ]) {
      const result = selection();
      change(result);
      await expect(service.deliver({ ...input, result })).rejects.toThrow();
    }
    expect(notify).toHaveBeenCalledTimes(2);
    expect(
      await listXchangeRecords(
        config.terminal,
        cwd,
        config.exchange.dir,
        "console",
      ),
    ).toHaveLength(1);
  });

  it("pulls over the real owner socket, acknowledges disk+PTY delivery and denies another instance or tab", async () => {
    const { cwd, config, sessions } = await fixture();
    const portServer = createServer();
    await new Promise<void>((resolve) =>
      portServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    config.browser = {
      timeoutMs: 500,
      attach: {
        enabled: true,
        host: "127.0.0.1",
        port,
        path: "/browser-attach/ws",
      },
    } as AppConfig["browser"];
    let attached = { instanceId: "chrome-test", tabId: 7 };
    const maintenance = {
      getBrowserAttachment: vi.fn(async () => attached),
      getBrowserRecording: vi.fn(async () => null),
      getGatewayClientUuid: vi.fn(async () => "client-uuid"),
    } as unknown as MaintenanceStore;
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } satisfies Logger;
    const inputShell = path.join(cwd, "input-reader");
    config.distributed = { mode: "client" } as AppConfig["distributed"];
    await writeFile(
      inputShell,
      '#!/bin/sh\nIFS= read -r line\nprintf "%s" "$line" > terminal-input.txt\n',
      { mode: 0o700 },
    );
    config.terminal.shell = inputShell;
    cleanups.unshift(async () => {
      stopPtyTarget("pty:console");
    });
    const terminalInput = new TerminalInputService(config, sessions, logger);
    const notify = vi.fn(terminalInput.submitHumanMessage.bind(terminalInput));
    const server = new BrowserAttachServer(
      config,
      logger,
      sessions,
      maintenance,
      { submitHumanMessage: notify },
    );
    await server.start();
    cleanups.unshift(() => server.stop());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/browser-attach/ws`, {
      origin: "chrome-extension://test-extension",
    });
    const messages: Array<Record<string, unknown>> = [];
    let current = selection();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      if (message.type === "tab_action")
        socket.send(
          JSON.stringify({
            type: "tab_action_result",
            request_id: message.request_id,
            ok: true,
            result: current,
          }),
        );
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    cleanups.unshift(async () => {
      socket.close();
      await new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        extension_version: "0.0.10",
        browser: "chrome",
        instance_id: "chrome-test",
      }),
    );
    await expect
      .poll(() => messages.find((m) => m.type === "hello_ack"))
      .toMatchObject({
        capabilities: expect.arrayContaining(["picker_delivery"]),
      });
    const submit = async (requestId = "request", tabId = 7) => {
      messages.length = 0;
      socket.send(
        JSON.stringify({
          type: "picker_submit",
          request_id: requestId,
          selection_id: "selection",
          tab_id: tabId,
        }),
      );
      await expect
        .poll(() => messages.find((m) => m.type === "picker_submit_result"))
        .toBeDefined();
      return messages.find((m) => m.type === "picker_submit_result")!;
    };
    expect(await submit()).toMatchObject({
      ok: true,
      saved: true,
      notified: true,
    });
    await expect
      .poll(async () =>
        readFile(path.join(cwd, "terminal-input.txt"), "utf8").catch(() => ""),
      )
      .toContain("Browser Picker request picker-");
    expect(
      await readFile(path.join(cwd, "terminal-input.txt"), "utf8"),
    ).toContain("inspector_response");
    expect(await submit()).toMatchObject({ ok: true });
    const records = await listXchangeRecords(
      config.terminal,
      cwd,
      config.exchange.dir,
      "console",
    );
    expect(
      JSON.parse(records[0]!.body_text).response.arguments.session_id,
    ).toBe("client-uuid:console");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await submit("wrong-tab", 8)).toMatchObject({ ok: false });
    attached = { instanceId: "another-instance", tabId: 7 };
    expect(await submit("wrong-instance")).toMatchObject({ ok: false });
    attached = { instanceId: "chrome-test", tabId: 7 };
    current = selection();
    current.context.source.connectionId = "forged";
    expect(await submit()).toMatchObject({ ok: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      await listXchangeRecords(
        config.terminal,
        cwd,
        config.exchange.dir,
        "console",
      ),
    ).toHaveLength(1);
  });
});

describe("Picker delivery acknowledgement client", () => {
  it("waits for ACK, coalesces clicks, handles timeout/disconnect and never sends to an older owner", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const client = new PickerDeliveryClient(send);
    const context = selection().context as SelectionContext;
    expect(await client.submit(7, context)).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
    client.bind(true);
    const promise = client.submit(7, context);
    expect(client.submit(7, context)).toBe(promise);
    expect(send).toHaveBeenCalledTimes(1);
    client.receive({ request_id: "wrong", ok: true });
    client.receive({
      request_id: "request",
      ok: true,
      artifact_id: "saved",
      notified: true,
    });
    expect(await promise).toMatchObject({ ok: true, notified: true });
    const timed = client.submit(7, context);
    await vi.advanceTimersByTimeAsync(35000);
    expect(await timed).toMatchObject({
      ok: false,
      error: expect.stringContaining("timed out"),
    });
    const disconnected = client.submit(7, context);
    client.disconnect();
    expect(await disconnected).toMatchObject({
      ok: false,
      error: expect.stringContaining("disconnected"),
    });
    expect(await client.submit(7, context)).toMatchObject({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
