import path from "node:path";

import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import type { TelegramInboxMessage } from "./src/entities/inbox/model/types";
import { createInboxMessageId } from "./src/shared/lib/ids/ids";
import { writeXchangeRelativeFile } from "./src/shared/integrations/tmux/client";
import type { OutgoingDeliveryNotice } from "./src/shared/api/storage/contract";

const CronMixin = require("@r2d2bzh/moleculer-cron") as ServiceSchema;

export const TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME =
  "telegramMcp.gatewayDelivery";
const TELEGRAM_MCP_GATEWAY_DELIVERY_TICK_EVENT =
  "telegramMcp.gatewayDelivery.tick";

const POLL_CRON_TIME = "*/5 * * * * *";
const GATEWAY_POLL_TIMEOUT_MS = 15000;
const GATEWAY_ACK_TIMEOUT_MS = 10000;

type GatewayDeliveryArtifact = {
  artifact_uuid: string;
  original_name: string;
  mime_type?: string;
  size_bytes?: number;
  storage_ref?: string;
  relative_path?: string;
  content_base64?: string;
};

type GatewayDelivery = {
  delivery_uuid: string;
  message_uuid: string;
  share_id: string;
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
  share_index_file_name: string;
  artifacts: GatewayDeliveryArtifact[];
};

type GatewayDeliveryStatus = {
  delivery_uuid: string;
  share_id: string;
  status: string;
  delivered_at?: string;
  acked_at?: string;
};

type RuntimeCarrier = Service & {
  stopRequested?: boolean;
  pollTickInFlight?: Promise<void> | null;
  pollingEnabled?: boolean;
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  runPollIteration?: () => Promise<void>;
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
  const sourceActorLabel =
    input.delivery.source_actor_label || input.delivery.source_session_label;
  const kindTitle =
    input.delivery.kind === "question"
      ? `Получен вопрос от ${sourceActorLabel}.`
      : input.delivery.kind === "reply"
        ? `Получен ответ от ${sourceActorLabel}.`
        : input.delivery.kind === "request"
          ? `Получен запрос от ${sourceActorLabel}.`
          : input.delivery.kind === "handoff"
            ? `Получен handoff от ${sourceActorLabel}.`
            : `Получено обновление от ${sourceActorLabel}.`;

  return [
    kindTitle,
    ...(input.delivery.project_name
      ? [`Проект: ${input.delivery.project_name}`]
      : []),
    `Сессия: ${input.delivery.source_session_label}`,
    `Кратко: ${input.delivery.summary}`,
    "",
    `Действие: открой ${input.delivery.share_index_file_name}, затем note ниже.`,
    `Note: ${input.notePath}`,
    ...(input.copiedArtifacts.length > 0
      ? ["", "Файлы:", ...input.copiedArtifacts.map((item) => `- ${item}`)]
      : []),
    ...(input.delivery.requires_reply
      ? ["", "Когда будешь готов, отправь ответ через send_partner_note."]
      : []),
  ].join("\n");
}

function buildTelegramDeliveryNotification(input: {
  delivery: GatewayDelivery;
  notePath: string;
  copiedArtifacts: string[];
}): string {
  const sourceActorLabel =
    input.delivery.source_actor_label || input.delivery.source_session_label;
  const kindTitle =
    input.delivery.kind === "question"
      ? `Получен вопрос от ${sourceActorLabel}.`
      : input.delivery.kind === "reply"
        ? `Получен ответ от ${sourceActorLabel}.`
        : input.delivery.kind === "request"
          ? `Получен запрос от ${sourceActorLabel}.`
          : input.delivery.kind === "handoff"
            ? input.copiedArtifacts.length > 0
              ? `Получен файл от ${sourceActorLabel}.`
              : `Получен handoff от ${sourceActorLabel}.`
            : `Получено обновление от ${sourceActorLabel}.`;

  return [
    kindTitle,
    ...(input.delivery.project_name
      ? [`Проект: ${input.delivery.project_name}`]
      : []),
    `Сессия: ${input.delivery.source_session_label}`,
    `Тип: ${input.delivery.kind}`,
    `Кратко: ${input.delivery.summary}`,
    ...(input.copiedArtifacts.length > 0
      ? [
          "",
          `Файлы: ${input.copiedArtifacts.length}`,
          ...input.copiedArtifacts.map((item) => `- ${path.basename(item)}`),
        ]
      : []),
    "",
    `Note: ${input.notePath}`,
  ].join("\n");
}

function buildOutgoingDeliveredText(input: {
  notice: OutgoingDeliveryNotice;
  status: GatewayDeliveryStatus;
}): string {
  return [
    "✅ Доставка выполнена.",
    ...(input.notice.projectName ? [`Проект: ${input.notice.projectName}`] : []),
    ...(input.notice.targetLabel
      ? [`Получатель: ${input.notice.targetLabel}`]
      : []),
    ...(input.notice.targetSessionLabel &&
    input.notice.targetSessionLabel !== input.notice.targetLabel
      ? [`Сессия: ${input.notice.targetSessionLabel}`]
      : []),
    `Тип: ${input.notice.kind}`,
    "Статус: доставлено",
    `Кратко: ${input.notice.summary}`,
    `Share: ${input.notice.shareId || input.status.share_id}`,
  ].join("\n");
}

