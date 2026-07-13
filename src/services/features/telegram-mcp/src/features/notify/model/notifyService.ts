import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  NotifyTelegramInput,
  NotifyTelegramOutput,
  SendFileToTelegramInput,
  SendFileToTelegramOutput,
} from "../../../entities/request/model/types";
import {
  notifyTelegramOutputSchema,
  sendFileToTelegramOutputSchema,
} from "../../../entities/request/model/schema";
import type {
  GetSessionContextOutput,
  SessionContext,
} from "../../../entities/session/model/types";
import type {
  MaintenanceStore,
  SessionBindingStore,
  SessionStore,
} from "../../../shared/api/storage/contract";
import type { HumanTransport } from "../../../shared/api/transport/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import { redactSecrets } from "../../../shared/lib/redact-secrets/redactSecrets";
import { readWorkspaceFile } from "../../../shared/integrations/terminal/client";
import {
  assertBodySize,
  assertStringBodySize,
} from "../../../shared/lib/bodyLimits";
import type { RiskLevel } from "../../../shared/types/common";
import { buildLiveRelaySessionId } from "../../../app/webapp/relay";
import {
  callGatewayJson,
  ensureGatewayClientUuid,
  normalizeGatewayBaseUrl,
} from "../../distributed-client/model/gatewayClientAccess";

