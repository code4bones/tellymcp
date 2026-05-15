import { connect, type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";
import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";

export const TELEGRAM_MCP_GATEWAY_RMQ_SERVICE_NAME = "telegramMcp.gatewayRmq";

type ProjectEventPayload = {
  clientUuids: string[];
  projectUuid: string;
  projectName: string;
  memberDisplayName?: string;
  memberTelegramUsername?: string;
};

type DeliveryQueuedPayload = {
  clientUuid: string;
  delivery: Record<string, unknown>;
};

type DeliveryStatusPayload = {
  clientUuid: string;
  status: Record<string, unknown>;
};

type GatewayRmqMessage =
  | {
      type: "delivery.queued";
      payload: DeliveryQueuedPayload;
    }
  | {
      type: "delivery.status";
      payload: DeliveryStatusPayload;
    }
  | {
      type: "project.member_joined";
      payload: ProjectEventPayload;
    }
  | {
      type: "project.member_left";
      payload: ProjectEventPayload;
    };

type GatewayRmqCarrier = Service & {
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  connection?: ChannelModel | null;
  channel?: Channel | null;
  consumerTag?: string | null;
  reconnectTimer?: NodeJS.Timeout | null;
  stopRequested?: boolean;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  isEnabled?: () => boolean;
  getExchangeName?: () => string;
  getQueueName?: () => string;
  connectRmq?: () => Promise<void>;
  scheduleReconnect?: () => void;
  closeRmq?: () => Promise<void>;
  publishMessage?: (message: GatewayRmqMessage) => Promise<boolean>;
  dispatchMessage?: (message: GatewayRmqMessage) => Promise<void>;
};

function buildNodeSuffix(): string {
  return (
    process.env.NODE_ID?.trim() ||
    process.env.PROJECT_NAME?.trim() ||
    "default"
  ).replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

const QUEUE_NAME = `telegram_mcp.gateway.${buildNodeSuffix()}`;
const RECONNECT_DELAY_MS = 3000;

const TelegramMcpGatewayRmqService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_RMQ_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    publishDeliveryQueued: {
      params: {
        clientUuid: "string",
        delivery: { type: "object" },
      },
      async handler(
        this: GatewayRmqCarrier,
        ctx: { params: DeliveryQueuedPayload },
      ) {
        return {
          published: await this.publishMessage?.({
            type: "delivery.queued",
            payload: ctx.params,
          }),
        };
      },
    },
    publishDeliveryStatus: {
      params: {
        clientUuid: "string",
        status: { type: "object" },
      },
      async handler(
        this: GatewayRmqCarrier,
        ctx: { params: DeliveryStatusPayload },
      ) {
        return {
          published: await this.publishMessage?.({
            type: "delivery.status",
            payload: ctx.params,
          }),
        };
      },
    },
    publishProjectMemberJoined: {
      params: {
        clientUuids: { type: "array", items: "string" },
        projectUuid: "string",
        projectName: "string",
        memberDisplayName: { type: "string", optional: true },
        memberTelegramUsername: { type: "string", optional: true },
      },
      async handler(
        this: GatewayRmqCarrier,
        ctx: { params: ProjectEventPayload },
      ) {
        return {
          published: await this.publishMessage?.({
            type: "project.member_joined",
            payload: ctx.params,
          }),
        };
      },
    },
    publishProjectMemberLeft: {
      params: {
        clientUuids: { type: "array", items: "string" },
        projectUuid: "string",
        projectName: "string",
        memberDisplayName: { type: "string", optional: true },
        memberTelegramUsername: { type: "string", optional: true },
      },
      async handler(
        this: GatewayRmqCarrier,
        ctx: { params: ProjectEventPayload },
      ) {
        return {
          published: await this.publishMessage?.({
            type: "project.member_left",
            payload: ctx.params,
          }),
        };
      },
    },
  },

  created(this: GatewayRmqCarrier) {
    this.runtimeService = null;
    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    this.reconnectTimer = null;
    this.stopRequested = false;
  },

  methods: {
    getRuntimeOrThrow(this: GatewayRmqCarrier) {
      const runtimeService =
        this.runtimeService ??
        (this.broker.getLocalService(
          TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
        ) as TelegramMcpRuntimeServiceInstance | null);

      if (!runtimeService) {
        throw new Error(
          `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
        );
      }

      this.runtimeService = runtimeService;
      return runtimeService.getRuntime();
    },

    isEnabled(this: GatewayRmqCarrier): boolean {
      const runtime = this.getRuntimeOrThrow?.();
      return Boolean(
        runtime &&
          (runtime.config.distributed.mode === "gateway" ||
            runtime.config.distributed.mode === "both") &&
          runtime.config.distributed.rmq?.host,
      );
    },

    getExchangeName(this: GatewayRmqCarrier): string {
      return this.getRuntimeOrThrow?.().config.distributed.rmq?.exchange ??
        "telegram_mcp.gateway";
    },

    getQueueName(): string {
      return QUEUE_NAME;
    },

    async closeRmq(this: GatewayRmqCarrier): Promise<void> {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const channel = this.channel;
      this.channel = null;
      this.consumerTag = null;
      if (channel) {
        await channel.close().catch(() => undefined);
      }

      const connection = this.connection;
      this.connection = null;
      if (connection) {
        await connection.close().catch(() => undefined);
      }
    },

    scheduleReconnect(this: GatewayRmqCarrier): void {
      if (this.stopRequested || this.reconnectTimer || !this.isEnabled?.()) {
        return;
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connectRmq?.();
      }, RECONNECT_DELAY_MS);

      this.logger.warn("Gateway RMQ reconnect scheduled", {
        delayMs: RECONNECT_DELAY_MS,
      });
    },

    async dispatchMessage(
      this: GatewayRmqCarrier,
      message: GatewayRmqMessage,
    ): Promise<void> {
      if (message.type === "delivery.queued") {
        await this.broker.call(
          "telegramMcp.gatewaySocket.notifyDeliveryQueued",
          message.payload,
          { meta: { internal_call: true } },
        );
        return;
      }

      if (message.type === "delivery.status") {
        await this.broker.call(
          "telegramMcp.gatewaySocket.notifyDeliveryStatus",
          message.payload,
          { meta: { internal_call: true } },
        );
        return;
      }

      if (message.type === "project.member_joined") {
        await this.broker.call(
          "telegramMcp.gatewaySocket.notifyProjectMemberJoined",
          message.payload,
          { meta: { internal_call: true } },
        );
        return;
      }

      await this.broker.call(
        "telegramMcp.gatewaySocket.notifyProjectMemberLeft",
        message.payload,
        { meta: { internal_call: true } },
      );
    },

    async connectRmq(this: GatewayRmqCarrier): Promise<void> {
      if (this.stopRequested || !this.isEnabled?.() || this.channel) {
        return;
      }

      const runtime = this.getRuntimeOrThrow?.();
      const rmq = runtime?.config.distributed.rmq;
      if (!runtime || !rmq) {
        return;
      }

      try {
        const connection = await connect({
          protocol: "amqp",
          hostname: rmq.host,
          port: rmq.port,
          ...(rmq.user ? { username: rmq.user } : {}),
          ...(rmq.password ? { password: rmq.password } : {}),
          vhost: rmq.vhost,
        });
        const channel = await connection.createChannel();
        const exchange = this.getExchangeName?.() ?? rmq.exchange;
        const queue = this.getQueueName?.() ?? QUEUE_NAME;

        await channel.assertExchange(exchange, "topic", { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, "delivery.queued");
        await channel.bindQueue(queue, exchange, "delivery.status");
        await channel.bindQueue(queue, exchange, "project.member_joined");
        await channel.bindQueue(queue, exchange, "project.member_left");

        const onDisconnected = (eventName: string, error?: unknown) => {
          this.logger.warn("Gateway RMQ connection closed", {
            eventName,
            error:
              error instanceof Error ? (error.stack ?? error.message) : undefined,
          });
          this.connection = null;
          this.channel = null;
          this.consumerTag = null;
          this.scheduleReconnect?.();
        };

        connection.on("error", (error) => onDisconnected("error", error));
        connection.on("close", () => onDisconnected("close"));

        const consumeResult = await channel.consume(
          queue,
          async (msg: ConsumeMessage | null) => {
            if (!msg) {
              return;
            }

            try {
              const parsed = JSON.parse(msg.content.toString("utf8")) as GatewayRmqMessage;
              await this.dispatchMessage?.(parsed);
              channel.ack(msg);
            } catch (error) {
              this.logger.warn("Gateway RMQ message handling failed", {
                error:
                  error instanceof Error ? (error.stack ?? error.message) : String(error),
                routingKey: msg.fields.routingKey,
              });
              channel.nack(msg, false, true);
            }
          },
          { noAck: false },
        );

        this.connection = connection;
        this.channel = channel;
        this.consumerTag = consumeResult.consumerTag;

        this.logger.warn("Gateway RMQ connected", {
          host: rmq.host,
          port: rmq.port,
          queue,
          exchange,
        });
      } catch (error) {
        this.logger.warn("Gateway RMQ connect failed", {
          host: rmq.host,
          port: rmq.port,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        await this.closeRmq?.();
        this.scheduleReconnect?.();
      }
    },

    async publishMessage(
      this: GatewayRmqCarrier,
      message: GatewayRmqMessage,
    ): Promise<boolean> {
      if (!this.isEnabled?.()) {
        return false;
      }

      if (!this.channel) {
        await this.connectRmq?.();
      }

      if (!this.channel) {
        return false;
      }

      const routingKey = message.type;
      const published = this.channel.publish(
        this.getExchangeName?.() ?? "telegram_mcp.gateway",
        routingKey,
        Buffer.from(JSON.stringify(message), "utf8"),
        {
          contentType: "application/json",
          deliveryMode: 2,
          timestamp: Date.now(),
        },
      );

      return published;
    },
  },

  async started(this: GatewayRmqCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    this.runtimeService = runtimeService;

    if (!this.isEnabled?.()) {
      this.logger.info("Gateway RMQ is disabled", {
        distributedMode: runtimeService.getRuntime().config.distributed.mode,
        rmqConfigured: Boolean(runtimeService.getRuntime().config.distributed.rmq?.host),
      });
      return;
    }

    this.stopRequested = false;
    await this.connectRmq?.();
  },

  async stopped(this: GatewayRmqCarrier) {
    this.stopRequested = true;
    await this.closeRmq?.();
  },
};

export default TelegramMcpGatewayRmqService;
