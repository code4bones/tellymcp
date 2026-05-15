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

function buildNoteContent(input: {
  delivery: GatewayDelivery;
  copiedArtifacts: string[];
}): string {
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

  if (input.delivery.requires_reply) {
    lines.push(
      "",
      "# Reply Params",
      `message_uuid: ${input.delivery.message_uuid}`,
      `target_session_id: ${input.delivery.source_session_uuid}`,
      ...(input.delivery.project_uuid
        ? [`project_uuid: ${input.delivery.project_uuid}`]
        : []),
      "",
      "# Action Required",
      "You must send a reply via send_partner_note.",
      "Do not stop after local analysis or a chat explanation.",
      "Do not rely on linked partner.",
      "Pass target_session_id explicitly.",
      "If possible, also pass in_reply_to=message_uuid.",
      "",
      "# Reply Tool Call Example",
      "send_partner_note(",
      `  session_id=${JSON.stringify(input.delivery.target_local_session_id)},`,
      `  target_session_id=${JSON.stringify(input.delivery.source_session_uuid)},`,
      `  kind=${JSON.stringify("reply")},`,
      ...(input.delivery.project_uuid
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
    `Сессия: ${input.delivery.source_session_label} -> ${input.delivery.target_session_label}`,
    `Кратко: ${input.delivery.summary}`,
    "",
    `Действие: открой ${input.delivery.share_index_file_name}, затем note ниже.`,
    `Note: ${input.notePath}`,
    ...(input.copiedArtifacts.length > 0
      ? ["", "Файлы:", ...input.copiedArtifacts.map((item) => `- ${item}`)]
      : []),
    ...(input.delivery.requires_reply
      ? [
          "",
          `Reply message_uuid: ${input.delivery.message_uuid}`,
          `Reply target_session_id: ${input.delivery.source_session_uuid}`,
          ...(input.delivery.project_uuid
            ? [`Reply project_uuid: ${input.delivery.project_uuid}`]
            : []),
          "Обязательно отправь reply через send_partner_note.",
          "Не останавливайся на локальном объяснении.",
          "Не используй linked partner для ответа. Передай эти параметры явно в send_partner_note.",
        ]
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
          `Reply target_session_id: ${input.delivery.source_session_uuid}`,
          ...(input.delivery.project_uuid
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
        runtime.logger.warn(
          "Skipping gateway delivery because target session is not paired with Telegram",
          {
            deliveryUuid: delivery.delivery_uuid,
            sessionId: targetSession.sessionId,
          },
        );
        return;
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
          ...(targetSession.label ? { sessionLabel: targetSession.label } : {}),
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
      try {
        await runtime.telegramTransport.nudgeSessionPartnerNote(
          targetSession.sessionId,
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
