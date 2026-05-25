import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock(
  "../src/services/features/telegram-mcp/src/shared/integrations/terminal/client",
  () => ({
    ensureXchangeDir: vi.fn(async () => "/workspace/.mcp-xchange"),
    writeXchangeRelativeFile: vi.fn(),
  }),
);

vi.mock(
  "../src/services/features/telegram-mcp/src/shared/integrations/xchange/sqliteRecordStore",
  () => ({
    upsertXchangeRecord: vi.fn(),
  }),
);

import GatewayDeliveryService from "../src/services/features/telegram-mcp/gateway-delivery.service";
import { writeXchangeRelativeFile } from "../src/services/features/telegram-mcp/src/shared/integrations/terminal/client";
import { upsertXchangeRecord } from "../src/services/features/telegram-mcp/src/shared/integrations/xchange/sqliteRecordStore";

type GatewayDelivery = {
  delivery_uuid: string;
  message_uuid: string;
  share_id: string;
  project_uuid?: string;
  project_name?: string;
  source_actor_label?: string;
  kind: string;
  summary: string;
  message: string;
  expected_reply?: string;
  requires_reply: boolean;
  in_reply_to?: string;
  source_session_uuid: string;
  source_session_label: string;
  source_local_session_id: string;
  target_session_uuid: string;
  target_local_session_id: string;
  target_session_label: string;
  created_at: string;
  note_relative_path: string;
  artifacts: Array<{
    artifact_uuid: string;
    original_name: string;
    mime_type?: string;
    size_bytes?: number;
    storage_ref?: string;
    relative_path?: string;
    content_base64?: string;
  }>;
};

type GatewayDeliveryStatus = {
  delivery_uuid: string;
  share_id: string;
  status: string;
  delivered_at?: string;
  acked_at?: string;
};

type GatewayDeliveryMethods = {
  materializeIncomingDelivery: (delivery: GatewayDelivery) => Promise<void>;
  applyOutgoingDeliveryStatus: (status: GatewayDeliveryStatus) => Promise<void>;
};

type RuntimeHarness = {
  getRuntimeOrThrow: () => {
    sessionStore: {
      getSession: ReturnType<typeof vi.fn>;
    };
    bindingStore: {
      getBinding: ReturnType<typeof vi.fn>;
    };
    objectStore: {
      resolveWorkspaceDir: ReturnType<typeof vi.fn>;
      ensureLocalFile: ReturnType<typeof vi.fn>;
    };
    xchangeFileMetaStore: {
      setXchangeFileMeta: ReturnType<typeof vi.fn>;
    };
    inboxStore: {
      createInboxMessage: ReturnType<typeof vi.fn>;
    };
    maintenanceStore: {
      listOutgoingDeliveryNotices: ReturnType<typeof vi.fn>;
      deleteOutgoingDeliveryNotice: ReturnType<typeof vi.fn>;
    };
    telegramTransport: {
      sendNotification: ReturnType<typeof vi.fn>;
      nudgeSessionPartnerNote: ReturnType<typeof vi.fn>;
      editChatMessage: ReturnType<typeof vi.fn>;
    };
    logger: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
    config: {
      terminal: Record<string, unknown>;
      exchange: {
        dir: string;
      };
    };
  };
};

const methods = GatewayDeliveryService.methods as unknown as GatewayDeliveryMethods;
const mockedWriteXchangeRelativeFile = vi.mocked(writeXchangeRelativeFile);
const mockedUpsertXchangeRecord = vi.mocked(upsertXchangeRecord);

function createDelivery(overrides?: Partial<GatewayDelivery>): GatewayDelivery {
  return {
    delivery_uuid: "delivery-1",
    message_uuid: "message-1",
    share_id: "share-1",
    project_uuid: "project-1",
    project_name: "Project One",
    source_actor_label: "Петр Олесов",
    kind: "question",
    summary: "Опиши REST API",
    message: "Нужно описание REST API",
    requires_reply: true,
    source_session_uuid: "source-session-uuid",
    source_session_label: "leftDev",
    source_local_session_id: "left-local",
    target_session_uuid: "target-session-uuid",
    target_local_session_id: "backend-local",
    target_session_label: "backend",
    created_at: "2026-05-16T00:00:00.000Z",
    note_relative_path: "shares/share-1.md",
    artifacts: [],
    ...overrides,
  };
}

