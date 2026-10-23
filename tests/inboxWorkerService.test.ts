import { describe, expect, it, vi } from "vitest";

import InboxWorkerService from "../src/services/features/telegram-mcp/inbox-worker.service";
import type {
  InboxMessageRow,
  TelegramMcpExternalInboxServiceInstance,
} from "../src/services/features/telegram-mcp/external-inbox.service";

const methods = InboxWorkerService.methods as unknown as {
  handleClaimedMessage: (
    this: unknown,
    row: InboxMessageRow,
    inboxService: TelegramMcpExternalInboxServiceInstance,
  ) => Promise<void>;
  deliverOffer: (this: unknown, ...args: unknown[]) => Promise<void>;
  beginRouteBindingPrompt: (this: unknown, ...args: unknown[]) => Promise<void>;
  retryNoLiveSessionMessages: (this: unknown) => Promise<void>;
};

const baseRow = {
  id: "msg-row-1",
  source_integration: "marrow",
  source_message_id: "E-MARROW-1",
  recipient_namespace: "marrow",
  recipient_subject: "U-1",
  route_namespace: "marrow",
  route_key: "P-1",
  resource_kind: "task",
  resource_id: "T-1",
  kind: "work.offer",
  requires_acceptance: true,
  schema_version: 1,
  payload: {
    display: { title: "Fix the thing", summary: "Details" },
    consoleText: "Check task T-1 in project P-1 via your own tools.",
  },
  status: "processing",
  status_reason: null,
  pending_request_id: null,
  xchange_message_uuid: null,
  attempts: 1,
} satisfies InboxMessageRow;

function createInboxServiceMock(
  overrides: Partial<
    Record<keyof TelegramMcpExternalInboxServiceInstance, unknown>
  > = {},
) {
  return {
    resolveRecipientGatewayUserUuid: vi.fn(async () => "gateway-user-uuid-1"),
    resolveRouteBinding: vi.fn(async () => ({
      clientUuid: "client-1",
      localSessionId: "workspace",
    })),
    resolveGatewayUserContact: vi.fn(async () => ({
      telegramChatId: 42,
      telegramUserId: 7,
    })),
    updateMessageStatus: vi.fn(async () => undefined),
    bindRouteRecord: vi.fn(async () => ({
      namespace: "marrow",
      route_key: "P-1",
      client_uuid: "client-1",
      local_session_id: "workspace",
    })),
    ...overrides,
  } as unknown as TelegramMcpExternalInboxServiceInstance;
}

function createWorkerHarness(
  opts: {
    resolveLiveConsole?: unknown;
    createInboxDelivery?: unknown;
    listLiveConsoles?: unknown;
    waitForReply?: () => Promise<unknown>;
    requestLiveRelayAction?: () => Promise<unknown>;
  } = {},
) {
  const sendRichRequest = vi.fn(async () => ({}));
  const waitForReply = vi.fn(opts.waitForReply ?? (async () => ({ answer: "Approve" })));
  const requestLiveRelayAction = vi.fn(opts.requestLiveRelayAction ?? (async () => ({})));

  const runtime = {
    telegramTransport: { sendRichRequest, waitForReply },
    gatewayHttpService: { requestLiveRelayAction },
  };
  const runtimeService = { waitUntilReady: vi.fn(async () => runtime) };

  const brokerCall = vi.fn(async (actionName: string) => {
    if (actionName === "telegramMcp.gateway.resolveLiveConsole") {
      return opts.resolveLiveConsole === undefined
        ? { client_uuid: "client-1", local_session_id: "workspace" }
        : opts.resolveLiveConsole;
    }
    if (actionName === "telegramMcp.gateway.createInboxDelivery") {
      return opts.createInboxDelivery === undefined
        ? { message_uuid: "msg-uuid-1", delivery_uuid: "delivery-uuid-1" }
        : opts.createInboxDelivery;
    }
    if (actionName === "telegramMcp.gateway.listLiveConsoles") {
      return opts.listLiveConsoles === undefined
        ? {
            sessions: [
              { client_uuid: "client-1", local_session_id: "workspace", cwd: "/repo" },
            ],
          }
        : opts.listLiveConsoles;
    }
    throw new Error(`unexpected broker call: ${actionName}`);
  });

  // Mirrors how Moleculer exposes every sibling `methods` entry on `this` --
  // handleClaimedMessage delegates to this.deliverOffer/this.beginRouteBindingPrompt.
  const harness: Record<string, unknown> = {
    broker: {
      call: brokerCall,
      getLocalService: vi.fn(() => runtimeService),
    },
  };
  harness.deliverOffer = methods.deliverOffer.bind(harness);
  harness.beginRouteBindingPrompt = methods.beginRouteBindingPrompt.bind(harness);

  return { harness, sendRichRequest, waitForReply, requestLiveRelayAction, brokerCall };
}

