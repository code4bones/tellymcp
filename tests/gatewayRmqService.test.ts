import { describe, expect, it, vi } from "vitest";

import GatewayRmqService from "../src/services/features/telegram-mcp/gateway-rmq.service";

type MockFn = ReturnType<typeof vi.fn>;

type GatewayRmqMethods = {
  dispatchMessage: (message: {
    type:
      | "delivery.queued"
      | "delivery.status"
      | "project.member_joined"
      | "project.member_left";
    payload: Record<string, unknown>;
  }) => Promise<void>;
  publishMessage: (message: {
    type:
      | "delivery.queued"
      | "delivery.status"
      | "project.member_joined"
      | "project.member_left";
    payload: Record<string, unknown>;
  }) => Promise<boolean>;
};

type GatewayRmqHarness = {
  broker: {
    call: MockFn;
  };
  channel: {
    publish: MockFn;
  } | null;
  isEnabled: MockFn;
  connectRmq: MockFn;
  getExchangeName: MockFn;
  dispatchMessage: GatewayRmqMethods["dispatchMessage"];
  publishMessage: GatewayRmqMethods["publishMessage"];
};

const methods = GatewayRmqService.methods as unknown as GatewayRmqMethods;

function createHarness(): GatewayRmqHarness {
  return {
    broker: {
      call: vi.fn(async () => undefined),
    },
    channel: {
      publish: vi.fn(() => true),
    },
    isEnabled: vi.fn(() => true),
    connectRmq: vi.fn(async () => undefined),
    getExchangeName: vi.fn(() => "telegram_mcp.gateway"),
    dispatchMessage: methods.dispatchMessage,
    publishMessage: methods.publishMessage,
  };
}

describe("gatewayRmq service", () => {
  it("dispatches delivery.queued to gatewaySocket.notifyDeliveryQueued", async () => {
    const harness = createHarness();

    await harness.dispatchMessage({
      type: "delivery.queued",
      payload: {
        clientUuid: "client-1",
        delivery: { delivery_uuid: "delivery-1" },
      },
    });

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.notifyDeliveryQueued",
      {
        clientUuid: "client-1",
        delivery: { delivery_uuid: "delivery-1" },
      },
      { meta: { internal_call: true } },
    );
  });

  it("dispatches delivery.status to gatewaySocket.notifyDeliveryStatus", async () => {
    const harness = createHarness();

    await harness.dispatchMessage({
      type: "delivery.status",
      payload: {
        clientUuid: "client-1",
        status: { delivery_uuid: "delivery-1", status: "delivered" },
      },
    });

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.notifyDeliveryStatus",
      {
        clientUuid: "client-1",
        status: { delivery_uuid: "delivery-1", status: "delivered" },
      },
      { meta: { internal_call: true } },
    );
  });

  it("dispatches project.member_joined to gatewaySocket.notifyProjectMemberJoined", async () => {
    const harness = createHarness();

    await harness.dispatchMessage({
      type: "project.member_joined",
      payload: {
        clientUuids: ["client-1"],
        projectUuid: "project-1",
        projectName: "Project One",
      },
    });

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.notifyProjectMemberJoined",
      {
        clientUuids: ["client-1"],
        projectUuid: "project-1",
        projectName: "Project One",
      },
      { meta: { internal_call: true } },
    );
  });

  it("dispatches project.member_left to gatewaySocket.notifyProjectMemberLeft", async () => {
    const harness = createHarness();

    await harness.dispatchMessage({
      type: "project.member_left",
      payload: {
        clientUuids: ["client-1"],
        projectUuid: "project-1",
        projectName: "Project One",
      },
    });

    expect(harness.broker.call).toHaveBeenCalledWith(
      "telegramMcp.gatewaySocket.notifyProjectMemberLeft",
      {
        clientUuids: ["client-1"],
        projectUuid: "project-1",
        projectName: "Project One",
      },
      { meta: { internal_call: true } },
    );
  });

  it("returns false from publishMessage when RMQ is disabled", async () => {
    const harness = createHarness();
    harness.isEnabled.mockReturnValue(false);

    await expect(
      harness.publishMessage({
        type: "delivery.queued",
        payload: {
          clientUuid: "client-1",
          delivery: { delivery_uuid: "delivery-1" },
        },
      }),
    ).resolves.toBe(false);

    expect(harness.connectRmq).not.toHaveBeenCalled();
    expect(harness.channel?.publish).not.toHaveBeenCalled();
  });

  it("connects lazily before publish and sends durable JSON event", async () => {
    const harness = createHarness();
    harness.channel = null;
    const publish = vi.fn(() => true);
    harness.connectRmq.mockImplementation(async () => {
      harness.channel = {
        publish,
      };
    });

    const published = await harness.publishMessage({
      type: "delivery.status",
      payload: {
        clientUuid: "client-1",
        status: { delivery_uuid: "delivery-1", status: "delivered" },
      },
    });

    expect(published).toBe(true);
    expect(harness.connectRmq).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe("telegram_mcp.gateway");
    expect(publish.mock.calls[0]?.[1]).toBe("delivery.status");
    expect(String(publish.mock.calls[0]?.[2])).toContain("\"type\":\"delivery.status\"");
    expect(publish.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        contentType: "application/json",
        deliveryMode: 2,
      }),
    );
  });
});