function buildOutgoingFailedText(input: {
  notice: OutgoingDeliveryNotice;
  status: GatewayDeliveryStatus;
}): string {
  return [
    "❌ Доставка не выполнена.",
    ...(input.notice.projectName ? [`Проект: ${input.notice.projectName}`] : []),
    ...(input.notice.targetLabel
      ? [`Получатель: ${input.notice.targetLabel}`]
      : []),
    ...(input.notice.targetSessionLabel &&
    input.notice.targetSessionLabel !== input.notice.targetLabel
      ? [`Сессия: ${input.notice.targetSessionLabel}`]
      : []),
    `Тип: ${input.notice.kind}`,
    "Статус: ошибка",
    `Кратко: ${input.notice.summary}`,
    `Share: ${input.notice.shareId || input.status.share_id}`,
  ].join("\n");
}

function isIrrecoverableDeliveryError(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
  return (
    text.includes("Failed to resolve stored file reference") ||
    text.includes("Failed to read stored file content") ||
    text.includes("Not Found") ||
    text.includes("OBJECT_NOT_FOUND") ||
    text.includes("Uploaded object not found")
  );
}

function isExpectedGatewayPollTimeout(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error);
  return (
    text.includes("TimeoutError") &&
    text.includes("The operation was aborted due to timeout")
  );
}