describe("inbox worker handleClaimedMessage", () => {
  it("fails closed when the recipient identity is not bound", async () => {
    const inboxService = createInboxServiceMock({
      resolveRecipientGatewayUserUuid: vi.fn(async () => null),
    });
    const { harness, brokerCall } = createWorkerHarness();

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenCalledWith("msg-row-1", {
      status: "failed",
      statusReason: "unbound recipient identity",
    });
    expect(brokerCall).not.toHaveBeenCalled();
  });

  it("fails closed when there is no route binding and no live console to offer", async () => {
    const inboxService = createInboxServiceMock({
      resolveRouteBinding: vi.fn(async () => null),
    });
    const { harness } = createWorkerHarness({ listLiveConsoles: { sessions: [] } });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "failed",
      statusReason: "no live console to bind",
    });
  });

  it("prompts for a console when the route is unbound, then binds and delivers the offer", async () => {
    const inboxService = createInboxServiceMock({
      resolveRouteBinding: vi.fn(async () => null),
    });
    const { harness, sendRichRequest, waitForReply, requestLiveRelayAction } =
      createWorkerHarness({
        waitForReply: vi
          .fn()
          .mockResolvedValueOnce({ answer: "workspace · /repo" })
          .mockResolvedValueOnce({ answer: "Approve" }) as unknown as () => Promise<unknown>,
      });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenCalledWith("msg-row-1", {
      status: "awaiting_route_binding",
      pendingRequestId: expect.any(String),
    });
    expect(sendRichRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ options: ["workspace · /repo"] }),
    );
    expect(inboxService.bindRouteRecord).toHaveBeenCalledWith({
      namespace: "marrow",
      route_key: "P-1",
      telegram_user_id: 7,
      session_id: "client-1:workspace",
    });
    // Falls straight through into the normal offer flow on the same message.
    expect(requestLiveRelayAction).toHaveBeenCalled();
    expect(waitForReply).toHaveBeenCalledTimes(2);
    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "delivered",
      xchangeMessageUuid: "msg-uuid-1",
    });
  });

  it("marks failed when the route-binding prompt times out", async () => {
    const inboxService = createInboxServiceMock({
      resolveRouteBinding: vi.fn(async () => null),
    });
    const { harness } = createWorkerHarness({ waitForReply: async () => null });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "failed",
      statusReason: "route binding prompt timed out",
    });
    expect(inboxService.bindRouteRecord).not.toHaveBeenCalled();
  });

  it("marks no_live_session without ever sending a Telegram prompt when the console is offline", async () => {
    const inboxService = createInboxServiceMock();
    const { harness, sendRichRequest } = createWorkerHarness({ resolveLiveConsole: null });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenCalledWith("msg-row-1", {
      status: "no_live_session",
      statusReason: "target console is not currently connected",
    });
    expect(sendRichRequest).not.toHaveBeenCalled();
  });

  it("gives up with failed once the console never reconnects within the retry budget", async () => {
    const inboxService = createInboxServiceMock();
    const { harness, sendRichRequest } = createWorkerHarness({ resolveLiveConsole: null });

    await methods.handleClaimedMessage.call(
      harness,
      { ...baseRow, attempts: 5 },
      inboxService,
    );

    expect(inboxService.updateMessageStatus).toHaveBeenCalledWith("msg-row-1", {
      status: "failed",
      statusReason: "console did not reconnect within retry budget",
    });
    expect(sendRichRequest).not.toHaveBeenCalled();
  });

  it("on Approve: nudges the console and records the xchange delivery", async () => {
    const inboxService = createInboxServiceMock();
    const { harness, sendRichRequest, requestLiveRelayAction, brokerCall } =
      createWorkerHarness();

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(sendRichRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: { telegramChatId: 42, telegramUserId: 7 },
        options: ["Approve", "Reject"],
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "heading", text: "Fix the thing" }),
          expect.objectContaining({ type: "table" }),
        ]),
      }),
    );
    expect(brokerCall).toHaveBeenCalledWith(
      "telegramMcp.gateway.createInboxDelivery",
      expect.objectContaining({
        target_client_uuid: "client-1",
        target_local_session_id: "workspace",
      }),
      { meta: { internal_call: true } },
    );
    expect(requestLiveRelayAction).toHaveBeenNthCalledWith(1, {
      clientUuid: "client-1",
      localSessionId: "workspace",
      action: "text",
      text: "Check task T-1 in project P-1 via your own tools.",
    });
    expect(requestLiveRelayAction).toHaveBeenNthCalledWith(2, {
      clientUuid: "client-1",
      localSessionId: "workspace",
      action: "enter",
    });
    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "delivered",
      xchangeMessageUuid: "msg-uuid-1",
    });
  });

  it("on Reject: records the rejection and never touches the console", async () => {
    const inboxService = createInboxServiceMock();
    const { harness, requestLiveRelayAction, brokerCall } = createWorkerHarness({
      waitForReply: async () => ({ answer: "Reject" }),
    });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "rejected",
    });
    expect(requestLiveRelayAction).not.toHaveBeenCalled();
    expect(brokerCall).not.toHaveBeenCalledWith(
      "telegramMcp.gateway.createInboxDelivery",
      expect.anything(),
      expect.anything(),
    );
  });

  it("marks failed on approval timeout", async () => {
    const inboxService = createInboxServiceMock();
    const { harness } = createWorkerHarness({ waitForReply: async () => null });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "failed",
      statusReason: "approval timed out",
    });
  });

  it("reclassifies a race-lost nudge (console disconnected after the precheck) as no_live_session", async () => {
    const inboxService = createInboxServiceMock();
    const { harness } = createWorkerHarness({
      requestLiveRelayAction: async () => {
        throw new Error("Gateway WS console 'client-1/workspace' is not connected");
      },
    });

    await methods.handleClaimedMessage.call(harness, baseRow, inboxService);

    expect(inboxService.updateMessageStatus).toHaveBeenLastCalledWith("msg-row-1", {
      status: "no_live_session",
      statusReason: expect.stringContaining("is not connected"),
    });
  });
});

