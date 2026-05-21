import type { AppConfig } from "../../../app/config/env";
import type {
  NotifyTelegramInput,
  NotifyTelegramOutput,
} from "../../../entities/request/model/types";
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
import type { RiskLevel } from "../../../shared/types/common";
import { buildLiveRelaySessionId } from "../../../app/webapp/relay";
import {
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
  ): Promise<T | null>;
};

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
  ) {}

  public async send(input: NotifyTelegramInput): Promise<NotifyTelegramOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    if (!binding) {
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
      throw new Error("Gateway relay session is not linked to Telegram yet.");
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
      throw new Error("Gateway relay session is not linked to Telegram yet.");
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

    return (await response.json()) as NotifyTelegramOutput;
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
        ...(remote.context.linked_session_id
          ? { linkedSessionId: remote.context.linked_session_id }
          : {}),
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
