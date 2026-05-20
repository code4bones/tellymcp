import { describe, expect, it, vi } from "vitest";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";

type MockFn = ReturnType<typeof vi.fn>;

type GatewaySocketDelivery = {
  delivery_uuid: string;
  message_uuid: string;
  share_id: string;
  kind: string;
  summary: string;
  message: string;
  requires_reply: boolean;
  source_session_uuid: string;
  source_session_label: string;
  source_local_session_id: string;
  target_session_uuid: string;
  target_local_session_id: string;
  target_session_label: string;
  created_at: string;
  note_relative_path: string;
  artifacts: unknown[];
};

type GatewaySocketDeliveryStatus = {
  delivery_uuid: string;
  share_id: string;
  status: string;
};

type GatewaySocketMethods = {
  fetchGatewayToolsHashForClient: () => Promise<string | null>;
  handleGatewayWsClientMessage: (raw: unknown) => Promise<void>;
  notifyProjectMemberJoined: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
    memberDisplayName?: string;
    memberTelegramUsername?: string;
  }) => Promise<number>;
  notifyProjectMemberLeft: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
    memberDisplayName?: string;
    memberTelegramUsername?: string;
  }) => Promise<number>;
  notifyProjectDeleted: (params: {
    clientUuids: string[];
    projectUuid: string;
    projectName: string;
  }) => Promise<number>;
  notifyLiveApprovalRequest: (params: {
    clientUuid: string;
    payload: Record<string, unknown>;
  }) => Promise<boolean>;
  notifyLiveApprovalResolved: (params: {
    clientUuid: string;
    approved: boolean;
    payload: Record<string, unknown>;
  }) => Promise<boolean>;
  notifyDeliveryQueued: (params: {
    clientUuid: string;
    delivery: GatewaySocketDelivery;
  }) => Promise<boolean>;
  notifyDeliveryStatus: (params: {
    clientUuid: string;
    status: GatewaySocketDeliveryStatus;
  }) => Promise<boolean>;
};

type GatewaySocketHarness = {
  broker: {
    call: MockFn;
  };
  wsClient: {
    send: MockFn;
  } | null;
  connectedClientsByUuid: Map<string, { readyState: number; send: MockFn }>;
  getRuntimeOrThrow: () => {
    logger: {
      debug: MockFn;
      info: MockFn;
      warn: MockFn;
    };
    telegramTransport: {
      handleProjectMemberJoinedEvent: MockFn;
      handleProjectMemberLeftEvent: MockFn;
      handleProjectDeletedEvent: MockFn;
      handleToolsUpdatedEvent: MockFn;
      handleGatewayVersionCompatibilityEvent: MockFn;
      handleLiveViewApprovalRequestEvent: MockFn;
      handleLiveViewApprovalResolvedEvent: MockFn;
    };
  };
  isLocalGatewayClientUuid: MockFn;
  handleLocalIncomingDelivery: MockFn;
  handleLocalDeliveryStatus: MockFn;
  fetchGatewayToolsHashForClient: GatewaySocketMethods["fetchGatewayToolsHashForClient"];
  handleGatewayWsClientMessage: GatewaySocketMethods["handleGatewayWsClientMessage"];
  notifyProjectMemberJoined: GatewaySocketMethods["notifyProjectMemberJoined"];
  notifyProjectMemberLeft: GatewaySocketMethods["notifyProjectMemberLeft"];
  notifyProjectDeleted: GatewaySocketMethods["notifyProjectDeleted"];
  notifyLiveApprovalRequest: GatewaySocketMethods["notifyLiveApprovalRequest"];
  notifyLiveApprovalResolved: GatewaySocketMethods["notifyLiveApprovalResolved"];
  notifyDeliveryQueued: GatewaySocketMethods["notifyDeliveryQueued"];
  notifyDeliveryStatus: GatewaySocketMethods["notifyDeliveryStatus"];
};

const methods = GatewaySocketService.methods as unknown as GatewaySocketMethods;