describe("inbox worker retryNoLiveSessionMessages", () => {
  function createRetrySweepHarness(resetCount: number) {
    const resetRetryableNoLiveSessionMessages = vi.fn(async () => resetCount);
    const schedulePollSoon = vi.fn();
    const getLocalService = vi.fn(() => ({ resetRetryableNoLiveSessionMessages }));
    const harness = {
      stopRequested: false,
      isEnabled: () => true,
      logger: { info: vi.fn(), warn: vi.fn() },
      broker: { getLocalService },
      schedulePollSoon,
    };
    return { harness, resetRetryableNoLiveSessionMessages, schedulePollSoon };
  }

  it("requeues retryable rows and schedules an immediate poll", async () => {
    const { harness, resetRetryableNoLiveSessionMessages, schedulePollSoon } =
      createRetrySweepHarness(2);

    await methods.retryNoLiveSessionMessages.call(harness);

    expect(resetRetryableNoLiveSessionMessages).toHaveBeenCalledWith(5);
    expect(schedulePollSoon).toHaveBeenCalledOnce();
  });

  it("does nothing when there is nothing to retry", async () => {
    const { schedulePollSoon, harness } = createRetrySweepHarness(0);

    await methods.retryNoLiveSessionMessages.call(harness);

    expect(schedulePollSoon).not.toHaveBeenCalled();
  });

  it("skips the sweep entirely while disabled", async () => {
    const getLocalService = vi.fn();
    const harness = {
      stopRequested: false,
      isEnabled: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
      broker: { getLocalService },
      schedulePollSoon: vi.fn(),
    };

    await methods.retryNoLiveSessionMessages.call(harness);

    expect(getLocalService).not.toHaveBeenCalled();
  });
});
