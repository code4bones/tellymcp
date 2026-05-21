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

describe("BrowserService", () => {
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
        browser: {
          enabled: false,
        },
      } as AppConfig,
      {} as SessionStore,
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
