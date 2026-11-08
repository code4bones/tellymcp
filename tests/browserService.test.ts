import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type {
  SessionBindingStore,
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { MinioExchangeStore } from "../src/services/features/telegram-mcp/src/shared/integrations/object-storage/minioExchangeStore";
import { TelegramTransport } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transport";
import { BrowserService } from "../src/services/features/telegram-mcp/src/features/browser/model/browserService";
import { BrowserDomTool } from "../src/services/features/telegram-mcp/src/features/browser/model/browserDomTool";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("BrowserService", () => {
  it("exposes bounded all-match DOM reads through the MCP schema and the selected attached tab", async () => {
    const batch = {
      found: true,
      total: 2,
      truncated: false,
      url: "https://example.test/",
      title: "Live",
      elements: [
        { index: 0, text_content: "First", attributes: {}, visible: true },
        { index: 1, text_content: "Second", attributes: {}, visible: true },
      ],
    };
    const invokeTabAction = vi.fn().mockResolvedValue(batch);
    const service = new BrowserService(
      {
        distributed: { mode: "client" },
        browser: { enabled: true },
      } as AppConfig,
      {
        getSession: vi.fn().mockResolvedValue({ sessionId: "console" }),
      } as never,
      {
        getBrowserAttachment: vi
          .fn()
          .mockResolvedValue({ instanceId: "chrome", tabId: 7 }),
        setBrowserAttachment: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { info: vi.fn() } as never,
      { resolveSessionDefaults: () => ({ sessionId: "console" }) } as never,
      undefined,
      { invokeTabAction } as never,
    );
    const registerTool = vi.fn();
    new BrowserDomTool(service).register({
      registerTool,
    } as unknown as McpServer);
    const [, metadata, call] = registerTool.mock.calls[0]!;
    const args = metadata.inputSchema.parse({
      session_id: "console",
      selector: '[data-ai-picker="uuid"]',
      all: true,
      limit: 2,
      max_chars: 1024,
      instance_id: "chrome",
      tab_id: 7,
    });
    expect(() =>
      metadata.inputSchema.parse({ all: true, limit: 51 }),
    ).toThrow();
    expect(() =>
      metadata.inputSchema.parse({ all: true, max_chars: 65537 }),
    ).toThrow();
    const output = await call(args);
    expect(metadata.outputSchema.parse(output.structuredContent)).toMatchObject(
      { total: 2, elements: batch.elements },
    );
    expect(invokeTabAction).toHaveBeenCalledWith({
      instanceId: "chrome",
      tabId: 7,
      action: "dom",
      payload: {
        selector: args.selector,
        all: true,
        limit: 2,
        max_chars: 1024,
        include_html: true,
        include_text: true,
      },
    });
    await expect(
      service.getDom({
        session_id: "console",
        all: true,
        instance_id: "another-browser",
        tab_id: 7,
      }),
    ).rejects.toThrow("original marked browser tab");
    await expect(
      service.getDom({
        session_id: "console",
        all: true,
        instance_id: "chrome",
        tab_id: 8,
      }),
    ).rejects.toThrow("original marked browser tab");
    expect(invokeTabAction).toHaveBeenCalledTimes(1);
  });
  it("routes relay browser requests through remote console invoker", async () => {
    const invokeForRelaySession = vi.fn().mockResolvedValue({
      session_id: "relay~client~LEFT",
      opened: true,
      created_context: true,
      url: "https://example.com",
      title: "Example",
    });

    const service = new BrowserService(
      {
        distributed: {
          mode: "gateway",
        },
        browser: {
          enabled: false,
        },
      } as AppConfig,
      {
        getSession: vi.fn<SessionStore["getSession"]>().mockResolvedValue(null),
      } as unknown as SessionStore,
      {
        getGatewayClientUuid: vi.fn(),
      } as unknown as import("../src/services/features/telegram-mcp/src/shared/api/storage/contract").MaintenanceStore,
      {} as SessionBindingStore,
      {} as TelegramXchangeFileMetaStore,
      {} as MinioExchangeStore,
      {} as TelegramTransport,
      {} as Logger,
      {
        resolveSessionDefaults: vi
          .fn<ProjectIdentityResolver["resolveSessionDefaults"]>()
          .mockReturnValue({
            sessionId: "relay~client~LEFT",
            sessionLabel: "LEFT",
            cwd: "/tmp/workspace",
            sessionIdDerived: false,
            sessionLabelDerived: false,
          }),
      } as unknown as ProjectIdentityResolver,
      {
        invokeForRelaySession,
      },
    );

    const output = await service.open({
      session_id: "relay~client~LEFT",
      url: "https://example.com",
    });

    expect(invokeForRelaySession).toHaveBeenCalledWith(
      "relay~client~LEFT",
      "telegramMcp.browser.openRemote",
      {
        session_id: "relay~client~LEFT",
        url: "https://example.com",
      },
    );
    expect(output).toEqual({
      session_id: "relay~client~LEFT",
      opened: true,
      created_context: true,
      url: "https://example.com",
      title: "Example",
    });
  });
});
