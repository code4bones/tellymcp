import type { AppConfig } from "../../../app/config/env.js";
import type {
  NotifyTelegramInput,
  NotifyTelegramOutput,
} from "../../../entities/request/model/types.js";
import type { SessionContext } from "../../../entities/session/model/types.js";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../../shared/api/storage/contract.js";
import type { HumanTransport } from "../../../shared/api/transport/contract.js";
import type { Logger } from "../../../shared/lib/logger/logger.js";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity.js";
import { redactSecrets } from "../../../shared/lib/redact-secrets/redactSecrets.js";

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

export class NotifyService {
  public constructor(
    private readonly _config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly transport: HumanTransport,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async send(input: NotifyTelegramInput): Promise<NotifyTelegramOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    if (!binding) {
      throw new Error(
        "Session is not linked to Telegram. Call create_session_pair_code first.",
      );
    }

    const session = await this.sessionStore.getSession(resolved.sessionId);
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
}