const TelegramMcpGatewayDeliveryService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],
  mixins: [CronMixin],
  crons: [
    {
      name: "GatewayDeliveryPoll",
      cronTime: POLL_CRON_TIME,
      onTick(this: { emit: (eventName: string, payload?: unknown) => void }) {
        this.emit(TELEGRAM_MCP_GATEWAY_DELIVERY_TICK_EVENT);
      },
    },
  ],

  events: {
    [TELEGRAM_MCP_GATEWAY_DELIVERY_TICK_EVENT]: {
      async handler(this: RuntimeCarrier) {
        await this.runPollIteration?.();
      },
    },
  },

  methods: {
    getRuntimeOrThrow(this: RuntimeCarrier) {
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

    async runPollIteration(this: RuntimeCarrier): Promise<void> {
      if (this.stopRequested || !this.pollingEnabled) {
        return;
      }

      if (this.pollTickInFlight) {
        return this.pollTickInFlight;
      }

      this.pollTickInFlight = (async () => {
        const runtime = this.getRuntimeOrThrow?.();
        if (!runtime?.config.distributed.gatewayPublicUrl) {
          return;
        }

        try {
          const clientUuid = await runtime.maintenanceStore.getGatewayClientUuid();
          if (!clientUuid) {
            return;
          }

          const baseUrl = normalizeGatewayBaseUrl(
            runtime.config.distributed.gatewayPublicUrl,
          );
          const pollUrl = new URL(baseUrl);
          pollUrl.pathname = `${pollUrl.pathname}/deliveries/poll`.replace(
            /\/{2,}/gu,
            "/",
          );

          const response = await fetch(pollUrl, {
            method: "POST",
            signal: AbortSignal.timeout(GATEWAY_POLL_TIMEOUT_MS),
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
            try {
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
                let localArtifactPath: string;
                if (artifact.content_base64) {
                  localArtifactPath = await writeXchangeRelativeFile(
                    runtime.config.tmux,
                    runtime.objectStore.resolveWorkspaceDir(targetSession),
                    runtime.config.exchange.dir,
                    relativePath,
                    Buffer.from(artifact.content_base64, "base64"),
                  );
                } else {
                  localArtifactPath = await runtime.objectStore.ensureLocalFile({
                    sessionId: targetSession.sessionId,
                    session: targetSession,
                    filePath: artifact.original_name,
                    relativePath,
                    storageRef: artifact.storage_ref,
                    source: "partner-artifact",
                  });
                }
                copiedArtifacts.push(localArtifactPath);
                await runtime.xchangeFileMetaStore.setXchangeFileMeta({
                  sessionId: targetSession.sessionId,
                  filePath: localArtifactPath,
                  relativePath,
                  source: "partner-artifact",
                  uploadedAt: delivery.created_at,
                  originalName: artifact.original_name,
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

              try {
                await runtime.telegramTransport.sendNotification({
                  sessionId: targetSession.sessionId,
                  ...(targetSession.label
                    ? { sessionLabel: targetSession.label }
                    : {}),
                  recipient: {
                    telegramChatId: targetBinding.telegramChatId,
                    telegramUserId: targetBinding.telegramUserId,
                  },
                  message: buildTelegramDeliveryNotification({
                    delivery,
                    notePath,
                    copiedArtifacts,
                  }),
                });
              } catch (error) {
                runtime.logger.warn(
                  "Failed to send Telegram notification for gateway delivery",
                  {
                    deliveryUuid: delivery.delivery_uuid,
                    sessionId: targetSession.sessionId,
                    error:
                      error instanceof Error ? (error.stack ?? error.message) : String(error),
                  },
                );
              }

              const ackUrl = new URL(baseUrl);
              ackUrl.pathname = `${ackUrl.pathname}/deliveries/ack`.replace(
                /\/{2,}/gu,
                "/",
              );
              await fetch(ackUrl, {
                method: "POST",
                signal: AbortSignal.timeout(GATEWAY_ACK_TIMEOUT_MS),
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
            } catch (error) {
              if (isIrrecoverableDeliveryError(error)) {
                const failUrl = new URL(baseUrl);
                failUrl.pathname = `${failUrl.pathname}/deliveries/fail`.replace(
                  /\/{2,}/gu,
                  "/",
                );
                await fetch(failUrl, {
                  method: "POST",
                  signal: AbortSignal.timeout(GATEWAY_ACK_TIMEOUT_MS),
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
                    error_text:
                      error instanceof Error ? error.message : String(error),
                  }),
                });
                runtime.logger.warn(
                  "Gateway delivery marked as failed because artifact is irrecoverable",
                  {
                    deliveryUuid: delivery.delivery_uuid,
                    shareId: delivery.share_id,
                    error:
                      error instanceof Error ? (error.stack ?? error.message) : String(error),
                  },
                );
                continue;
              }
              throw error;
            }
          }

          const outgoingNotices =
            await runtime.maintenanceStore.listOutgoingDeliveryNotices();
          if (outgoingNotices.length > 0) {
            const statusUrl = new URL(baseUrl);
            statusUrl.pathname = `${statusUrl.pathname}/deliveries/status`.replace(
              /\/{2,}/gu,
              "/",
            );

            const statusResponse = await fetch(statusUrl, {
              method: "POST",
              signal: AbortSignal.timeout(GATEWAY_POLL_TIMEOUT_MS),
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
                delivery_ids: outgoingNotices.map((item) => item.deliveryUuid),
              }),
            });

            if (!statusResponse.ok) {
              throw new Error(
                `Gateway delivery status check failed with status ${statusResponse.status}: ${await statusResponse.text()}`,
              );
            }

            const statusPayload = (await statusResponse.json()) as {
              deliveries?: GatewayDeliveryStatus[];
            };
            const statuses = Array.isArray(statusPayload.deliveries)
              ? statusPayload.deliveries
              : [];

            for (const notice of outgoingNotices) {
              const status = statuses.find(
                (item) =>
                  item.delivery_uuid === notice.deliveryUuid &&
                  (item.status === "delivered" || item.status === "failed"),
              );
              if (!status) {
                continue;
              }

              try {
                await runtime.telegramTransport.editChatMessage(
                  notice.telegramChatId,
                  notice.telegramMessageId,
                  status.status === "failed"
                    ? buildOutgoingFailedText({ notice, status })
                    : buildOutgoingDeliveredText({ notice, status }),
                );
                await runtime.maintenanceStore.deleteOutgoingDeliveryNotice(
                  notice.deliveryUuid,
                );
              } catch (error) {
                runtime.logger.warn(
                  "Failed to update outgoing delivery status message in Telegram",
                  {
                    deliveryUuid: notice.deliveryUuid,
                    sessionId: notice.sessionId,
                    telegramChatId: notice.telegramChatId,
                    telegramMessageId: notice.telegramMessageId,
                    error:
                      error instanceof Error
                        ? (error.stack ?? error.message)
                        : String(error),
                  },
                );
              }
            }
          }
        } catch (error) {
          if (this.stopRequested) {
            return;
          }
          const logPayload = {
            gatewayUrl: runtime.config.distributed.gatewayPublicUrl,
            error:
              error instanceof Error ? (error.stack ?? error.message) : String(error),
          };
          if (isExpectedGatewayPollTimeout(error)) {
            this.logger.debug(
              "telegram_mcp gateway delivery poll iteration timed out",
              logPayload,
            );
            return;
          }
          this.logger.warn("telegram_mcp gateway delivery poll iteration failed", logPayload);
        } finally {
          this.pollTickInFlight = null;
        }
      })();

      return this.pollTickInFlight;
    },
  },

  created(this: RuntimeCarrier) {
    this.stopRequested = false;
    this.pollTickInFlight = null;
    this.pollingEnabled = false;
    this.runtimeService = null;
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
    this.pollingEnabled = true;
    await this.runPollIteration?.();

    this.logger.info("telegram_mcp gateway delivery polling started", {
      cronTime: POLL_CRON_TIME,
    });
  },

  async stopped(this: RuntimeCarrier) {
    this.stopRequested = true;
    this.pollingEnabled = false;
    if (this.pollTickInFlight) {
      await this.pollTickInFlight;
      this.pollTickInFlight = null;
    }
  },
};

export default TelegramMcpGatewayDeliveryService;
