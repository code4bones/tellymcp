import path from "node:path";

import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import {
  detectIncomingTelegramBrowserScreenshotRequest,
  buildIncomingPartnerActionDesc,
  buildIncomingTelegramMessageActionDesc,
  buildIncomingPartnerTools,
  buildIncomingTelegramMessageTools,
} from "./src/shared/lib/xchangeRecordHints";
import { writeXchangeRelativeFile } from "./src/shared/integrations/tmux/client";
import { upsertXchangeRecord } from "./src/shared/integrations/xchange/sqliteRecordStore";
import type { OutgoingDeliveryNotice } from "./src/shared/api/storage/contract";

export const TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME =
  "telegramMcp.gatewayDelivery";

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
  route_mode?: "project" | "direct";
  project_uuid?: string;
  project_name?: string;
  source_actor_label?: string;
  source_client_uuid?: string;
  kind: string;
  summary: string;
  message: string;
  expected_reply?: string;
  requires_reply: boolean;
  in_reply_to?: string;
  source_session_uuid: string;
  source_session_label: string;
  source_local_session_id: string;
  target_client_uuid?: string;
  target_session_uuid: string;
  target_local_session_id: string;
  target_session_label: string;
  created_at: string;
  note_relative_path: string;
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
  runtimeService?: TelegramMcpRuntimeServiceInstance | null;
  getRuntimeOrThrow?: () => ReturnType<TelegramMcpRuntimeServiceInstance["getRuntime"]>;
  materializeIncomingDelivery?: (delivery: GatewayDelivery) => Promise<void>;
  applyOutgoingDeliveryStatus?: (status: GatewayDeliveryStatus) => Promise<void>;
};

