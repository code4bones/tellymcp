import type { MenuFlavor } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";

import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";
import type { HumanTransportReply } from "../../api/transport/contract";

export type WaiterRecord = {
  requestId: string;
  telegramChatId: number;
  telegramUserId: number;
  telegramMessageId: number;
  sentAtMs: number;
  sourceClientUuid?: string;
  reply?: HumanTransportReply;
  resolve?: (reply: HumanTransportReply | null) => void;
  timeout?: NodeJS.Timeout;
};

export type SentChunk = {
  messageId: number;
  textLength: number;
};

export type TelegramMenuContext = Context & MenuFlavor;

export type TelegramSendMessageOptions = NonNullable<
  Parameters<Bot<TelegramMenuContext>["api"]["sendMessage"]>[2]
>;

export type TelegramEditMessageOptions = NonNullable<
  Parameters<Bot<TelegramMenuContext>["api"]["editMessageText"]>[3]
>;

export type TelegramClientFetch = NonNullable<
  NonNullable<NonNullable<ConstructorParameters<typeof Bot>[1]>["client"]>["fetch"]
>;

export type SendMessageMeta = {
  kind: "request" | "notification" | "pairing" | "menu" | "inbox" | "transport";
  sessionId?: string;
  requestId?: string;
  chunkIndex?: number;
  chunkCount?: number;
};

export type PendingRenameRecord = {
  sessionId: string;
};

export type PendingBroadcastRecord = {
  initiatedAt: string;
  promptMessageId?: number;
  menuMessageId?: number;
  scope: "linked" | "project";
  sessionId?: string;
  projectUuid?: string;
  projectName?: string;
  localTargetSessionIds?: string[];
  remoteTargets?: PendingProjectBroadcastRemoteTarget[];
};

export type PendingProjectBroadcastRemoteTarget = {
  sessionUuid: string;
  sessionLabel: string;
  clientUuid: string;
  localSessionId: string;
  projectUuid: string;
  projectName?: string;
};

export type LiveApprovalEventPayload = {
  project_uuid?: string;
  project_name?: string;
  source_session_id: string;
  source_session_label: string;
  source_client_uuid: string;
  source_local_session_id: string;
  target_session_id: string;
  target_session_label: string;
  target_client_uuid: string;
  target_local_session_id: string;
};

export type PendingPartnerNoteRecord = {
  sessionId: string;
  kind: PartnerNoteKind;
  initiatedAt: string;
  promptMessageId?: number;
  targetSessionId?: string;
  targetSessionLabel?: string;
  projectUuid?: string;
};

export type PendingFileHandoffRecord = {
  sessionId: string;
  filePath: string;
  target: "agent" | "partner";
  initiatedAt: string;
  promptMessageId?: number;
  targetSessionId?: string;
  targetSessionLabel?: string;
  projectUuid?: string;
};

export type CurrentAttachmentTargetRecord = {
  sessionId: string;
  targetSessionId: string;
  targetSessionLabel: string;
  projectUuid?: string;
};

export type PendingProjectRecord = {
  sessionId: string;
  mode: "create" | "join";
  initiatedAt: string;
  promptMessageId?: number;
};

export type GatewayProjectRecord = {
  project_uuid: string;
  name: string;
  invite_token: string;
  role: string;
  status: string;
  joined_at?: string;
};

export type GatewayProjectSessionRecord = {
  session_uuid: string;
  project_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  client_label: string | null;
  telegram_username: string | null;
  bot_username: string | null;
  joined_at?: string;
  updated_at?: string;
};

export type GatewayClientRecord = {
  client_uuid: string;
  client_label: string | null;
  namespace?: string | null;
  node_id?: string | null;
  telegram_username: string | null;
  telegram_display_name: string | null;
  bot_username: string | null;
  last_seen_at?: string;
  updated_at?: string;
  session_count?: number;
};

export type GatewayClientSessionRecord = {
  session_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  project_uuid?: string;
  project_name?: string | null;
  updated_at?: string;
};

export type GatewayConnectedClientSessionTool = {
  local_session_id: string;
  session_label?: string;
  tools_hash?: string;
};

export type AdminGatewayRegistrationSessionRecord = {
  local_session_id: string;
  session_label?: string;
};

export type GatewayConnectedClientRecord = {
  client_uuid: string;
  namespace?: string;
  node_id?: string;
  package_version?: string;
  protocol_version?: string;
  session_tools: GatewayConnectedClientSessionTool[];
  capabilities: string[];
};

export type AdminClientViewRecord = GatewayClientRecord & {
  is_connected?: boolean;
  is_registered?: boolean;
  connected_session_count?: number;
  connected_session_labels?: string[];
};

export type AdminClientSessionViewRecord = {
  session_uuid: string;
  client_uuid: string;
  local_session_id: string;
  label: string | null;
  status: string;
  project_uuid?: string;
  project_name?: string | null;
  updated_at?: string;
  is_connected?: boolean;
  is_collab?: boolean;
};

export type GatewayRelayBindingPayload = {
  sessionId: string;
  targetSessionId: string;
  targetSessionLabel: string;
  targetClientUuid: string;
  targetLocalSessionId: string;
  projectUuid?: string;
  projectName?: string;
};

export type GatewayActorProfile = {
  telegramUsername?: string;
  telegramFirstName?: string;
  telegramLastName?: string;
  telegramDisplayName?: string;
};

export type TmuxCaptureScope =
  | { mode: "visible" }
  | { mode: "lines"; lines: number }
  | { mode: "full" };

export type TelegramAttachmentDescriptor = {
  fileId: string;
  preferredName: string;
  mimeType?: string | undefined;
};

export type StoredAttachmentRecord = {
  filePath: string;
  relativePath: string;
  storageRef?: string | undefined;
  bucketName?: string | undefined;
  objectName?: string | undefined;
  vfsNodeId?: number | undefined;
  vfsPublicUrl?: string | undefined;
  vfsParentId?: number | undefined;
  sizeBytes: number;
  mimeType?: string | undefined;
};

export type WebAppLaunchMode = "default" | "expand" | "fullscreen";
