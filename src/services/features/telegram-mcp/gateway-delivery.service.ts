import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import type { TelegramInboxMessage } from "./src/entities/inbox/model/types";
import { createInboxMessageId } from "./src/shared/lib/ids/ids";
import { writeXchangeRelativeFile } from "./src/shared/integrations/tmux/client";

export const TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME =
  "telegramMcp.gatewayDelivery";

const POLL_INTERVAL_MS = 5000;

type GatewayDeliveryArtifact = {
  artifact_uuid: string;
  original_name: string;
  mime_type?: string;
  size_bytes?: number;
  storage_ref?: string;
  relative_path?: string;
};

type GatewayDelivery = {
  delivery_uuid: string;
  message_uuid: string;
  share_id: string;
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
  share_index_file_name: string;
  artifacts: GatewayDeliveryArtifact[];
};

type RuntimeCarrier = Service & {
  stopRequested?: boolean;
  pollLoop?: Promise<void> | null;
};

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

function renderYamlArray(values: string[]): string {
  if (values.length === 0) {
    return "[]";
  }

  return `\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

function buildNoteContent(input: {
  delivery: GatewayDelivery;
  copiedArtifacts: string[];
}): string {
  const lines = [
    "---",
    `share_id: ${JSON.stringify(input.delivery.share_id)}`,
    `kind: ${JSON.stringify(input.delivery.kind)}`,
    `from_session_id: ${JSON.stringify(input.delivery.source_session_uuid)}`,
    `from_label: ${JSON.stringify(input.delivery.source_session_label)}`,
    `to_session_id: ${JSON.stringify(input.delivery.target_session_uuid)}`,
    `to_label: ${JSON.stringify(input.delivery.target_session_label)}`,
    `created_at: ${JSON.stringify(input.delivery.created_at)}`,
    `requires_reply: ${input.delivery.requires_reply ? "true" : "false"}`,
    `in_reply_to: ${input.delivery.in_reply_to ? JSON.stringify(input.delivery.in_reply_to) : "null"}`,
    `artifacts:${renderYamlArray(input.copiedArtifacts)}`,
    "---",
    "",
    "# Summary",
    input.delivery.summary.trim(),
    "",
    "# Message",
    input.delivery.message.trim(),
  ];

  if (input.delivery.expected_reply?.trim()) {
    lines.push("", "# Expected Reply", input.delivery.expected_reply.trim());
  }

  if (input.copiedArtifacts.length > 0) {
    lines.push(
      "",
      "# Artifacts",
      ...input.copiedArtifacts.map((artifact) => `- ${artifact}`),
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildShareIndexLine(input: {
  delivery: GatewayDelivery;
  relativeNotePath: string;
}): string {
  return [
    "-",
    `[${input.delivery.created_at}]`,
    `${input.delivery.source_session_label} → ${input.delivery.target_session_label}`,
    `| ${input.delivery.kind} |`,
    `${input.delivery.summary}`,
    `| \`${input.relativeNotePath}\``,
  ].join(" ");
}

function buildPartnerInboxText(input: {
  delivery: GatewayDelivery;
  notePath: string;
  copiedArtifacts: string[];
}): string {
  const kindTitle =
    input.delivery.kind === "question"
      ? "Partner question received."
      : input.delivery.kind === "reply"
        ? "Partner reply received."
        : input.delivery.kind === "request"
          ? "Partner request received."
          : input.delivery.kind === "handoff"
            ? "Partner handoff received."
            : "Partner update received.";

  return [
    kindTitle,
    `From: ${input.delivery.source_session_label}`,
    `Summary: ${input.delivery.summary}`,
    "",
    `Immediate action: read ${input.delivery.share_index_file_name} and then open the note below.`,
    `Note: ${input.notePath}`,
    ...(input.copiedArtifacts.length > 0
      ? ["", "Artifacts:", ...input.copiedArtifacts.map((item) => `- ${item}`)]
      : []),
    ...(input.delivery.requires_reply
      ? ["", "Reply through send_partner_note when you are ready."]
      : []),
  ].join("\n");
}

