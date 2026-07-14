import { describe, expect, it, vi } from "vitest";

import type {
  SessionBindingStore,
  SessionStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { SessionContextService } from "../src/services/features/telegram-mcp/src/features/session-context/model/sessionContextService";

function createService(input?: {
  mode?: "client" | "gateway" | "both";
  remoteInvoke?: ReturnType<typeof vi.fn>;
}) {
  const sessionStore = {
    getSession: vi.fn().mockResolvedValue({
      sessionId: "Biolerplate",
      terminalTarget: "pty:Biolerplate",
      updatedAt: "2026-07-14T00:00:00.000Z",
    }),
  } as unknown as SessionStore;
  const bindingStore = {
    getBinding: vi.fn().mockResolvedValue(null),
  } as unknown as SessionBindingStore;
  const logger = {
    debug: vi.fn(),
  } as unknown as Logger;
  const projectIdentityResolver = {
    resolveSessionDefaults: vi.fn().mockReturnValue({
      sessionId: "Biolerplate",
      sessionLabel: "Biolerplate",
      cwd: "/workspace",
      sessionIdDerived: false,
      sessionLabelDerived: false,
    }),
  } as unknown as ProjectIdentityResolver;
  const remoteInvoke = input?.remoteInvoke ?? vi.fn();

  return {
    remoteInvoke,
    service: new SessionContextService(
      sessionStore,
      bindingStore,
      logger,
      projectIdentityResolver,
      { invokeForRelaySession: remoteInvoke },
      {
        mode: input?.mode ?? "client",
        packageVersion: "0.0.14",
        protocolVersion: "1.0",
        nodeId: "Undoo",
        gatewayWsUrlConfigured: true,
        gatewayAuthConfigured: true,
        pingRedis: vi.fn().mockResolvedValue("PONG"),
      },
    ),
  };
}

describe("SessionContextService routing and diagnostics", () => {
  it("does not relay a remote session-context action again on a client", async () => {
    const { service, remoteInvoke } = createService({ mode: "client" });

    const output = await service.getContext({ session_id: "Biolerplate" });

    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      session_id: "Biolerplate",
      exists: true,
      terminal: { configured: true },
    });
  });

  it("reports safe local runtime health without exposing connection values", async () => {
    const { service, remoteInvoke } = createService({ mode: "client" });

    const output = await service.getRuntimeDiagnostics({
      session_id: "Biolerplate",
    });

    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      status: "ok",
      session_id: "Biolerplate",
      runtime: {
        mode: "client",
        package_version: "0.0.14",
        protocol_version: "1.0",
        node_id: "Undoo",
      },
      checks: {
        configuration: { status: "ok" },
        redis: { status: "ok" },
        session_store: { status: "ok" },
        terminal: { status: "ok" },
        gateway_configuration: { status: "ok" },
        relay: { status: "ok" },
      },
    });
    expect(JSON.stringify(output)).not.toContain("ws://");
    expect(JSON.stringify(output)).not.toContain("token");
  });

  it("marks an end-to-end gateway relay as healthy", async () => {
    const remoteInvoke = vi.fn().mockResolvedValue({
      status: "ok",
      checked_at: "2026-07-14T00:00:00.000Z",
      session_id: "Biolerplate",
      runtime: {
        mode: "client",
        package_version: "0.0.14",
        protocol_version: "1.0",
      },
      checks: {
        configuration: { status: "ok", message: "ok" },
        redis: { status: "ok", message: "ok" },
        session_store: { status: "ok", message: "ok" },
        terminal: { status: "ok", message: "ok" },
        gateway_configuration: { status: "ok", message: "ok" },
        relay: { status: "ok", message: "local" },
      },
    });
    const { service } = createService({ mode: "gateway", remoteInvoke });

    const output = await service.getRuntimeDiagnostics({
      session_id: "client:Biolerplate",
    });

    expect(remoteInvoke).toHaveBeenCalledWith(
      "Biolerplate",
      "telegramMcp.sessionContext.getRuntimeDiagnosticsRemote",
      { session_id: "client:Biolerplate" },
    );
    expect(output.status).toBe("ok");
    expect(output.checks.relay).toEqual({
      status: "ok",
      message: "Gateway-to-client relay completed successfully.",
    });
  });
});