function createDelivery(
  overrides?: Partial<GatewaySocketDelivery>,
): GatewaySocketDelivery {
  return {
    delivery_uuid: "delivery-1",
    message_uuid: "message-1",
    share_id: "share-1",
    kind: "question",
    summary: "Сколько места на диске?",
    message: "Ответь, сколько свободного места на диске",
    requires_reply: true,
    source_session_uuid: "source-uuid",
    source_session_label: "leftDev",
    source_local_session_id: "left-local",
    target_session_uuid: "target-uuid",
    target_local_session_id: "backend-local",
    target_session_label: "backend",
    created_at: "2026-05-16T00:00:00.000Z",
    note_relative_path: "shares/share-1.md",
    artifacts: [],
    ...overrides,
  };
}

function createStatus(
  overrides?: Partial<GatewaySocketDeliveryStatus>,
): GatewaySocketDeliveryStatus {
  return {
    delivery_uuid: "delivery-1",
    share_id: "share-1",
    status: "delivered",
    ...overrides,
  };
}

function createHarness(): GatewaySocketHarness {
  const runtime = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    telegramTransport: {
      handleProjectMemberJoinedEvent: vi.fn(async () => undefined),
      handleProjectMemberLeftEvent: vi.fn(async () => undefined),
      handleProjectDeletedEvent: vi.fn(async () => undefined),
      handleToolsUpdatedEvent: vi.fn(async () => undefined),
      handleGatewayVersionCompatibilityEvent: vi.fn(async () => undefined),
      handleLiveViewApprovalRequestEvent: vi.fn(async () => undefined),
      handleLiveViewApprovalResolvedEvent: vi.fn(async () => undefined),
    },
  };

  return {
    broker: {
      call: vi.fn(),
    },
    wsClient: {
      send: vi.fn(),
    },
    connectedClientsByUuid: new Map(),
    getRuntimeOrThrow: () => runtime,
    isLocalGatewayClientUuid: vi.fn(async () => false),
    handleLocalIncomingDelivery: vi.fn(async () => false),
    handleLocalDeliveryStatus: vi.fn(async () => false),
    fetchGatewayToolsHashForClient: methods.fetchGatewayToolsHashForClient,
    handleGatewayWsClientMessage: methods.handleGatewayWsClientMessage,
    notifyProjectMemberJoined: methods.notifyProjectMemberJoined,
    notifyProjectMemberLeft: methods.notifyProjectMemberLeft,
    notifyProjectDeleted: methods.notifyProjectDeleted,
    notifyLiveApprovalRequest: methods.notifyLiveApprovalRequest,
    notifyLiveApprovalResolved: methods.notifyLiveApprovalResolved,
    notifyDeliveryQueued: methods.notifyDeliveryQueued,
    notifyDeliveryStatus: methods.notifyDeliveryStatus,
  };
}