const TelegramMcpGatewayDeliveryService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  created(this: RuntimeCarrier) {
    this.stopRequested = false;
    this.pollLoop = null;
  },

  async started(this: RuntimeCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = runtimeService.getRuntime();
    if (!runtime.config.distributed.gatewayPublicUrl) {
      this.logger.info(
        "telegram_mcp gateway delivery polling is disabled because gateway URL is not configured",
      );
      return;
    }

    this.stopRequested = false;
    this.pollLoop = (async () => {
      const baseUrl = normalizeGatewayBaseUrl(
        runtime.config.distributed.gatewayPublicUrl!,
      );

      while (!this.stopRequested) {
        try {
          const clientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
          if (clientUuid) {
            const pollUrl = new URL(baseUrl);
            pollUrl.pathname = `${pollUrl.pathname}/deliveries/poll`.replace(
              /\/{2,}/gu,
              "/",
            );

            const response = await fetch(pollUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(runtime.config.distributed.gatewayAuthToken
                  ? {
                      authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}`,
                    }
                  : {}),
              },
              body: JSON.stringify({
                client_uuid: clientUuid,
                limit: 20,
              }),
            });

            if (!response.ok) {
              throw new Error(
                `Gateway deliveries poll failed with status ${response.status}: ${await response.text()}`,
              );
            }

            const payload = (await response.json()) as {
              deliveries?: GatewayDelivery[];
            };
            const deliveries = Array.isArray(payload.deliveries)
              ? payload.deliveries
              : [];

            for (const delivery of deliveries) {
              const targetSession = await runtime.sessionStore.getSession(
                delivery.target_local_session_id,
              );
              if (!targetSession) {
                runtime.logger.warn(
                  "Skipping gateway delivery because target local session is not available",
                  {
                    deliveryUuid: delivery.delivery_uuid,
                    targetLocalSessionId: delivery.target_local_session_id,
                  },
                );
                continue;
              }

              const targetBinding = await runtime.bindingStore.getBinding(
                targetSession.sessionId,
              );
              if (!targetBinding) {
                runtime.logger.warn(
                  "Skipping gateway delivery because target session is not paired with Telegram",
                  {
                    deliveryUuid: delivery.delivery_uuid,
                    sessionId: targetSession.sessionId,
                  },
                );
                continue;
              }

              const copiedArtifacts: string[] = [];
              for (const artifact of delivery.artifacts) {
                const relativePath =
                  artifact.relative_path ||
                  `shares/files/${delivery.share_id}/${artifact.original_name}`;
                const localArtifactPath = await runtime.objectStore.ensureLocalFile({
                  sessionId: targetSession.sessionId,
                  session: targetSession,
                  filePath: artifact.original_name,
                  relativePath,
                  storageRef: artifact.storage_ref,
                  source: "partner-artifact",
                });
                copiedArtifacts.push(localArtifactPath);
                await runtime.xchangeFileMetaStore.setXchangeFileMeta({
                  sessionId: targetSession.sessionId,
                  filePath: localArtifactPath,
                  relativePath,
                  source: "partner-artifact",
                  uploadedAt: delivery.created_at,
                  originalName: artifact.original_name,
                  ...(artifact.storage_ref ? { storageRef: artifact.storage_ref } : {}),
                  ...(artifact.mime_type ? { mimeType: artifact.mime_type } : {}),
                  ...(typeof artifact.size_bytes === "number"
                    ? { sizeBytes: artifact.size_bytes }
                    : {}),
                });
              }

              const noteContent = buildNoteContent({ delivery, copiedArtifacts });
              const notePath = await writeXchangeRelativeFile(
                runtime.config.tmux,
                runtime.objectStore.resolveWorkspaceDir(targetSession),
                runtime.config.exchange.dir,
                delivery.note_relative_path,
                Buffer.from(noteContent, "utf8"),
              );
              await runtime.xchangeFileMetaStore.setXchangeFileMeta({
                sessionId: targetSession.sessionId,
                filePath: notePath,
                relativePath: delivery.note_relative_path,
                source: "partner-artifact",
                uploadedAt: delivery.created_at,
                mimeType: "text/markdown",
                sizeBytes: Buffer.byteLength(noteContent, "utf8"),
              });

              await writeXchangeRelativeFile(
                runtime.config.tmux,
                runtime.objectStore.resolveWorkspaceDir(targetSession),
                runtime.config.exchange.dir,
                delivery.share_index_file_name,
                Buffer.from(
                  `${buildShareIndexLine({
                    delivery,
                    relativeNotePath: delivery.note_relative_path,
                  })}\n`,
                  "utf8",
                ),
                { append: true },
              );

              const inboxMessage: TelegramInboxMessage = {
                id: createInboxMessageId(new Date(delivery.created_at)),
                sessionId: targetSession.sessionId,
                telegramChatId: targetBinding.telegramChatId,
                telegramUserId: targetBinding.telegramUserId,
                sourceTelegramMessageId: Date.now(),
                text: buildPartnerInboxText({
                  delivery,
                  notePath,
                  copiedArtifacts,
                }),
                attachments: [notePath, ...copiedArtifacts],
                receivedAt: delivery.created_at,
              };
              await runtime.inboxStore.createInboxMessage(inboxMessage);

              const ackUrl = new URL(baseUrl);
              ackUrl.pathname = `${ackUrl.pathname}/deliveries/ack`.replace(
                /\/{2,}/gu,
                "/",
              );
              await fetch(ackUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(runtime.config.distributed.gatewayAuthToken
                    ? {
                        authorization: `Bearer ${runtime.config.distributed.gatewayAuthToken}`,
                      }
                    : {}),
                },
                body: JSON.stringify({
                  client_uuid: clientUuid,
                  delivery_ids: [delivery.delivery_uuid],
                }),
              });

              runtime.logger.info("Gateway delivery materialized locally", {
                deliveryUuid: delivery.delivery_uuid,
                sessionId: targetSession.sessionId,
                shareId: delivery.share_id,
                kind: delivery.kind,
                notePath,
                copiedArtifacts,
              });
            }
          }
        } catch (error) {
          this.logger.warn("telegram_mcp gateway delivery poll iteration failed", {
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        }

        await delay(POLL_INTERVAL_MS);
      }
    })();

    this.logger.info("telegram_mcp gateway delivery polling started", {
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  },

  async stopped(this: RuntimeCarrier) {
    this.stopRequested = true;
    if (this.pollLoop) {
      await this.pollLoop;
      this.pollLoop = null;
    }
  },
};

export default TelegramMcpGatewayDeliveryService;
