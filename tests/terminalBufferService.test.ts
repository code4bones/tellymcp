import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { SessionStore } from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { TerminalBufferService } from "../src/services/features/telegram-mcp/src/features/terminal-buffer/model/terminalBufferService";

describe("TerminalBufferService", () => {
  it("routes relay buffer capture through remote console invoker", async () => {
    const invokeForRelaySession = vi.fn().mockResolvedValue({
      session_id: "relay~client~LEFT",
      terminal_target: "pty:LEFT",
      filename: "left.md",
      markdown_content: "# Terminal Buffer\n",
      capture_mode: "visible",
      scope_description: "visible pane",
    });

    const service = new TerminalBufferService(
      {
        terminal: {
          captureLines: 200,
        },
      } as AppConfig,
      {} as SessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
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

    const output = await service.captureBuffer({
      session_id: "relay~client~LEFT",
      scope: { mode: "visible" },
    });

    expect(invokeForRelaySession).toHaveBeenCalledWith(
      "relay~client~LEFT",
      "telegramMcp.terminalBuffer.captureBufferRemote",
      {
        session_id: "relay~client~LEFT",
        scope: { mode: "visible" },
      },
    );
    expect(output).toEqual({
      session_id: "relay~client~LEFT",
      terminal_target: "pty:LEFT",
      filename: "left.md",
      markdown_content: "# Terminal Buffer\n",
      capture_mode: "visible",
      scope_description: "visible pane",
    });
  });
});
