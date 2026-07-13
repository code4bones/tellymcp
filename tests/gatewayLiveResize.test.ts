import { afterEach, describe, expect, it } from "vitest";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";
import { ensureTerminalTargetForSession } from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/client";
import {
  getPtyWindowSize,
  stopAllPtyTargets,
} from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry";

const processLiveRequest = GatewaySocketService.methods
  ?.processLiveRequest as unknown as (
  this: Record<string, unknown>,
  request: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

afterEach(() => {
  stopAllPtyTargets();
});

describe("gateway live terminal resize", () => {
  it("applies relayed resize requests to the local PTY", async () => {
    const target = ensureTerminalTargetForSession(
      {
        shell: "/bin/cat",
        cols: 80,
        rows: 24,
        scrollbackLines: 200,
      },
      { sessionId: "relay-resize", cwd: process.cwd() },
    );
    const harness = {
      getRuntimeOrThrow: () => ({
        sessionStore: {
          getSession: async () => ({
            sessionId: "relay-resize",
            terminalTarget: target,
          }),
        },
      }),
    };

    const response = await processLiveRequest.call(harness, {
      type: "live_request",
      request_id: "resize-1",
      request_type: "resize",
      local_session_id: "relay-resize",
      payload: { cols: 132.4, rows: 51.6 },
    });

    expect(response).toMatchObject({
      type: "live_response",
      request_id: "resize-1",
      ok: true,
    });
    expect(getPtyWindowSize(target)).toEqual({ cols: 132, rows: 52 });
  });
});
