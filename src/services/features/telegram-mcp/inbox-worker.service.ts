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
// How often we sweep for "no_live_session" rows and give them another shot,
// in case the target console has reconnected since the last attempt.
const NO_LIVE_SESSION_RETRY_INTERVAL_MS = Number(
  process.env.INBOX_NO_LIVE_SESSION_RETRY_INTERVAL_MS || 60_000,
);
// Gives the console's input UI time to finish rendering the pasted nudge
// text before Enter arrives -- sending both back-to-back races the TUI's
// own paste/redraw handling and Enter can land before the text is "seen".
const NUDGE_ENTER_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const APPROVAL_TIMEOUT_SECONDS = Number(
  process.env.INBOX_APPROVAL_TIMEOUT_SECONDS || 600,
);
// How long we wait for the recipient to pick a console when a route has
// never been bound before. Separate from APPROVAL_TIMEOUT_SECONDS so the two
// can be tuned independently later even though they share a default today.
const ROUTE_BIND_TIMEOUT_SECONDS = Number(
  process.env.INBOX_ROUTE_BIND_TIMEOUT_SECONDS || 600,
);
const APPROVE_OPTION = "Approve";
const REJECT_OPTION = "Reject";
const MAX_ATTEMPTS = 5;

const MAX_CONSOLE_TEXT_LENGTH = 4000;
const MAX_OPTION_LABEL_LENGTH = 60;

