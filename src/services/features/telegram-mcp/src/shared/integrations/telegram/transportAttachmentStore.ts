import { buildDatedRelativePath } from "./transportUtils";
import type { TelegramAttachmentDescriptor, StoredAttachmentRecord } from "./transportTypes";
import type { TelegramXchangeFileMeta } from "../../../entities/inbox/model/types";
import type { SessionStore, TelegramXchangeFileMetaStore } from "../../api/storage/contract";
import type { MinioExchangeStore } from "../object-storage/minioExchangeStore";

export interface TransportAttachmentStoreHost {
  sessionStore: SessionStore;
  xchangeFileMetaStore: TelegramXchangeFileMetaStore;
  objectStore: MinioExchangeStore;
  telegramFetch: (
    input: string | URL,
    init?: unknown,
  ) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  getRequiredBotToken(action: string): string;
  getTelegramFile(fileId: string): Promise<{ file_path?: string }>;
}

export class TransportAttachmentStore {
  public constructor(private readonly host: TransportAttachmentStoreHost) {}

  public async storeTelegramUploadMetas(input: {
    sessionId: string;
    sourceTelegramMessageId: number;
    uploadedAt: string;
    attachments: StoredAttachmentRecord[];
    descriptors?: TelegramAttachmentDescriptor[] | undefined;
    caption?: string | undefined;
  }): Promise<void> {
    for (let index = 0; index < input.attachments.length; index += 1) {
      const attachment = input.attachments[index];
      if (!attachment) {
        continue;
      }

      const descriptor = input.descriptors?.[index];
      await this.host.xchangeFileMetaStore.setXchangeFileMeta({
        sessionId: input.sessionId,
        filePath: attachment.filePath,
        relativePath: attachment.relativePath,
        source: "telegram-upload",
        sourceTelegramMessageId: input.sourceTelegramMessageId,
        uploadedAt: input.uploadedAt,
        storageRef: attachment.storageRef,
        bucketName: attachment.bucketName,
        objectName: attachment.objectName,
        vfsNodeId: attachment.vfsNodeId,
        vfsPublicUrl: attachment.vfsPublicUrl,
        vfsParentId: attachment.vfsParentId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(
          descriptor && !descriptor.preferredName.startsWith("photo-")
            ? { originalName: descriptor.preferredName }
            : {}
        ),
        ...(input.caption ? { caption: input.caption } : {}),
      });
    }
  }

  public async ensureStoredXchangeFile(
    sessionId: string,
    filePath: string,
    source: TelegramXchangeFileMeta["source"],
  ): Promise<{ session: Awaited<ReturnType<SessionStore["getSession"]>>; filePath: string }> {
    const session = await this.host.sessionStore.getSession(sessionId);
    const meta = await this.host.xchangeFileMetaStore.getXchangeFileMeta(
      sessionId,
      filePath,
    );

    if (!meta) {
      return { session, filePath };
    }

    const materializedPath = await this.host.objectStore.ensureLocalFile({
      sessionId,
      session,
      filePath,
      relativePath: meta.relativePath,
      storageRef: meta.storageRef,
      source,
    });

    return {
      session,
      filePath: materializedPath,
    };
  }

  public async downloadIncomingAttachments(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    sourceTelegramMessageId: number,
    attachments: TelegramAttachmentDescriptor[],
  ): Promise<StoredAttachmentRecord[]> {
    if (attachments.length === 0) {
      return [];
    }

    const savedFiles: StoredAttachmentRecord[] = [];
    for (const attachment of attachments) {
      const savedFile = await this.downloadTelegramFile(
        session,
        sessionId,
        attachment.fileId,
        sourceTelegramMessageId,
        attachment.preferredName,
        attachment.mimeType,
      );
      savedFiles.push(savedFile);
    }

    return savedFiles;
  }

  public async downloadTelegramFile(
    session: Awaited<ReturnType<SessionStore["getSession"]>>,
    sessionId: string,
    fileId: string,
    _sourceTelegramMessageId: number,
    preferredName: string,
    preferredMimeType?: string | undefined,
  ): Promise<StoredAttachmentRecord> {
    const telegramFile = await this.host.getTelegramFile(fileId);
    if (!telegramFile.file_path) {
      throw new Error("Telegram file path is missing");
    }

    const outputName = preferredName;
    const fileUrl = `https://api.telegram.org/file/bot${this.host.getRequiredBotToken(
      "download Telegram files",
    )}/${telegramFile.file_path}`;
    const response = await this.host.telegramFetch(fileUrl);

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with status ${response.status}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return this.host.objectStore.storeFile({
      session,
      sessionId,
      source: "telegram-upload",
      relativePath: buildDatedRelativePath(outputName),
      content: buffer,
      mimeType:
        preferredMimeType ||
        response.headers.get("content-type") ||
        undefined,
    });
  }
}