function mergeSavedContext(
  input: NotifyTelegramInput,
  session: SessionContext | null,
): { context?: string; task?: string; sessionLabel?: string } {
  const savedSections: string[] = [];

  if (input.use_saved_context && session?.summary) {
    savedSections.push(session.summary);
  }
  if (input.use_saved_context && session?.files?.length) {
    savedSections.push(
      `Known files:\n${session.files.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  if (input.use_saved_context && session?.decisions?.length) {
    savedSections.push(
      `Known decisions:\n${session.decisions.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (input.use_saved_context && session?.risks?.length) {
    savedSections.push(
      `Known risks:\n${session.risks.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  const mergedContext = [input.context, ...savedSections]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    ...(mergedContext ? { context: mergedContext } : {}),
    ...(input.task
      ? { task: input.task }
      : session?.task
        ? { task: session.task }
        : {}),
    ...(session?.label ? { sessionLabel: session.label } : {}),
  };
}

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

type GatewaySessionTargetResolver = (sessionId: string) => Promise<{
  client_uuid: string;
  local_session_id: string;
  session_label?: string;
} | null>;

function normalizeNotifyTelegramOutput(
  value: unknown,
): NotifyTelegramOutput | null {
  const candidate =
    value && typeof value === "object" && "structuredContent" in value
      ? (value as { structuredContent?: unknown }).structuredContent
      : value && typeof value === "object" && "result" in value
        ? (value as { result?: unknown }).result
        : value;

  const parsed = notifyTelegramOutputSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  return null;
}

function normalizeSendFileToTelegramOutput(
  value: unknown,
): SendFileToTelegramOutput | null {
  const candidate =
    value && typeof value === "object" && "structuredContent" in value
      ? (value as { structuredContent?: unknown }).structuredContent
      : value && typeof value === "object" && "result" in value
        ? (value as { result?: unknown }).result
        : value;

  const parsed = sendFileToTelegramOutputSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  return null;
}

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

export class NotifyService {
  public constructor(
    private readonly _config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly transport: HumanTransport,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
    private readonly gatewaySessionTargetResolver?: GatewaySessionTargetResolver,
  ) {}

  public async send(input: NotifyTelegramInput): Promise<NotifyTelegramOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    if (!binding) {
      const remoteTarget =
        this._config.distributed.mode !== "client" &&
        this.gatewaySessionTargetResolver
          ? await this.gatewaySessionTargetResolver(resolved.sessionId)
          : null;
      if (remoteTarget) {
        return this.sendForGatewayBoundSession({
          clientUuid: remoteTarget.client_uuid,
          localSessionId: remoteTarget.local_session_id,
          message: input.message,
          sessionLabel:
            remoteTarget.session_label ??
            resolved.sessionLabel ??
            remoteTarget.local_session_id,
          ...(input.task ? { task: input.task } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.risk_level ? { riskLevel: input.risk_level } : {}),
        });
      }
      if (this._config.distributed.gatewayPublicUrl) {
        return this.sendViaGatewayBoundSession({
          sessionId: resolved.sessionId,
          sessionLabel: resolved.sessionLabel,
          message: input.message,
          ...(input.task ? { task: input.task } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.risk_level ? { riskLevel: input.risk_level } : {}),
        });
      }

      throw new Error(
        "Session is not available through the gateway console registry yet. Open /menu in the gateway bot and select the console first.",
      );
    }

    const session = await this.resolveSessionContextForNotification(
      resolved.sessionId,
    );
    const merged = mergeSavedContext(input, session);

    this.logger.info("Telegram notification requested", {
      sessionId: resolved.sessionId,
      sessionLabel: resolved.sessionLabel,
      sessionIdDerived: resolved.sessionIdDerived,
      hasContext: Boolean(merged.context),
      hasTask: Boolean(merged.task),
    });

    const sendResult = await this.transport.sendNotification({
      sessionId: resolved.sessionId,
      ...(merged.sessionLabel
        ? { sessionLabel: merged.sessionLabel }
        : resolved.sessionLabel
          ? { sessionLabel: resolved.sessionLabel }
          : {}),
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: redactSecrets(input.message),
      ...(merged.task ? { task: redactSecrets(merged.task) } : {}),
      ...(merged.context ? { context: redactSecrets(merged.context) } : {}),
      ...(input.risk_level ? { riskLevel: input.risk_level } : {}),
    });

    this.logger.info("Telegram notification sent", {
      sessionId: resolved.sessionId,
      messageId:
        typeof sendResult.externalMessageId === "number"
          ? sendResult.externalMessageId
          : undefined,
    });

    return {
      sent: true,
      ...(typeof sendResult.externalMessageId === "number"
        ? { message_id: sendResult.externalMessageId }
        : {}),
    };
  }

  public async sendDocument(
    input: SendFileToTelegramInput,
  ): Promise<SendFileToTelegramOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const sessionId = await this.normalizeSessionIdForWorkspace(
      resolved.sessionId,
    );
    const remote =
      this._config.distributed.mode !== "client"
        ? normalizeSendFileToTelegramOutput(
            await this.remoteConsoleInvoker?.invokeForRelaySession<unknown>(
              sessionId,
              "telegramMcp.notify.sendDocumentRemote",
              {
                ...input,
                session_id: sessionId,
              },
            ),
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
      this._config.terminal,
      workspaceDir,
      relativeFilePath,
    );
    const fileName = path.basename(relativeFilePath);
    const caption = input.caption?.trim();

    if (this._config.distributed.mode === "client") {
      return this.sendDocumentViaGatewayBoundSession({
        sessionId,
        filePath: relativeFilePath,
        fileName,
        contentBase64: Buffer.from(fileContent).toString("base64"),
        ...(caption ? { caption } : {}),
      });
    }

    const binding = await this.bindingStore.getBinding(sessionId);
    if (!binding) {
      throw new Error(
        "Session is not linked to Telegram, so the file cannot be sent there.",
      );
    }

    const absoluteFilePath = path.resolve(workspaceDir, relativeFilePath);
    const sent = await (this.transport as HumanTransport & {
      sendDocumentToChat?: (
        telegramChatId: number,
        filePath: string,
        caption?: string,
      ) => Promise<{ messageId: number }>;
    }).sendDocumentToChat?.(binding.telegramChatId, absoluteFilePath, caption);
    if (!sent) {
      throw new Error("Telegram document transport is unavailable.");
    }

    return {
      session_id: sessionId,
      file_path: absoluteFilePath,
      sent: true,
      ...(typeof sent.messageId === "number"
        ? { message_id: sent.messageId }
        : {}),
    };
  }

  public async sendForGatewayBoundSession(input: {
    clientUuid: string;
    localSessionId: string;
    message: string;
    sessionLabel?: string;
    task?: string;
    context?: string;
    riskLevel?: NotifyTelegramInput["risk_level"];
  }): Promise<NotifyTelegramOutput> {
    const relaySessionId = buildLiveRelaySessionId(
      input.clientUuid,
      input.localSessionId,
    );
    const binding = await this.bindingStore.getBinding(relaySessionId);
    if (!binding) {
      throw new Error(
        `Gateway relay session '${relaySessionId}' has no active Telegram route.`,
      );
    }

    const session = await this.sessionStore.getSession(relaySessionId);
    const sendResult = await this.transport.sendNotification({
      sessionId: relaySessionId,
      sessionLabel:
        input.sessionLabel ?? session?.label ?? input.localSessionId,
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      message: redactSecrets(input.message),
      ...(input.task ? { task: redactSecrets(input.task) } : {}),
      ...(input.context ? { context: redactSecrets(input.context) } : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
    });

    return {
      sent: true,
      ...(typeof sendResult.externalMessageId === "number"
        ? { message_id: sendResult.externalMessageId }
        : {}),
    };
  }

  public async sendRequestForGatewayBoundSession(input: {
    clientUuid: string;
    localSessionId: string;
    requestId: string;
    question: string;
    telegramChatId: number;
    telegramUserId: number;
    sessionLabel?: string;
    task?: string;
    context?: string;
    affectedFiles?: string[];
    options?: string[];
    recommendedOption?: string;
    riskLevel?: RiskLevel;
    fallbackIfTimeout?: string;
  }): Promise<{ request_id: string; message_id?: number }> {
    const relaySessionId = buildLiveRelaySessionId(
      input.clientUuid,
      input.localSessionId,
    );
    const binding = await this.bindingStore.getBinding(relaySessionId);
    if (!binding) {
      throw new Error("Gateway relay session has no active Telegram route yet.");
    }

    const session = await this.sessionStore.getSession(relaySessionId);
    const sendResult = await (this.transport as HumanTransport & {
      sendRequestForGatewayBoundSession?: (input: Parameters<HumanTransport["sendRequest"]>[0] & {
        sourceClientUuid: string;
      }) => Promise<{ externalMessageId?: string | number }>;
    }).sendRequestForGatewayBoundSession?.({
      requestId: input.requestId,
      sourceClientUuid: input.clientUuid,
      sessionId: relaySessionId,
      sessionLabel: input.sessionLabel ?? session?.label ?? input.localSessionId,
      recipient: {
        telegramChatId: binding.telegramChatId,
        telegramUserId: binding.telegramUserId,
      },
      ...(input.task ? { task: input.task } : {}),
      question: input.question,
      ...(input.context ? { context: input.context } : {}),
      ...(input.affectedFiles ? { affectedFiles: input.affectedFiles } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.recommendedOption
        ? { recommendedOption: input.recommendedOption }
        : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      ...(input.fallbackIfTimeout
        ? { fallbackIfTimeout: input.fallbackIfTimeout }
        : {}),
    });

    if (!sendResult) {
      throw new Error("Gateway transport request proxy is unavailable.");
    }

    return {
      request_id: input.requestId,
      ...(typeof sendResult.externalMessageId === "number"
        ? { message_id: sendResult.externalMessageId }
        : {}),
    };
  }

  public async sendDocumentForGatewayBoundSession(input: {
    clientUuid: string;
    localSessionId: string;
    fileName: string;
    contentBase64: string;
    caption?: string;
  }): Promise<NotifyTelegramOutput> {
    const relaySessionId = buildLiveRelaySessionId(
      input.clientUuid,
      input.localSessionId,
    );
    const binding = await this.bindingStore.getBinding(relaySessionId);
    if (!binding) {
      throw new Error("Gateway relay session has no active Telegram route yet.");
    }

    assertStringBodySize(input.contentBase64);
    const decodedContent = Buffer.from(input.contentBase64, "base64");
    assertBodySize(decodedContent.byteLength);
    const sendResult = await (this.transport as HumanTransport & {
      sendDocumentBufferToChat?: (
        telegramChatId: number,
        fileName: string,
        content: Uint8Array,
        caption?: string,
      ) => Promise<{ messageId: number }>;
    }).sendDocumentBufferToChat?.(
      binding.telegramChatId,
      input.fileName,
      decodedContent,
      input.caption,
    );

    if (!sendResult) {
      throw new Error("Gateway transport document proxy is unavailable.");
    }

    return {
      sent: true,
      ...(typeof sendResult.messageId === "number"
        ? { message_id: sendResult.messageId }
        : {}),
    };
  }

  private async sendViaGatewayBoundSession(input: {
    sessionId: string;
    sessionLabel?: string;
    message: string;
    task?: string;
    context?: string;
    riskLevel?: NotifyTelegramInput["risk_level"];
  }): Promise<NotifyTelegramOutput> {
    if (!this._config.distributed.gatewayPublicUrl) {
      throw new Error("Gateway is not configured.");
    }

    const clientUuid = await ensureGatewayClientUuid({
      maintenanceStore: this.maintenanceStore,
      gatewayPublicUrl: this._config.distributed.gatewayPublicUrl,
      ...(this._config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this._config.distributed.gatewayAuthToken }
        : {}),
      ...(this._config.distributed.gatewayToken
        ? { gatewayToken: this._config.distributed.gatewayToken }
        : {}),
      ...(this._config.project.name
        ? { projectName: this._config.project.name }
        : {}),
      ...(this._config.telegram.botUsername
        ? { botUsername: this._config.telegram.botUsername }
        : {}),
    });

    const url = normalizeGatewayBaseUrl(this._config.distributed.gatewayPublicUrl);
    url.pathname = `${url.pathname}/transport/notify`.replace(/\/{2,}/gu, "/");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this._config.distributed.gatewayAuthToken
          ? {
              authorization: `Bearer ${this._config.distributed.gatewayAuthToken}`,
            }
          : {}),
      },
      body: JSON.stringify({
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
        message: redactSecrets(input.message),
        ...(input.task ? { task: redactSecrets(input.task) } : {}),
        ...(input.context ? { context: redactSecrets(input.context) } : {}),
        ...(input.riskLevel ? { risk_level: input.riskLevel } : {}),
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || response.statusText);
    }

    const rawOutput = (await response.json()) as unknown;
    const normalized = normalizeNotifyTelegramOutput(rawOutput);
    if (normalized) {
      return normalized;
    }

    this.logger.error("notify_telegram received invalid gateway output", {
      sessionId: input.sessionId,
      output: rawOutput,
    });
    throw new Error(
      `Invalid notify_telegram gateway output: ${JSON.stringify(rawOutput)}`,
    );
  }

  private async sendDocumentViaGatewayBoundSession(input: {
    sessionId: string;
    filePath: string;
    fileName: string;
    contentBase64: string;
    caption?: string;
  }): Promise<SendFileToTelegramOutput> {
    if (!this._config.distributed.gatewayPublicUrl) {
      throw new Error(
        "File delivery to Telegram on client nodes requires GATEWAY_PUBLIC_URL.",
      );
    }

    const clientUuid = await ensureGatewayClientUuid({
      maintenanceStore: this.maintenanceStore,
      gatewayPublicUrl: this._config.distributed.gatewayPublicUrl,
      ...(this._config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this._config.distributed.gatewayAuthToken }
        : {}),
      ...(this._config.distributed.gatewayToken
        ? { gatewayToken: this._config.distributed.gatewayToken }
        : {}),
      ...(this._config.project.name
        ? { projectName: this._config.project.name }
        : {}),
      ...(this._config.telegram.botUsername
        ? { botUsername: this._config.telegram.botUsername }
        : {}),
      ...(this._config.distributed.gatewayUserUuid
        ? { gatewayUserUuid: this._config.distributed.gatewayUserUuid }
        : {}),
    });

    const output = await callGatewayJson<{
      sent?: boolean;
      message_id?: number;
    }>({
      gatewayPublicUrl: this._config.distributed.gatewayPublicUrl,
      ...(this._config.distributed.gatewayAuthToken
        ? { gatewayAuthToken: this._config.distributed.gatewayAuthToken }
        : {}),
      endpointPath: "/transport/document",
      body: {
        client_uuid: clientUuid,
        local_session_id: input.sessionId,
        file_name: input.fileName,
        content_base64: input.contentBase64,
        ...(input.caption ? { caption: input.caption } : {}),
      },
    });

    if (!output.sent) {
      throw new Error(
        "Gateway did not confirm Telegram document delivery for the file.",
      );
    }

    return {
      session_id: input.sessionId,
      file_path: input.filePath,
      sent: true,
      ...(typeof output.message_id === "number"
        ? { message_id: output.message_id }
        : {}),
    };
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

  private async resolveSessionContextForNotification(
    sessionId: string,
  ): Promise<SessionContext | null> {
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<GetSessionContextOutput>(
      sessionId,
      "telegramMcp.sessionContext.getContextRemote",
      { session_id: sessionId },
    );
    if (remote?.context) {
      return {
        sessionId: remote.session_id,
        ...(remote.context.session_label
          ? { label: remote.context.session_label }
          : {}),
        ...(remote.context.cwd ? { cwd: remote.context.cwd } : {}),
        ...(remote.context.active_project_uuid
          ? { activeProjectUuid: remote.context.active_project_uuid }
          : {}),
        ...(remote.context.active_project_name
          ? { activeProjectName: remote.context.active_project_name }
          : {}),
        ...(remote.context.task ? { task: remote.context.task } : {}),
        ...(remote.context.summary ? { summary: remote.context.summary } : {}),
        ...(remote.context.files ? { files: remote.context.files } : {}),
        ...(remote.context.decisions
          ? { decisions: remote.context.decisions }
          : {}),
        ...(remote.context.risks ? { risks: remote.context.risks } : {}),
        ...(remote.context.updated_at
          ? { updatedAt: remote.context.updated_at }
          : { updatedAt: new Date().toISOString() }),
      };
    }

    return this.sessionStore.getSession(sessionId);
  }
}