// The source integration (Marrow) composes the exact text to type into the
// PTY -- Telly only relays it. It still lands as literal pty.write() input
// though, so this strips control/escape bytes (ANSI/terminal injection) and
// collapses it to one line regardless of how much today's source is
// trusted: a stray \n here would submit the console's input early, ahead
// of the deliberate delay+Enter below.
function sanitizeConsoleText(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const collapsed = raw
    // eslint-disable-next-line no-control-regex -- deliberately stripping control/ANSI bytes
    .replace(/[\x00-\x1F\x7F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed ? collapsed.slice(0, MAX_CONSOLE_TEXT_LENGTH) : null;
}

// Only used if the source integration didn't send a valid consoleText --
// schema validation on inbox_put should make this unreachable in practice.
function fallbackConsoleText(row: InboxMessageRow): string {
  return (
    `${row.source_integration} inbox: ${row.resource_kind} ${row.resource_id} ` +
    `in ${row.route_namespace}:${row.route_key} was just approved. Re-read ` +
    "and claim it through your own authenticated connection before doing any work."
  );
}

function tableCell(
  text: string,
  isHeader = false,
): { text: string; is_header?: true; align: "left"; valign: "middle" } {
  return { text, ...(isHeader ? { is_header: true as const } : {}), align: "left", valign: "middle" };
}

const DBConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "",
};

type LiveConsole = { client_uuid: string; local_session_id: string } | null;

type OwnerLiveConsole = {
  client_uuid: string;
  local_session_id: string;
  session_label?: string | null;
  cwd?: string | null;
};

// Telegram inline buttons stay readable with a short label; a full cwd path
// is truncated rather than left to wrap/overflow the button.
function consoleOptionLabel(liveConsole: OwnerLiveConsole): string {
  const label = liveConsole.session_label?.trim() || liveConsole.local_session_id;
  const cwd = liveConsole.cwd?.trim();
  const full = cwd ? `${label} · ${cwd}` : label;
  return full.length > MAX_OPTION_LABEL_LENGTH
    ? `${full.slice(0, MAX_OPTION_LABEL_LENGTH - 1)}…`
    : full;
}

type InboxWorkerCarrier = Service & {
  pgClient?: PgClient | null;
  pollTimer?: NodeJS.Timeout | null;
  reconnectTimer?: NodeJS.Timeout | null;
  noLiveSessionRetryTimer?: NodeJS.Timeout | null;
  stopRequested?: boolean;
  isEnabled?: () => boolean;
  connectListen?: () => Promise<void>;
  scheduleReconnect?: () => void;
  closeListen?: () => Promise<void>;
  schedulePollSoon?: () => void;
  runPollLoop?: () => Promise<void>;
  retryNoLiveSessionMessages?: () => Promise<void>;
  processOneMessage?: () => Promise<boolean>;
  handleClaimedMessage?: (
    row: InboxMessageRow,
    inboxService: TelegramMcpExternalInboxServiceInstance,
  ) => Promise<void>;
  deliverOffer?: (
    row: InboxMessageRow,
    inboxService: TelegramMcpExternalInboxServiceInstance,
    routeBinding: { clientUuid: string; localSessionId: string },
    contact: { telegramChatId: number; telegramUserId: number },
  ) => Promise<void>;
  beginRouteBindingPrompt?: (
    row: InboxMessageRow,
    inboxService: TelegramMcpExternalInboxServiceInstance,
    gatewayUserUuid: string,
    contact: { telegramChatId: number; telegramUserId: number },
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
    this.noLiveSessionRetryTimer = null;
    this.stopRequested = false;
  },

  methods: {
    isEnabled(this: InboxWorkerCarrier): boolean {
      return GATEWAY_ENABLED && Boolean(process.env.DB_HOST?.trim());
    },

    // Independent of the pending-message poll loop: "no_live_session" rows
    // are not "pending", so claimNextPendingMessage never sees them again
    // on its own. This is what gives them another shot once their console
    // reconnects, without re-sending a Telegram prompt the recipient
    // already answered (resetRetryableNoLiveSessionMessages only targets
    // the precheck statusReason, not the post-approval race case).
    async retryNoLiveSessionMessages(this: InboxWorkerCarrier): Promise<void> {
      if (this.stopRequested || !this.isEnabled?.()) {
        return;
      }
      const inboxService = getInboxService.call(this);
      if (!inboxService) {
        return;
      }
      try {
        const count = await inboxService.resetRetryableNoLiveSessionMessages(
          MAX_ATTEMPTS,
        );
        if (count > 0) {
          this.logger.info(
            "Inbox worker requeued no_live_session messages for retry",
            { count },
          );
          this.schedulePollSoon?.();
        }
      } catch (error) {
        this.logger.warn("No-live-session retry sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

      // Resolved ahead of the route-binding check: a missing route sends the
      // recipient a console-picker over Telegram, which needs this contact
      // just as much as the eventual approve/reject offer does.
      const contact = await inboxService.resolveGatewayUserContact(gatewayUserUuid);
      if (!contact) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "recipient has no bound Telegram chat",
        });
        return;
      }

      const routeBinding = await inboxService.resolveRouteBinding(
        row.route_namespace,
        row.route_key,
        gatewayUserUuid,
      );
      if (!routeBinding) {
        await this.beginRouteBindingPrompt?.(row, inboxService, gatewayUserUuid, contact);
        return;
      }

      await this.deliverOffer?.(row, inboxService, routeBinding, contact);
    },

    // One-time console picker for a route that has never been bound. Reuses
    // the same sendRichRequest/waitForReply primitive as the approve/reject
    // offer below, just with one button per live console instead of a fixed
    // Approve/Reject pair. On a pick, binds the route and immediately
    // continues into deliverOffer so the triggering message isn't lost.
    async beginRouteBindingPrompt(
      this: InboxWorkerCarrier,
      row: InboxMessageRow,
      inboxService: TelegramMcpExternalInboxServiceInstance,
      gatewayUserUuid: string,
      contact: { telegramChatId: number; telegramUserId: number },
    ): Promise<void> {
      const result = (await this.broker.call(
        "telegramMcp.gateway.listLiveConsoles",
        { owner_user_uuid: gatewayUserUuid },
        { meta: { internal_call: true } },
      )) as { sessions: OwnerLiveConsole[] } | null;
      const consoles = result?.sessions ?? [];

      if (!consoles.length) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "no live console to bind",
        });
        return;
      }

      const byLabel = new Map<string, OwnerLiveConsole>();
      const options: string[] = [];
      for (const liveConsole of consoles) {
        const label = consoleOptionLabel(liveConsole);
        if (byLabel.has(label)) {
          continue; // keep options unique so the reply maps back unambiguously
        }
        byLabel.set(label, liveConsole);
        options.push(label);
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

      const requestId = createRequestId();
      await inboxService.updateMessageStatus(row.id, {
        status: "awaiting_route_binding",
        pendingRequestId: requestId,
      });

      await runtime.telegramTransport.sendRichRequest({
        requestId,
        sessionId: `inbox-bind:${row.id}`,
        blocks: [
          { type: "heading" as const, size: 3 as const, text: "Нужна привязка консоли" },
          {
            type: "paragraph" as const,
            text:
              `Проект ${row.route_namespace}:${row.route_key} пока не привязан ни к одной ` +
              "консоли. Выбери, куда присылать уведомления о задачах этого проекта:",
          },
        ],
        recipient: {
          telegramChatId: contact.telegramChatId,
          telegramUserId: contact.telegramUserId,
        },
        options,
      });

      const reply = await runtime.telegramTransport.waitForReply(
        requestId,
        ROUTE_BIND_TIMEOUT_SECONDS,
      );

      if (!reply) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "route binding prompt timed out",
        });
        return;
      }

      const chosen = byLabel.get(reply.answer);
      if (!chosen) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: "route binding prompt returned an unrecognized console",
        });
        return;
      }

      try {
        await inboxService.bindRouteRecord({
          namespace: row.route_namespace,
          route_key: row.route_key,
          telegram_user_id: contact.telegramUserId,
          session_id: `${chosen.client_uuid}:${chosen.local_session_id}`,
        });
      } catch (error) {
        await inboxService.updateMessageStatus(row.id, {
          status: "failed",
          statusReason: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      await this.deliverOffer?.(
        row,
        inboxService,
        { clientUuid: chosen.client_uuid, localSessionId: chosen.local_session_id },
        contact,
      );
    },

    async deliverOffer(
      this: InboxWorkerCarrier,
      row: InboxMessageRow,
      inboxService: TelegramMcpExternalInboxServiceInstance,
      routeBinding: { clientUuid: string; localSessionId: string },
      contact: { telegramChatId: number; telegramUserId: number },
    ): Promise<void> {
      const liveConsole = (await this.broker.call(
        "telegramMcp.gateway.resolveLiveConsole",
        {
          sessionId: `${routeBinding.clientUuid}:${routeBinding.localSessionId}`,
        },
        { meta: { internal_call: true } },
      )) as LiveConsole;
      if (!liveConsole) {
        // Retried by the no-live-session sweep below once a console with
        // this exact statusReason reconnects -- bounded by the same
        // MAX_ATTEMPTS the rest of the worker uses, so a console that never
        // comes back eventually gives up instead of waiting forever.
        await inboxService.updateMessageStatus(row.id, {
          status: row.attempts >= MAX_ATTEMPTS ? "failed" : "no_live_session",
          statusReason:
            row.attempts >= MAX_ATTEMPTS
              ? "console did not reconnect within retry budget"
              : "target console is not currently connected",
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
      const url =
        typeof display.url === "string" && display.url.trim()
          ? display.url.trim()
          : undefined;
      const consoleText =
        sanitizeConsoleText(payload.consoleText) ?? fallbackConsoleText(row);

      const blocks = [
        { type: "heading" as const, size: 3 as const, text: title },
        ...(summary ? [{ type: "paragraph" as const, text: summary }] : []),
        {
          type: "table" as const,
          cells: [
            [tableCell("Source", true), tableCell(row.source_integration)],
            [tableCell(row.resource_kind, true), tableCell(row.resource_id)],
            [tableCell("Route", true), tableCell(`${row.route_namespace}:${row.route_key}`)],
          ],
          is_bordered: true as const,
        },
        ...(url
          ? [
              {
                type: "paragraph" as const,
                text: { type: "url" as const, text: "Open →", url },
              },
            ]
          : []),
      ];

      const requestId = createRequestId();
      await inboxService.updateMessageStatus(row.id, {
        status: "offered",
        pendingRequestId: requestId,
      });

      await runtime.telegramTransport.sendRichRequest({
        requestId,
        sessionId: `${routeBinding.clientUuid}:${routeBinding.localSessionId}`,
        blocks,
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
          text: consoleText,
        });
        await delay(NUDGE_ENTER_DELAY_MS);
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
    this.noLiveSessionRetryTimer = setInterval(() => {
      void this.retryNoLiveSessionMessages?.();
    }, NO_LIVE_SESSION_RETRY_INTERVAL_MS);
    this.logger.info("telegram_mcp inbox worker is ready");
  },

  async stopped(this: InboxWorkerCarrier) {
    this.stopRequested = true;
    if (this.noLiveSessionRetryTimer) {
      clearInterval(this.noLiveSessionRetryTimer);
      this.noLiveSessionRetryTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.closeListen?.();
  },
};

export default TelegramMcpInboxWorkerService;