describe("gatewaySocket service", () => {
  it("dispatches member_joined project events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "project_event",
        event: "member_joined",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
          member_display_name: "Петр Олесов",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectMemberJoinedEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
      member_display_name: "Петр Олесов",
    });
  });

  it("dispatches member_left project events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "project_event",
        event: "member_left",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
          member_telegram_username: "dead_ragdoll",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectMemberLeftEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
      member_telegram_username: "dead_ragdoll",
    });
  });

  it("dispatches project_deleted events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "project_event",
        event: "project_deleted",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectDeletedEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
    });
  });

  it("dispatches tools_updated events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "tools_event",
        payload: {
          local_session_id: "left-session",
          session_label: "leftDev",
          gateway_tools_hash: "gateway-hash",
          client_tools_hash: "old-hash",
          reason: "outdated",
          instruction:
            "Call refresh_tools_markdown for this session, then re-read the local TOOLS.md and apply it before continuing.",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleToolsUpdatedEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        local_session_id: "left-session",
        session_label: "leftDev",
        gateway_tools_hash: "gateway-hash",
        reason: "outdated",
      }),
    );
  });

  it("dispatches gateway version warnings to telegram transport on hello_ack", async () => {
    const harness = createHarness();
    const wsClient = {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };

    await harness.handleGatewayWsClientMessage.call({
      ...harness,
      wsClient,
      wsHelloClientUuid: "client-1",
      wsHelloSessionTools: [
        {
          local_session_id: "left-session",
          session_label: "leftDev",
        },
      ],
      getLocalVersionInfo: () => ({
        packageVersion: "0.1.0",
        protocolVersion: "1.0",
        capabilities: ["tools_sync", "version_handshake"],
      }),
      syncLocalToolsAgainstGateway: vi.fn(async () => 0),
    },
    JSON.stringify({
      type: "hello_ack",
      connection_id: "conn-1",
      package_version: "0.2.0",
      protocol_version: "1.1",
      capabilities: ["tools_sync", "version_handshake", "live_relay"],
      compatibility: "warn",
      reasons: ["Package version mismatch: client 0.1.0 vs gateway 0.2.0."],
      instruction: "Upgrade the older side.",
    }));

    expect(
      harness.getRuntimeOrThrow().telegramTransport
        .handleGatewayVersionCompatibilityEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        local_session_id: "left-session",
        session_label: "leftDev",
        compatibility: "warn",
        gateway_package_version: "0.2.0",
        gateway_protocol_version: "1.1",
      }),
    );
    expect(wsClient.close).not.toHaveBeenCalled();
  });

  it("closes ws client on rejected hello_ack compatibility", async () => {
    const harness = createHarness();
    const wsClient = {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
    const syncLocalToolsAgainstGateway = vi.fn(async () => 0);

    await harness.handleGatewayWsClientMessage.call({
      ...harness,
      wsClient,
      wsHelloClientUuid: "client-1",
      wsHelloSessionTools: [
        {
          local_session_id: "left-session",
          session_label: "leftDev",
        },
      ],
      getLocalVersionInfo: () => ({
        packageVersion: "0.1.0",
        protocolVersion: "1.0",
        capabilities: ["tools_sync", "version_handshake"],
      }),
      syncLocalToolsAgainstGateway,
    },
    JSON.stringify({
      type: "hello_ack",
      connection_id: "conn-1",
      package_version: "0.2.0",
      protocol_version: "2.0",
      capabilities: ["tools_sync", "version_handshake"],
      compatibility: "reject",
      reasons: ["Protocol major mismatch: client 1.0 vs gateway 2.0."],
      instruction: "Upgrade this client before continuing.",
    }));

    expect(wsClient.close).toHaveBeenCalledWith(4002, "version_incompatible");
    expect(syncLocalToolsAgainstGateway).not.toHaveBeenCalled();
  });

  it("uses local gateway TOOLS hash in both mode without remote fetch", async () => {
    const harness = createHarness();
    const hash = await harness.fetchGatewayToolsHashForClient.call({
      ...harness,
      getGatewayToolsHash: () => "local-gateway-hash",
      getRuntimeOrThrow: () => ({
        ...harness.getRuntimeOrThrow(),
        config: {
          distributed: {
            mode: "both",
          },
        },
      }),
    });

    expect(hash).toBe("local-gateway-hash");
  });

  it("materializes incoming delivery and sends delivery_ack over ws", async () => {
    const harness = createHarness();
    const delivery = createDelivery();
    harness.broker.call.mockResolvedValue(undefined);

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "delivery_event",
        event: "incoming_delivery",
        payload: delivery,
      }),
    );

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewayDelivery.materializeIncomingDelivery",
      { delivery },
      { meta: { internal_call: true } },
    );
    expect(harness.wsClient?.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "delivery_ack",
        delivery_ids: ["delivery-1"],
      }),
    );
  });

  it("dispatches live approval request events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "live_event",
        event: "approval_request",
        payload: {
          source_session_id: "source-session",
          source_session_label: "leftDev",
          source_client_uuid: "source-client",
          source_local_session_id: "left-local",
          target_session_id: "target-session",
          target_session_label: "backend",
          target_client_uuid: "target-client",
          target_local_session_id: "backend-local",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleLiveViewApprovalRequestEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        source_session_label: "leftDev",
        target_session_label: "backend",
      }),
    );
  });

  it("dispatches live approval resolution events to telegram transport", async () => {
    const harness = createHarness();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "live_event",
        event: "approval_granted",
        payload: {
          source_session_id: "source-session",
          source_session_label: "leftDev",
          source_client_uuid: "source-client",
          source_local_session_id: "left-local",
          target_session_id: "target-session",
          target_session_label: "backend",
          target_client_uuid: "target-client",
          target_local_session_id: "backend-local",
        },
      }),
    );

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleLiveViewApprovalResolvedEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        approved: true,
        source_session_label: "leftDev",
        target_session_label: "backend",
      }),
    );
  });

  it("sends delivery_fail when materialization throws", async () => {
    const harness = createHarness();
    const delivery = createDelivery();
    harness.broker.call.mockRejectedValue(new Error("boom"));

    await expect(
      harness.handleGatewayWsClientMessage(
        JSON.stringify({
          type: "delivery_event",
          event: "incoming_delivery",
          payload: delivery,
        }),
      ),
    ).rejects.toThrow("boom");

    expect(harness.wsClient?.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "delivery_fail",
        delivery_ids: ["delivery-1"],
        error_text: "boom",
      }),
    );
  });

  it("applies outgoing delivery status events through broker", async () => {
    const harness = createHarness();
    const status = createStatus();

    await harness.handleGatewayWsClientMessage(
      JSON.stringify({
        type: "delivery_status_event",
        payload: status,
      }),
    );

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewayDelivery.applyOutgoingDeliveryStatus",
      { status },
      { meta: { internal_call: true } },
    );
  });

  it("notifies joined members locally and over remote sockets", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.isLocalGatewayClientUuid.mockImplementation(
      async (clientUuid: string) => clientUuid === "local-client",
    );

    const delivered = await harness.notifyProjectMemberJoined({
      clientUuids: ["local-client", "remote-client", "offline-client"],
      projectUuid: "project-1",
      projectName: "Project One",
      memberDisplayName: "Петр Олесов",
    });

    expect(delivered).toBe(2);
    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectMemberJoinedEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
      member_display_name: "Петр Олесов",
    });
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "project_event",
        event: "member_joined",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
          member_display_name: "Петр Олесов",
        },
      }),
    );
  });

  it("notifies left members locally and over remote sockets", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.isLocalGatewayClientUuid.mockImplementation(
      async (clientUuid: string) => clientUuid === "local-client",
    );

    const delivered = await harness.notifyProjectMemberLeft({
      clientUuids: ["local-client", "remote-client", "offline-client"],
      projectUuid: "project-1",
      projectName: "Project One",
      memberTelegramUsername: "dead_ragdoll",
    });

    expect(delivered).toBe(2);
    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectMemberLeftEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
      member_telegram_username: "dead_ragdoll",
    });
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "project_event",
        event: "member_left",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
          member_telegram_username: "dead_ragdoll",
        },
      }),
    );
  });

  it("notifies deleted projects locally and over remote sockets", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.isLocalGatewayClientUuid.mockImplementation(
      async (clientUuid: string) => clientUuid === "local-client",
    );

    const delivered = await harness.notifyProjectDeleted({
      clientUuids: ["local-client", "remote-client", "offline-client"],
      projectUuid: "project-1",
      projectName: "Project One",
    });

    expect(delivered).toBe(2);
    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleProjectDeletedEvent,
    ).toHaveBeenCalledWith({
      project_uuid: "project-1",
      project_name: "Project One",
    });
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "project_event",
        event: "project_deleted",
        payload: {
          project_uuid: "project-1",
          project_name: "Project One",
        },
      }),
    );
  });

  it("publishes queued delivery through local loopback before ws", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    const delivery = createDelivery();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.handleLocalIncomingDelivery.mockResolvedValue(true);

    const published = await harness.notifyDeliveryQueued({
      clientUuid: "remote-client",
      delivery,
    });

    expect(published).toBe(true);
    expect(harness.handleLocalIncomingDelivery).toHaveBeenCalledWith({
      clientUuid: "remote-client",
      delivery,
    });
    expect(remoteSend).not.toHaveBeenCalled();
  });

  it("publishes queued delivery over remote ws when no local loopback applies", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    const delivery = createDelivery();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });

    const published = await harness.notifyDeliveryQueued({
      clientUuid: "remote-client",
      delivery,
    });

    expect(published).toBe(true);
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "delivery_event",
        event: "incoming_delivery",
        payload: delivery,
      }),
    );
  });

  it("returns false for queued delivery when no local or remote target is available", async () => {
    const harness = createHarness();

    const published = await harness.notifyDeliveryQueued({
      clientUuid: "offline-client",
      delivery: createDelivery(),
    });

    expect(published).toBe(false);
  });

  it("publishes delivery status through local loopback before ws", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    const status = createStatus();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.handleLocalDeliveryStatus.mockResolvedValue(true);

    const published = await harness.notifyDeliveryStatus({
      clientUuid: "remote-client",
      status,
    });

    expect(published).toBe(true);
    expect(harness.handleLocalDeliveryStatus).toHaveBeenCalledWith({
      clientUuid: "remote-client",
      status,
    });
    expect(remoteSend).not.toHaveBeenCalled();
  });

  it("publishes delivery status over remote ws when no local loopback applies", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    const status = createStatus();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });

    const published = await harness.notifyDeliveryStatus({
      clientUuid: "remote-client",
      status,
    });

    expect(published).toBe(true);
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "delivery_status_event",
        payload: status,
      }),
    );
  });

  it("returns false for delivery status when no local or remote target is available", async () => {
    const harness = createHarness();

    const published = await harness.notifyDeliveryStatus({
      clientUuid: "offline-client",
      status: createStatus(),
    });

    expect(published).toBe(false);
  });

  it("notifies live approval requests locally and over remote sockets", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.isLocalGatewayClientUuid.mockImplementation(
      async (clientUuid: string) => clientUuid === "local-client",
    );

    await expect(
      harness.notifyLiveApprovalRequest({
        clientUuid: "local-client",
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    ).resolves.toBe(true);

    await expect(
      harness.notifyLiveApprovalRequest({
        clientUuid: "remote-client",
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    ).resolves.toBe(true);

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleLiveViewApprovalRequestEvent,
    ).toHaveBeenCalled();
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "live_event",
        event: "approval_request",
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    );
  });

  it("notifies live approval resolutions locally and over remote sockets", async () => {
    const harness = createHarness();
    const remoteSend = vi.fn();
    harness.connectedClientsByUuid.set("remote-client", {
      readyState: 1,
      send: remoteSend,
    });
    harness.isLocalGatewayClientUuid.mockImplementation(
      async (clientUuid: string) => clientUuid === "local-client",
    );

    await expect(
      harness.notifyLiveApprovalResolved({
        clientUuid: "local-client",
        approved: true,
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    ).resolves.toBe(true);

    await expect(
      harness.notifyLiveApprovalResolved({
        clientUuid: "remote-client",
        approved: false,
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    ).resolves.toBe(true);

    expect(
      harness.getRuntimeOrThrow().telegramTransport.handleLiveViewApprovalResolvedEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        approved: true,
      }),
    );
    expect(remoteSend).toHaveBeenCalledWith(
      JSON.stringify({
        type: "live_event",
        event: "approval_denied",
        payload: {
          source_session_label: "leftDev",
          target_session_label: "backend",
        },
      }),
    );
  });
});