function renderYamlArray(values: string[]): string {
  if (values.length === 0) {
    return "[]";
  }

  return `\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

function looksLikeFileDeliveryRequest(input: {
  kind: string;
  summary: string;
  message: string;
  expectedReply?: string;
}): boolean {
  if (input.kind !== "request" && input.kind !== "question") {
    return false;
  }

  const haystack = [
    input.summary,
    input.message,
    input.expectedReply ?? "",
  ]
    .join("\n")
    .toLowerCase();

  return (
    /\b(send_partner_file|file delivery path|artifact|artifacts)\b/u.test(haystack) ||
    /\b(файл|артефакт|артефакты)\b/u.test(haystack) ||
    /\b[\w.-]+\.(html|txt|md|json|ts|tsx|js|jsx|css|scss|png|jpg|jpeg|webp|pdf|zip)\b/u.test(
      haystack,
    )
  );
}

function looksLikeBrowserScreenshotRequest(input: {
  kind: string;
  summary: string;
  message: string;
  expectedReply?: string;
}): boolean {
  if (input.kind !== "request" && input.kind !== "question") {
    return false;
  }

  const haystack = [
    input.summary,
    input.message,
    input.expectedReply ?? "",
  ]
    .join("\n")
    .toLowerCase();

  return (
    /\b(browser_open|browser_screenshot|playwright)\b/u.test(haystack) ||
    /\b(скриншот|screenshot|скрин)\b/u.test(haystack) ||
    /\bhttps?:\/\/[^\s]+/u.test(haystack)
  );
}

function buildNoteContent(input: {
  delivery: GatewayDelivery;
  copiedArtifacts: string[];
}): string {
  const isDirectRoute = input.delivery.route_mode === "direct";
  const isTelegramHumanSource = input.delivery.source_client_uuid === "gateway-telegram";
  const prefersFileDelivery = looksLikeFileDeliveryRequest({
    kind: input.delivery.kind,
    summary: input.delivery.summary,
    message: input.delivery.message,
    ...(input.delivery.expected_reply
      ? { expectedReply: input.delivery.expected_reply }
      : {}),
  });
  const prefersBrowserScreenshot = looksLikeBrowserScreenshotRequest({
    kind: input.delivery.kind,
    summary: input.delivery.summary,
    message: input.delivery.message,
    ...(input.delivery.expected_reply
      ? { expectedReply: input.delivery.expected_reply }
      : {}),
  });
  const lines = ["---"];
  lines.push(`message_uuid: ${JSON.stringify(input.delivery.message_uuid)}`);
  lines.push(`kind: ${JSON.stringify(input.delivery.kind)}`);
  lines.push(`from_session_id: ${JSON.stringify(input.delivery.source_session_uuid)}`);
  lines.push(`from_label: ${JSON.stringify(input.delivery.source_session_label)}`);
  lines.push(`to_session_id: ${JSON.stringify(input.delivery.target_session_uuid)}`);
  lines.push(`to_label: ${JSON.stringify(input.delivery.target_session_label)}`);
  lines.push(`created_at: ${JSON.stringify(input.delivery.created_at)}`);
  if (input.delivery.project_uuid) {
    lines.push(`project_uuid: ${JSON.stringify(input.delivery.project_uuid)}`);
  }
  if (input.delivery.requires_reply) {
    lines.push("requires_reply: true");
  }
  if (input.delivery.in_reply_to) {
    lines.push(`in_reply_to: ${JSON.stringify(input.delivery.in_reply_to)}`);
  }
  if (input.copiedArtifacts.length > 0) {
    lines.push(`artifacts:${renderYamlArray(input.copiedArtifacts)}`);
  }
  lines.push("---", "", "# Summary", input.delivery.summary.trim(), "", "# Message", input.delivery.message.trim());

  if (input.delivery.expected_reply?.trim()) {
    lines.push("", "# Expected Reply", input.delivery.expected_reply.trim());
  }

  if (isTelegramHumanSource) {
    lines.push(
      "",
      "# Human Reply Route",
      "Reply to the human with notify_telegram after you finish the requested work.",
      "Do not use send_partner_note for a human Telegram reply.",
    );
  } else if (input.delivery.requires_reply) {
    lines.push(
      "",
      "# Reply Params",
      `message_uuid: ${input.delivery.message_uuid}`,
      ...(isDirectRoute
        ? [
            ...(input.delivery.source_client_uuid
              ? [`target_client_uuid: ${input.delivery.source_client_uuid}`]
              : []),
            `target_local_session_id: ${input.delivery.source_local_session_id}`,
          ]
        : [`target_session_id: ${input.delivery.source_session_uuid}`]),
      ...(!isDirectRoute && input.delivery.project_uuid
        ? [`project_uuid: ${input.delivery.project_uuid}`]
        : []),
      "",
      "# Action Required",
      ...(prefersFileDelivery
        ? [
            "You must send the requested file via send_partner_file.",
            ...(prefersBrowserScreenshot
              ? [
                  "For a webpage screenshot request, first use browser_open and browser_screenshot in this console.",
                  "Do not replace the browser workflow with a shell Playwright command unless the browser tools actually fail.",
                ]
              : []),
            "Do not paste file contents into send_partner_note.",
            "Do not stop after reading, listing files, or explaining what you found.",
            "Your task is not complete until send_partner_file succeeds.",
            "Do not mark_xchange_record_read before send_partner_file succeeds.",
          ]
        : [
            "You must send a reply via send_partner_note.",
            "Do not stop after reading, listing files, or explaining what you found.",
            "Your task is not complete until send_partner_note succeeds.",
            "Do not mark_xchange_record_read before send_partner_note succeeds.",
          ]),
      "Do not stop after local analysis, inspection, or a chat explanation.",
      "If the request asks you to produce an artifact, actually produce and send the artifact.",
      ...(isDirectRoute
        ? [
            "Do not rely on implicit partner selection or project-scoped target_session_id.",
            "Pass target_client_uuid and target_local_session_id explicitly.",
          ]
        : [
            "Do not rely on implicit partner selection.",
            "Pass target_session_id explicitly.",
          ]),
      "If possible, also pass in_reply_to=message_uuid.",
      "Only after the tool succeeds may you say that the reply was sent.",
      "",
      ...(prefersFileDelivery
        ? [
            ...(prefersBrowserScreenshot
              ? [
                  "# Preferred Browser Workflow Example",
                  "browser_open(",
                  "  url=\"https://github.com\",",
                  "  wait_until=\"networkidle\"",
                  ")",
                  "browser_screenshot(",
                  "  file_name=\"github.com.png\"",
                  ")",
                  "",
                ]
              : []),
            "# Preferred Reply Tool Call Example",
            "send_partner_file(",
            `  session_id=${JSON.stringify(input.delivery.target_local_session_id)},`,
            ...(isDirectRoute
              ? [
                  ...(input.delivery.source_client_uuid
                    ? [
                        `  target_client_uuid=${JSON.stringify(input.delivery.source_client_uuid)},`,
                      ]
                    : []),
                  `  target_local_session_id=${JSON.stringify(input.delivery.source_local_session_id)},`,
                ]
              : [
                  `  target_session_id=${JSON.stringify(input.delivery.source_session_uuid)},`,
                ]),
            ...(!isDirectRoute && input.delivery.project_uuid
              ? [`  project_uuid=${JSON.stringify(input.delivery.project_uuid)},`]
              : []),
            `  file_path=${JSON.stringify(
              prefersBrowserScreenshot ? "github.com.png" : "index.html",
            )},`,
            `  in_reply_to=${JSON.stringify(input.delivery.message_uuid)},`,
            "  summary=\"Передаю запрошенный файл\",",
            "  message=\"Передаю реальный файл как артефакт\"",
            ")",
            "",
            "# Alternate Reply Tool Call Example",
          ]
        : ["# Reply Tool Call Example"]),
      "send_partner_note(",
      `  session_id=${JSON.stringify(input.delivery.target_local_session_id)},`,
      ...(isDirectRoute
        ? [
            ...(input.delivery.source_client_uuid
              ? [
                  `  target_client_uuid=${JSON.stringify(input.delivery.source_client_uuid)},`,
                ]
              : []),
            `  target_local_session_id=${JSON.stringify(input.delivery.source_local_session_id)},`,
          ]
        : [
            `  target_session_id=${JSON.stringify(input.delivery.source_session_uuid)},`,
          ]),
      `  kind=${JSON.stringify("reply")},`,
      ...(!isDirectRoute && input.delivery.project_uuid
        ? [`  project_uuid=${JSON.stringify(input.delivery.project_uuid)},`]
        : []),
      `  in_reply_to=${JSON.stringify(input.delivery.message_uuid)},`,
      "  summary=\"Короткий итог\",",
      "  message=\"Подробный ответ\"",
      ")",
    );
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

function buildTelegramDeliveryNotification(input: {
  delivery: GatewayDelivery;
  notePath: string;
  copiedArtifacts: string[];
}): string {
  const isDirectRoute = input.delivery.route_mode === "direct";
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
    `Сессия: ${input.delivery.source_session_label} -> ${input.delivery.target_session_label}`,
    `Тип: ${input.delivery.kind}`,
    `Кратко: ${input.delivery.summary}`,
    ...(input.copiedArtifacts.length > 0
      ? [
          "",
          `Файлы: ${input.copiedArtifacts.length}`,
          ...input.copiedArtifacts.map((item) => `- ${path.basename(item)}`),
        ]
      : []),
    ...(input.delivery.requires_reply
      ? [
          "",
          `Reply message_uuid: ${input.delivery.message_uuid}`,
          ...(isDirectRoute
            ? [
                ...(input.delivery.source_client_uuid
                  ? [
                      `Reply target_client_uuid: ${input.delivery.source_client_uuid}`,
                    ]
                  : []),
                `Reply target_local_session_id: ${input.delivery.source_local_session_id}`,
              ]
            : [`Reply target_session_id: ${input.delivery.source_session_uuid}`]),
          ...(!isDirectRoute && input.delivery.project_uuid
            ? [`Reply project_uuid: ${input.delivery.project_uuid}`]
            : []),
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

const TelegramMcpGatewayDeliveryService: ServiceSchema = {
  name: TELEGRAM_MCP_GATEWAY_DELIVERY_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

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

    async materializeIncomingDelivery(
      this: RuntimeCarrier,
      delivery: GatewayDelivery,
    ): Promise<void> {
      const runtime = this.getRuntimeOrThrow?.();
      if (!runtime) {
        throw new Error("Runtime is unavailable");
      }

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
        return;
      }

      const targetBinding = await runtime.bindingStore.getBinding(
        targetSession.sessionId,
      );
      if (!targetBinding) {
        runtime.logger.info(
          "Gateway delivery will be materialized without Telegram route",
          {
            deliveryUuid: delivery.delivery_uuid,
            sessionId: targetSession.sessionId,
          },
        );
      }

      const workspaceDir = runtime.objectStore.resolveWorkspaceDir(targetSession);
      const copiedArtifacts: string[] = [];
      for (const artifact of delivery.artifacts) {
        const relativePath =
          artifact.relative_path ||
          `shares/files/${delivery.share_id}/${artifact.original_name}`;
        let localArtifactPath: string;
        if (artifact.content_base64) {
          localArtifactPath = await writeXchangeRelativeFile(
            runtime.config.tmux,
            workspaceDir,
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
        workspaceDir,
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
      const isTelegramHumanSource = delivery.source_client_uuid === "gateway-telegram";
      const prefersFileDelivery = looksLikeFileDeliveryRequest({
        kind: delivery.kind,
        summary: delivery.summary,
        message: delivery.message,
        ...(delivery.expected_reply
          ? { expectedReply: delivery.expected_reply }
          : {}),
      });
      const prefersBrowserScreenshot = looksLikeBrowserScreenshotRequest({
        kind: delivery.kind,
        summary: delivery.summary,
        message: delivery.message,
        ...(delivery.expected_reply
          ? { expectedReply: delivery.expected_reply }
          : {}),
      });
      const actionDesc = isTelegramHumanSource
        ? buildIncomingTelegramMessageActionDesc(
            delivery.kind as Parameters<typeof buildIncomingTelegramMessageActionDesc>[0],
            detectIncomingTelegramBrowserScreenshotRequest({
              kind: delivery.kind as Parameters<
                typeof buildIncomingTelegramMessageActionDesc
              >[0],
              text: delivery.message,
              ...(delivery.summary.trim()
                ? { summary: delivery.summary.trim() }
                : {}),
            }),
          )
        : buildIncomingPartnerActionDesc(
            delivery.kind as Parameters<typeof buildIncomingPartnerActionDesc>[0],
            delivery.requires_reply,
            prefersFileDelivery,
            prefersBrowserScreenshot,
          );
      await upsertXchangeRecord(
        runtime.config.tmux,
        workspaceDir,
        runtime.config.exchange.dir,
        {
          record_id: delivery.share_id,
          session_id: targetSession.sessionId,
          category: isTelegramHumanSource ? "telegram_message" : "partner_note",
          direction: "incoming",
          status: "new",
          kind: delivery.kind,
          summary: delivery.summary,
          body_text: noteContent,
          action_desc: actionDesc,
          tools: isTelegramHumanSource
            ? buildIncomingTelegramMessageTools(
                delivery.kind as Parameters<typeof buildIncomingTelegramMessageTools>[0],
                detectIncomingTelegramBrowserScreenshotRequest({
                  kind: delivery.kind as Parameters<
                    typeof buildIncomingTelegramMessageTools
                  >[0],
                  text: delivery.message,
                  ...(delivery.summary.trim()
                    ? { summary: delivery.summary.trim() }
                    : {}),
                }),
              )
            : buildIncomingPartnerTools(
                delivery.kind as Parameters<typeof buildIncomingPartnerTools>[0],
                delivery.requires_reply,
                prefersFileDelivery,
                prefersBrowserScreenshot,
              ),
          note_path: notePath,
          note_relative_path: delivery.note_relative_path,
          source_session_id: delivery.source_session_uuid,
          source_label: delivery.source_session_label,
          ...(delivery.source_client_uuid
            ? { source_client_uuid: delivery.source_client_uuid }
            : {}),
          source_local_session_id: delivery.source_local_session_id,
          target_session_id: delivery.target_session_uuid,
          target_label: delivery.target_session_label,
          ...(delivery.target_client_uuid
            ? { target_client_uuid: delivery.target_client_uuid }
            : {}),
          target_local_session_id: delivery.target_local_session_id,
          ...(delivery.project_uuid ? { project_uuid: delivery.project_uuid } : {}),
          ...(delivery.project_name ? { project_name: delivery.project_name } : {}),
          requires_reply: delivery.requires_reply,
          ...(delivery.expected_reply
            ? { expected_reply: delivery.expected_reply }
            : {}),
          ...(delivery.in_reply_to ? { in_reply_to: delivery.in_reply_to } : {}),
          attachments: [
            {
              file_path: notePath,
              relative_path: delivery.note_relative_path,
              original_name: path.basename(delivery.note_relative_path),
              mime_type: "text/markdown",
              size_bytes: Buffer.byteLength(noteContent, "utf8"),
            },
            ...delivery.artifacts.map((artifact, index) => ({
              file_path: copiedArtifacts[index] ?? artifact.original_name,
              ...(artifact.relative_path
                ? { relative_path: artifact.relative_path }
                : {}),
              original_name: artifact.original_name,
              ...(artifact.mime_type ? { mime_type: artifact.mime_type } : {}),
              ...(typeof artifact.size_bytes === "number"
                ? { size_bytes: artifact.size_bytes }
                : {}),
              ...(artifact.storage_ref ? { storage_ref: artifact.storage_ref } : {}),
            })),
          ],
          tags: [
            "partner",
            delivery.kind,
            ...(delivery.project_uuid ? ["project"] : ["direct"]),
            ...(delivery.requires_reply ? ["requires-reply"] : []),
          ],
          created_at: delivery.created_at,
          updated_at: delivery.created_at,
        },
      );

      if (targetBinding && !isTelegramHumanSource) {
        try {
          await runtime.telegramTransport.sendNotification({
            sessionId: targetSession.sessionId,
            sessionLabel: delivery.source_session_label,
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
      }
      try {
        await runtime.telegramTransport.nudgeSessionPartnerNote(
          targetSession.sessionId,
          {
            kind: delivery.kind,
            requiresReply: delivery.requires_reply,
          },
        );
      } catch (error) {
        runtime.logger.warn("Failed to nudge tmux after gateway delivery", {
          deliveryUuid: delivery.delivery_uuid,
          sessionId: targetSession.sessionId,
          error:
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      }

      runtime.logger.info("Gateway delivery materialized locally", {
        deliveryUuid: delivery.delivery_uuid,
        sessionId: targetSession.sessionId,
        shareId: delivery.share_id,
        kind: delivery.kind,
        notePath,
        copiedArtifacts,
      });
    },

    async applyOutgoingDeliveryStatus(
      this: RuntimeCarrier,
      status: GatewayDeliveryStatus,
    ): Promise<void> {
      if (status.status !== "delivered" && status.status !== "failed") {
        return;
      }

      const runtime = this.getRuntimeOrThrow?.();
      if (!runtime) {
        throw new Error("Runtime is unavailable");
      }

      const outgoingNotices =
        await runtime.maintenanceStore.listOutgoingDeliveryNotices();
      const notice = outgoingNotices.find(
        (item) => item.deliveryUuid === status.delivery_uuid,
      );
      if (!notice) {
        return;
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
    },
  },

  actions: {
    materializeIncomingDelivery: {
      async handler(
        this: RuntimeCarrier,
        ctx: { params: { delivery: GatewayDelivery } },
      ) {
        await this.materializeIncomingDelivery?.(ctx.params.delivery);
        return { ok: true };
      },
    },
    applyOutgoingDeliveryStatus: {
      async handler(
        this: RuntimeCarrier,
        ctx: { params: { status: GatewayDeliveryStatus } },
      ) {
        await this.applyOutgoingDeliveryStatus?.(ctx.params.status);
        return { ok: true };
      },
    },
  },

  created(this: RuntimeCarrier) {
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

    this.runtimeService = runtimeService;
  },

  async stopped(this: RuntimeCarrier) {},
};

export default TelegramMcpGatewayDeliveryService;
