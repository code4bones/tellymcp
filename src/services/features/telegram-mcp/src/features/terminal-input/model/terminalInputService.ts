import type { AppConfig } from "../../../app/config/env";
import type { SessionStore } from "../../../shared/api/storage/contract";
import { sendTerminalLiteralLine } from "../../../shared/integrations/terminal/client";
import type { Logger } from "../../../shared/lib/logger/logger";

export type SubmitHumanTerminalMessageInput = {
  session_id: string;
  text: string;
  attachments?: string[] | undefined;
  source_label?: string | undefined;
};

export type SubmitHumanTerminalMessageOutput = {
  ok: true;
  session_id: string;
  terminal_target: string;
  submitted_text: string;
};

function buildSubmittedText(input: SubmitHumanTerminalMessageInput): string {
  const text = input.text.trim();
  const attachments = (input.attachments ?? []).filter(
    (item) => typeof item === "string" && item.trim().length > 0,
  );

  if (attachments.length === 0) {
    return text;
  }

  return `${text} [attachments saved: ${attachments.join(", ")}]`.trim();
}

export class TerminalInputService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
  ) {}

  public async submitHumanMessage(
    input: SubmitHumanTerminalMessageInput,
  ): Promise<SubmitHumanTerminalMessageOutput> {
    const sessionId = input.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }

    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.tmuxTarget) {
      throw new Error("terminal target is not configured for this console");
    }

    const submittedText = buildSubmittedText(input);
    if (!submittedText) {
      throw new Error("text is required");
    }

    await sendTerminalLiteralLine(
      this.config.tmux,
      session.tmuxTarget,
      submittedText,
    );

    this.logger.info("Direct human terminal message submitted", {
      sessionId,
      terminalTarget: session.tmuxTarget,
      sourceLabel: input.source_label,
      attachmentCount: input.attachments?.length ?? 0,
    });

    return {
      ok: true,
      session_id: sessionId,
      terminal_target: session.tmuxTarget,
      submitted_text: submittedText,
    };
  }
}
