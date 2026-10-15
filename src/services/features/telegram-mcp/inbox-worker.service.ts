import { Client as PgClient } from "pg";
import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME,
  type TelegramMcpExternalInboxServiceInstance,
  type InboxMessageRow,
} from "./external-inbox.service";
import { createRequestId } from "./src/shared/lib/ids/ids";

export const TELEGRAM_MCP_INBOX_WORKER_SERVICE_NAME = "telegramMcp.inboxWorker";

const DISTRIBUTED_MODE = process.env.DISTRIBUTED_MODE || "client";
const GATEWAY_ENABLED =
  DISTRIBUTED_MODE === "gateway" || DISTRIBUTED_MODE === "both";

const POLL_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const APPROVAL_TIMEOUT_SECONDS = Number(
  process.env.INBOX_APPROVAL_TIMEOUT_SECONDS || 600,
);
const APPROVE_OPTION = "Approve";
const REJECT_OPTION = "Reject";
const MAX_ATTEMPTS = 5;

// Built only from structured identifiers (integration name, route/resource
// ids) set by the source integration itself, never from task title/summary
// free text that any project member could set — typing that directly into
// the PTY would be command/prompt injection into the agent's input stream.
function buildInboxNudgeText(row: InboxMessageRow): string {
  return (
    `${row.source_integration} inbox: ${row.resource_kind} ${row.resource_id} ` +
    `in ${row.route_namespace}:${row.route_key} was just approved. ` +
    "Re-read and claim it through your own authenticated connection to the " +
    "source integration before doing any work; its xchange record has the " +
    "approved display snapshot."
  );
}

const DBConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "",
};

type LiveConsole = { client_uuid: string; local_session_id: string } | null;

type InboxWorkerCarrier = Service & {
  pgClient?: PgClient | null;
  pollTimer?: NodeJS.Timeout | null;
  reconnectTimer?: NodeJS.Timeout | null;
  stopRequested?: boolean;
  isEnabled?: () => boolean;
  connectListen?: () => Promise<void>;
  scheduleReconnect?: () => void;
  closeListen?: () => Promise<void>;
  schedulePollSoon?: () => void;
  runPollLoop?: () => Promise<void>;
  processOneMessage?: () => Promise<boolean>;
  handleClaimedMessage?: (
    row: InboxMessageRow,
    inboxService: TelegramMcpExternalInboxServiceInstance,
  ) => Promise<void>;
};

function getInboxService(
  this: InboxWorkerCarrier,
): TelegramMcpExternalInboxServiceInstance | null {
  return this.broker.getLocalService(
    TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME,
  ) as TelegramMcpExternalInboxServiceInstance | null;
}