function createRuntimeHarness(): RuntimeHarness {
  const runtime = {
    sessionStore: {
      getSession: vi.fn(),
    },
    bindingStore: {
      getBinding: vi.fn(),
    },
    objectStore: {
      resolveWorkspaceDir: vi.fn(() => "/workspace"),
      ensureLocalFile: vi.fn(),
    },
    xchangeFileMetaStore: {
      setXchangeFileMeta: vi.fn(),
    },
    inboxStore: {
      createInboxMessage: vi.fn(),
    },
    maintenanceStore: {
      listOutgoingDeliveryNotices: vi.fn(),
      deleteOutgoingDeliveryNotice: vi.fn(),
    },
    telegramTransport: {
      sendNotification: vi.fn(),
      nudgeSessionPartnerNote: vi.fn(),
      editChatMessage: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    config: {
      terminal: {},
      exchange: {
        dir: ".mcp-xchange",
      },
    },
  };

  return {
    getRuntimeOrThrow: () => runtime,
  };
}

describe("gatewayDelivery service", () => {
  beforeEach(() => {
    mockedWriteXchangeRelativeFile.mockReset();
    mockedUpsertXchangeRecord.mockReset();
  });

  it("materializes incoming delivery into note, xchange record, and telegram notification", async () => {
    const harness = createRuntimeHarness();
    const delivery = createDelivery({
      artifacts: [
        {
          artifact_uuid: "artifact-1",
          original_name: "wicardd.conf",
          relative_path: "shares/files/share-1/wicardd.conf",
          content_base64: Buffer.from("hello", "utf8").toString("base64"),
        },
      ],
    });
    harness.getRuntimeOrThrow().sessionStore.getSession.mockResolvedValue({
      sessionId: "backend-local",
      label: "backend",
    });
    harness.getRuntimeOrThrow().bindingStore.getBinding.mockResolvedValue({
      telegramChatId: 1711337558,
      telegramUserId: 1711337558,
    });
    mockedWriteXchangeRelativeFile
      .mockResolvedValueOnce("/workspace/.mcp-xchange/shares/files/share-1/wicardd.conf")
      .mockResolvedValueOnce("/workspace/.mcp-xchange/shares/share-1.md");

    await methods.materializeIncomingDelivery.call(harness, delivery);

    expect(mockedUpsertXchangeRecord).toHaveBeenCalledWith(
      {},
      "/workspace",
      ".mcp-xchange",
      expect.objectContaining({
        record_id: "share-1",
        session_id: "backend-local",
        category: "partner_note",
        direction: "incoming",
        status: "new",
        kind: "question",
        summary: "Опиши REST API",
        note_path: "/workspace/.mcp-xchange/shares/share-1.md",
        note_relative_path: "shares/share-1.md",
        attachments: expect.arrayContaining([
          expect.objectContaining({
            file_path: "/workspace/.mcp-xchange/shares/share-1.md",
            relative_path: "shares/share-1.md",
          }),
          expect.objectContaining({
            file_path:
              "/workspace/.mcp-xchange/shares/files/share-1/wicardd.conf",
            relative_path: "shares/files/share-1/wicardd.conf",
          }),
        ]),
      }),
    );
    expect(harness.getRuntimeOrThrow().telegramTransport.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "backend-local",
        message: expect.stringContaining("Reply target_session_id: source-session-uuid"),
      }),
    );
    expect(harness.getRuntimeOrThrow().telegramTransport.nudgeSessionPartnerNote).toHaveBeenCalledWith(
      "backend-local",
      {
        kind: "question",
        requiresReply: true,
      },
    );
    expect(harness.getRuntimeOrThrow().logger.info).toHaveBeenCalledWith(
      "Gateway delivery materialized locally",
      expect.objectContaining({
        deliveryUuid: "delivery-1",
        sessionId: "backend-local",
      }),
    );
  });

  it("skips materialization when target local session is unavailable", async () => {
    const harness = createRuntimeHarness();
    harness.getRuntimeOrThrow().sessionStore.getSession.mockResolvedValue(null);

    await methods.materializeIncomingDelivery.call(harness, createDelivery());

    expect(mockedUpsertXchangeRecord).not.toHaveBeenCalled();
    expect(harness.getRuntimeOrThrow().logger.warn).toHaveBeenCalledWith(
      "Skipping gateway delivery because target local session is not available",
      expect.objectContaining({
        deliveryUuid: "delivery-1",
        targetLocalSessionId: "backend-local",
      }),
    );
  });

  it("applies delivered status to outgoing telegram notice and clears it", async () => {
    const harness = createRuntimeHarness();
    harness.getRuntimeOrThrow().maintenanceStore.listOutgoingDeliveryNotices.mockResolvedValue([
      {
        deliveryUuid: "delivery-1",
        sessionId: "leftDev",
        telegramChatId: 171197806,
        telegramMessageId: 123,
        shareId: "share-1",
        kind: "question",
        summary: "Опиши REST API",
        projectName: "Project One",
        targetLabel: "Backend User",
        targetSessionLabel: "backend",
      },
    ]);

    await methods.applyOutgoingDeliveryStatus.call(harness, {
      delivery_uuid: "delivery-1",
      share_id: "share-1",
      status: "delivered",
    });

    expect(harness.getRuntimeOrThrow().telegramTransport.editChatMessage).toHaveBeenCalledWith(
      171197806,
      123,
      expect.stringContaining("✅ Доставка выполнена."),
    );
    expect(harness.getRuntimeOrThrow().maintenanceStore.deleteOutgoingDeliveryNotice).toHaveBeenCalledWith(
      "delivery-1",
    );
  });
});
