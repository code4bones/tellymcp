import type {
  SessionBindingStore,
  SessionStore,
  PendingRequestStore,
} from "../../../shared/api/storage/contract.js";
import type { HumanTransport } from "../../../shared/api/transport/contract.js";
import type { Logger } from "../../../shared/lib/logger/logger.js";
import { redactSecrets } from "../../../shared/lib/redact-secrets/redactSecrets.js";
import type {
  AskUserTelegramInput,
  AskUserTelegramOutput,
  PendingRequestRecord,
} from "../../../entities/request/model/types.js";
import type { AppConfig } from "../../../app/config/env.js";
import type { QueueMode } from "../../../shared/types/common.js";
import type { SessionContext } from "../../../entities/session/model/types.js";
import { createRequestId } from "../../../shared/lib/ids/ids.js";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity.js";

type QueuedJob = {
  request: PendingRequestRecord;
  resolve: (value: AskUserTelegramOutput) => void;
  reject: (error: Error) => void;
};

function mergeSavedContext(
  input: AskUserTelegramInput,
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

export class HumanApprovalOrchestrator {
  private processingQueue = false;
  private readonly queuedJobs = new Map<string, QueuedJob>();

  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly bindingStore: SessionBindingStore,
    private readonly pendingStore: PendingRequestStore,
    private readonly transport: HumanTransport,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async submit(
    input: AskUserTelegramInput,
  ): Promise<AskUserTelegramOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults({
      session_id: input.session_id,
    });
    const binding = await this.bindingStore.getBinding(resolved.sessionId);
    if (!binding) {
      throw new Error(
        "Session is not linked to Telegram. Call create_session_pair_code first.",
      );
    }

    const session = await this.sessionStore.getSession(resolved.sessionId);
    const merged = mergeSavedContext(input, session);
    const requestId = createRequestId();
    const requestRecord: PendingRequestRecord = {
      requestId,
      sessionId: resolved.sessionId,
      ...(merged.sessionLabel
        ? { sessionLabel: merged.sessionLabel }
        : resolved.sessionLabel
          ? { sessionLabel: resolved.sessionLabel }
          : {}),
      question: redactSecrets(input.question),
      ...(merged.task ? { task: redactSecrets(merged.task) } : {}),
      ...(merged.context ? { context: redactSecrets(merged.context) } : {}),
      ...(input.affected_files?.length
        ? {
            affectedFiles: input.affected_files.map((file) =>
              redactSecrets(file),
            ),
          }
        : {}),
      ...(input.options?.length
        ? { options: input.options.map((option) => redactSecrets(option)) }
        : {}),
      ...(input.recommended_option
        ? { recommendedOption: redactSecrets(input.recommended_option) }
        : {}),
      ...(input.risk_level ? { riskLevel: input.risk_level } : {}),
      timeoutSeconds:
        input.timeout_seconds ?? this.config.telegram.defaultTimeoutSeconds,
      ...(input.fallback_if_timeout
        ? { fallbackIfTimeout: redactSecrets(input.fallback_if_timeout) }
        : {}),
      telegramChatId: binding.telegramChatId,
      telegramUserId: binding.telegramUserId,
      queuedAt: new Date().toISOString(),
      status: this.config.mode === "queue" ? "queued" : "active",
    };

    if (this.config.mode === "reject") {
      const active = await this.pendingStore.getActive();
      if (active) {
        throw new Error(
          `Another request is already pending: ${active.requestId}`,
        );
      }
      return this.runRequest(requestRecord);
    }

    return new Promise<AskUserTelegramOutput>((resolve, reject) => {
      this.queuedJobs.set(requestId, {
        request: requestRecord,
        resolve,
        reject,
      });

      void this.pendingStore.enqueue(requestRecord).then(
        () => {
          void this.processQueue();
        },
        (error: unknown) => {
          this.queuedJobs.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) {
      return;
    }

    this.processingQueue = true;
    try {
      while (true) {
        const next = await this.pendingStore.dequeueNext();
        if (!next) {
          return;
        }

        const queuedJob = this.queuedJobs.get(next.requestId);
        if (!queuedJob) {
          continue;
        }

        try {
          const result = await this.runRequest({
            ...next,
            status: "active",
          });
          this.queuedJobs.delete(next.requestId);
          queuedJob.resolve(result);
        } catch (error) {
          this.queuedJobs.delete(next.requestId);
          queuedJob.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async runRequest(
    request: PendingRequestRecord,
  ): Promise<AskUserTelegramOutput> {
    const active: PendingRequestRecord = {
      ...request,
      status: "active",
    };

    await this.pendingStore.createPending(active);
    this.logger.info("Pending request created", {
      requestId: active.requestId,
      sessionId: active.sessionId,
    });

    try {
      const sendResult = await this.transport.sendRequest({
        requestId: active.requestId,
        sessionId: active.sessionId,
        ...(active.sessionLabel ? { sessionLabel: active.sessionLabel } : {}),
        recipient: {
          telegramChatId: active.telegramChatId,
          telegramUserId: active.telegramUserId,
        },
        ...(active.task ? { task: active.task } : {}),
        question: active.question,
        ...(active.context ? { context: active.context } : {}),
        ...(active.affectedFiles
          ? { affectedFiles: active.affectedFiles }
          : {}),
        ...(active.options ? { options: active.options } : {}),
        ...(active.recommendedOption
          ? { recommendedOption: active.recommendedOption }
          : {}),
        ...(active.riskLevel ? { riskLevel: active.riskLevel } : {}),
        ...(active.fallbackIfTimeout
          ? { fallbackIfTimeout: active.fallbackIfTimeout }
          : {}),
      });

      const sentRequest: PendingRequestRecord = {
        ...active,
        ...(typeof sendResult.externalMessageId === "number"
          ? { telegramMessageId: sendResult.externalMessageId }
          : {}),
        sentAt: new Date().toISOString(),
      };

      await this.pendingStore.updatePending(sentRequest);

      const reply = await this.transport.waitForReply(
        sentRequest.requestId,
        sentRequest.timeoutSeconds,
      );

      if (!reply) {
        await this.pendingStore.resolvePending(sentRequest.requestId, {
          status: "timed_out",
          ...(sentRequest.fallbackIfTimeout
            ? { fallbackUsed: sentRequest.fallbackIfTimeout }
            : {}),
        });

        this.logger.warn("Pending request timed out", {
          requestId: sentRequest.requestId,
        });

        return {
          request_id: sentRequest.requestId,
          answer: null,
          timed_out: true,
          ...(sentRequest.fallbackIfTimeout
            ? { fallback_used: sentRequest.fallbackIfTimeout }
            : {}),
        };
      }

      await this.pendingStore.resolvePending(sentRequest.requestId, {
        status: "answered",
        answer: redactSecrets(reply.answer),
        receivedAt: reply.receivedAt,
      });

      this.logger.info("Pending request answered", {
        requestId: sentRequest.requestId,
      });

      return {
        request_id: sentRequest.requestId,
        answer: redactSecrets(reply.answer),
        timed_out: false,
        received_at: reply.receivedAt,
      };
    } catch (error) {
      await this.pendingStore.resolvePending(active.requestId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.logger.error("Pending request failed", {
        requestId: active.requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  public get mode(): QueueMode {
    return this.config.mode;
  }
}