const TelegramMcpInboxWorkerService: ServiceSchema = {
  name: TELEGRAM_MCP_INBOX_WORKER_SERVICE_NAME,
  dependencies: [
    TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME,
  ],

  created(this: InboxWorkerCarrier) {
    this.pgClient = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.stopRequested = false;
  },

  methods: {
    isEnabled(this: InboxWorkerCarrier): boolean {
      return GATEWAY_ENABLED && Boolean(process.env.DB_HOST?.trim());
    },

    async connectListen(this: InboxWorkerCarrier): Promise<void> {
      if (this.stopRequested || !this.isEnabled?.() || this.pgClient) {
        return;
      }

      const client = new PgClient({ ...DBConfig });
      try {
        await client.connect();
        await client.query("LISTEN inbox_ready");
        client.on("notification", () => {
          this.schedulePollSoon?.();
        });
        client.on("error", (error: unknown) => {
          this.logger.warn("Inbox LISTEN connection error", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        client.on("end", () => {
          this.pgClient = null;
          this.scheduleReconnect?.();
        });
        this.pgClient = client;
        this.logger.info(
          "Inbox worker is listening for inbox_ready notifications",
        );
      } catch (error) {
        this.logger.warn(
          "Inbox worker failed to establish a LISTEN connection, will retry",
          { error: error instanceof Error ? error.message : String(error) },
        );
        this.pgClient = null;
        this.scheduleReconnect?.();
      }
    },

    scheduleReconnect(this: InboxWorkerCarrier): void {
      if (this.stopRequested || this.reconnectTimer || !this.isEnabled?.()) {
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connectListen?.();
      }, RECONNECT_DELAY_MS);
    },

    async closeListen(this: InboxWorkerCarrier): Promise<void> {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.pgClient) {
        const client = this.pgClient;
        this.pgClient = null;
        await client.end().catch(() => undefined);
      }
    },

    schedulePollSoon(this: InboxWorkerCarrier): void {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
      }
      this.pollTimer = setTimeout(() => {
        void this.runPollLoop?.();
      }, 0);
    },

    // LISTEN/NOTIFY is only a wake-up hint; this loop is the self-sufficient
    // source of truth. If the LISTEN connection is down, polling alone still
    // fully drains the queue, just with POLL_INTERVAL_MS latency.
    async runPollLoop(this: InboxWorkerCarrier): Promise<void> {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.stopRequested || !this.isEnabled?.()) {
        return;
      }

      try {
        let processedAny = true;
        while (processedAny && !this.stopRequested) {
          processedAny = Boolean(await this.processOneMessage?.());
        }
      } catch (error) {
        this.logger.error("Inbox worker poll loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!this.stopRequested) {
          this.pollTimer = setTimeout(() => {
            void this.runPollLoop?.();
          }, POLL_INTERVAL_MS);
        }
      }
    },

    async processOneMessage(this: InboxWorkerCarrier): Promise<boolean> {
      const inboxService = getInboxService.call(this);
      if (!inboxService) {
        return false;
      }

      const row = await inboxService.claimNextPendingMessage();
      if (!row) {
        return false;
      }

      try {
        await this.handleClaimedMessage?.(row, inboxService);
      } catch (error) {
        await inboxService.updateMessageStatus(row.id, {
          status: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          statusReason: error instanceof Error ? error.message : String(error),
        });
      }

      return true;
    },

    async handleClaimedMessage(
      this: InboxWorkerCarrier,
      row: InboxMessageRow,
      inboxService: TelegramMcpExternalInboxServiceInstance,
    ): Promise<void> {
      const gatewayUserUuid = await inboxService.resolveRecipientGatewayUserUuid(
        row.recipient_namespace,
        row.recipient_subject,
      );
      if (!gatewayUserUuid) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "unbound recipient identity",
        });
        return;
      }

      const routeBinding = await inboxService.resolveRouteBinding(
        row.route_namespace,
        row.route_key,
        gatewayUserUuid,
      );
      if (!routeBinding) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "no route binding",
        });
        return;
      }

      const contact = await inboxService.resolveGatewayUserContact(gatewayUserUuid);
      if (!contact) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "recipient has no bound Telegram chat",
        });
        return;
      }

      const liveConsole = (await this.broker.call(
        "telegramMcp.gateway.resolveLiveConsole",
        {
          sessionId: `${routeBinding.clientUuid}:${routeBinding.localSessionId}`,
        },
        { meta: { internal_call: true } },
      )) as LiveConsole;
      if (!liveConsole) {
        await inboxService.updateMessageStatus(row.id, {
          status: "no_live_session",
          statusReason: "target console is not currently connected",
        });
        return;
      }

      const runtimeService = this.broker.getLocalService(
        TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
      ) as TelegramMcpRuntimeServiceInstance | null;
      if (!runtimeService) {
        throw new Error(
          `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
        );
      }
      const runtime = await runtimeService.waitUntilReady();

      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const display = (payload.display ?? {}) as Record<string, unknown>;
      const title =
        typeof display.title === "string" && display.title.trim()
          ? display.title.trim()
          : row.resource_id;
      const summary =
        typeof display.summary === "string" ? display.summary.trim() : "";
      const question = [
        `New ${row.kind} from ${row.source_integration}: ${title}`,
        summary,
      ]
        .filter(Boolean)
        .join("\n\n");

      const requestId = createRequestId();
      await inboxService.updateMessageStatus(row.id, {
        status: "offered",
        pendingRequestId: requestId,
      });

      await runtime.telegramTransport.sendRequest({
        requestId,
        sessionId: `${routeBinding.clientUuid}:${routeBinding.localSessionId}`,
        question,
        recipient: {
          telegramChatId: contact.telegramChatId,
          telegramUserId: contact.telegramUserId,
        },
        options: [APPROVE_OPTION, REJECT_OPTION],
      });

      const reply = await runtime.telegramTransport.waitForReply(
        requestId,
        APPROVAL_TIMEOUT_SECONDS,
      );

      if (!reply) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "approval timed out",
        });
        return;
      }

      if (reply.answer !== APPROVE_OPTION) {
        await inboxService.updateMessageStatus(row.id, { status: "rejected" });
        return;
      }

      try {
        const xchangeMessage = [
          `Source: ${row.source_integration} (${row.resource_kind} ${row.resource_id})`,
          summary,
          "",
          "This was approved via Telegram. That only authorized waking this console — it is not a task claim. Re-read and claim this item through your own authenticated connection to the source integration before doing any work.",
        ]
          .filter(Boolean)
          .join("\n");

        const delivery = (await this.broker.call(
          "telegramMcp.gateway.createInboxDelivery",
          {
            target_client_uuid: routeBinding.clientUuid,
            target_local_session_id: routeBinding.localSessionId,
            kind: "inbox-offer",
            summary: title,
            message: xchangeMessage,
          },
          { meta: { internal_call: true } },
        )) as { message_uuid: string; delivery_uuid: string };

        await runtime.gatewayHttpService.requestLiveRelayAction({
          clientUuid: routeBinding.clientUuid,
          localSessionId: routeBinding.localSessionId,
          action: "text",
          text: buildInboxNudgeText(row),
        });
        await runtime.gatewayHttpService.requestLiveRelayAction({
          clientUuid: routeBinding.clientUuid,
          localSessionId: routeBinding.localSessionId,
          action: "enter",
        });

        await inboxService.updateMessageStatus(row.id, {
          status: "delivered",
          xchangeMessageUuid: delivery.message_uuid,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await inboxService.updateMessageStatus(row.id, {
          status: message.includes("is not connected")
            ? "no_live_session"
            : "failed",
          statusReason: message,
        });
      }
    },
  },

  async started(this: InboxWorkerCarrier) {
    if (!this.isEnabled?.()) {
      this.logger.info(
        "Skipping telegram_mcp inbox worker (client mode or no DB configured)",
      );
      return;
    }

    await this.broker.waitForServices([
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
      TELEGRAM_MCP_EXTERNAL_INBOX_SERVICE_NAME,
    ]);

    const inboxService = getInboxService.call(this);
    if (inboxService) {
      const recovered = await inboxService.reconcileOrphanedMessages();
      if (recovered > 0) {
        this.logger.warn(
          "Inbox worker reset orphaned in-flight messages to pending after restart",
          { count: recovered },
        );
      }
    }

    await this.connectListen?.();
    this.pollTimer = setTimeout(() => {
      void this.runPollLoop?.();
    }, 0);
    this.logger.info("telegram_mcp inbox worker is ready");
  },

  async stopped(this: InboxWorkerCarrier) {
    this.stopRequested = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.closeListen?.();
  },
};

export default TelegramMcpInboxWorkerService;
