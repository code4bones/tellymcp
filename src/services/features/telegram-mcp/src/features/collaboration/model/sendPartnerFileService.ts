import path from "node:path";

import { lookup as lookupMimeType } from "mime-types";

import type { AppConfig } from "../../../app/config/env";
import type {
  SendPartnerFileInput,
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type {
  MaintenanceStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import { readWorkspaceFile } from "../../../shared/integrations/terminal/client";
import {
  assertSerializedBodySize,
  MAX_BASE64_SOURCE_SIZE_BYTES,
} from "../../../shared/lib/bodyLimits";
import { CollaborationService } from "./collaborationService";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

function resolveWorkspaceDir(input: {
  inputCwd?: string | undefined;
  sessionCwd?: string | undefined;
  resolvedCwd: string;
}): string {
  if (input.inputCwd?.trim()) {
    return path.resolve(input.inputCwd.trim());
  }

  if (input.sessionCwd?.trim()) {
    return path.resolve(input.sessionCwd.trim());
  }

  return path.resolve(input.resolvedCwd);
}

function normalizeWorkspaceRelativePath(
  workspaceDir: string,
  filePath: string,
): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("file_path is required.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedFilePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedWorkspaceDir, trimmed);
  const relative = path.relative(resolvedWorkspaceDir, resolvedFilePath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.trim() === ""
  ) {
    throw new Error("File path is outside the workspace directory.");
  }

  return relative.split(path.sep).join("/");
}

export class SendPartnerFileService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly collaborationService: CollaborationService,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async send(
    input: SendPartnerFileInput,
  ): Promise<SendPartnerNoteOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForWorkspace(resolved.sessionId);
    const remote =
      this.config.distributed.mode !== "client"
        ? await this.remoteConsoleInvoker?.invokeForRelaySession<SendPartnerNoteOutput>(
            sessionId,
            "telegramMcp.collaboration.sendPartnerFileRemote",
            {
              ...input,
              session_id: sessionId,
            } as Record<string, unknown>,
          )
        : null;
    if (remote) {
      return remote;
    }
    const session = await this.sessionStore.getSession(sessionId);
    const workspaceDir = resolveWorkspaceDir({
      inputCwd: input.cwd,
      sessionCwd: session?.cwd,
      resolvedCwd: resolved.cwd,
    });
    const relativeFilePath = normalizeWorkspaceRelativePath(
      workspaceDir,
      input.file_path,
    );
    const fileContent = await readWorkspaceFile(
      this.config.terminal,
      workspaceDir,
      relativeFilePath,
      MAX_BASE64_SOURCE_SIZE_BYTES,
    );
    const originalName = path.basename(relativeFilePath);
    const mimeType = lookupMimeType(originalName) || "application/octet-stream";

    const note: SendPartnerNoteInput = {
      session_id: sessionId,
      ...(input.target_session_id?.trim()
        ? { target_session_id: input.target_session_id.trim() }
        : {}),
      ...(input.target_client_uuid?.trim()
        ? { target_client_uuid: input.target_client_uuid.trim() }
        : {}),
      ...(input.target_local_session_id?.trim()
        ? { target_local_session_id: input.target_local_session_id.trim() }
        : {}),
      ...(input.project_uuid?.trim()
        ? { project_uuid: input.project_uuid.trim() }
        : {}),
      kind: input.kind ?? "handoff",
      summary:
        input.summary?.trim() || `Передача файла: ${originalName}`,
      message:
        input.message?.trim() || `Передаю файл \`${originalName}\`.`,
      ...(input.expected_reply?.trim()
        ? { expected_reply: input.expected_reply.trim() }
        : {}),
      ...(typeof input.requires_reply === "boolean"
        ? { requires_reply: input.requires_reply }
        : {}),
      ...(input.in_reply_to?.trim()
        ? { in_reply_to: input.in_reply_to.trim() }
        : {}),
      artifacts: [relativeFilePath],
      artifact_refs: [
        {
          file_path: relativeFilePath,
          original_name: originalName,
          mime_type: mimeType,
          size_bytes: fileContent.byteLength,
          content_base64: Buffer.from(fileContent).toString("base64"),
        },
      ],
    };
    assertSerializedBodySize(note);
    const output = await this.collaborationService.sendPartnerNote(note);

    this.logger.info("Partner file sent through send_partner_file", {
      sessionId: output.session_id,
      partnerSessionId: output.partner_session_id,
      filePath: relativeFilePath,
      kind: output.kind,
      shareId: output.share_id,
    });

    return output;
  }

  private async normalizeSessionIdForWorkspace(sessionId: string): Promise<string> {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return trimmed;
    }

    const direct = await this.sessionStore.getSession(trimmed);
    if (direct) {
      return trimmed;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      return trimmed;
    }

    const localClientUuid = await this.maintenanceStore.getGatewayClientUuid();
    const clientUuid = trimmed.slice(0, separatorIndex).trim();
    const localSessionId = trimmed.slice(separatorIndex + 1).trim();
    if (!localClientUuid || clientUuid !== localClientUuid || !localSessionId) {
      return trimmed;
    }

    const localSession = await this.sessionStore.getSession(localSessionId);
    return localSession ? localSessionId : trimmed;
  }
}
