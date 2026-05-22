import type { AppConfig } from "../../../app/config/env";
import type { SessionStore } from "../../../shared/api/storage/contract";
import {
  ensureTerminalTargetForSession,
  sendTerminalLiteralLine,
} from "../../../shared/integrations/terminal/client";
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
    const terminalTarget = ensureTerminalTargetForSession(this.config.tmux, {
      sessionId,
      ...(typeof session?.cwd === "string" ? { cwd: session.cwd } : {}),
      ...(typeof session?.tmuxTarget === "string"
        ? { target: session.tmuxTarget }
        : {}),
    });
    if (!terminalTarget) {
      throw new Error("terminal target is not configured for this console");
    }

    const submittedText = buildSubmittedText(input);
    if (!submittedText) {
      throw new Error("text is required");
    }

    if (
      !session ||
      session.tmuxTarget !== terminalTarget ||
      session.tmuxPaneId !== terminalTarget
    ) {
      await this.sessionStore.setSession({
        sessionId,
        ...(typeof session?.label === "string" ? { label: session.label } : {}),
        ...(typeof session?.cwd === "string" ? { cwd: session.cwd } : {}),
        ...(typeof session?.linkedSessionId === "string"
          ? { linkedSessionId: session.linkedSessionId }
          : {}),
        ...(typeof session?.activeProjectUuid === "string"
          ? { activeProjectUuid: session.activeProjectUuid }
          : {}),
        ...(typeof session?.activeProjectName === "string"
          ? { activeProjectName: session.activeProjectName }
          : {}),
        ...(typeof session?.task === "string" ? { task: session.task } : {}),
        ...(typeof session?.summary === "string"
          ? { summary: session.summary }
          : {}),
        ...(Array.isArray(session?.files) ? { files: session.files } : {}),
        ...(Array.isArray(session?.decisions)
          ? { decisions: session.decisions }
          : {}),
        ...(Array.isArray(session?.risks) ? { risks: session.risks } : {}),
        tmuxPaneId: terminalTarget,
        tmuxTarget: terminalTarget,
        ...(typeof session?.tmuxSessionName === "string"
          ? { tmuxSessionName: session.tmuxSessionName }
          : {}),
        ...(typeof session?.tmuxWindowName === "string"
          ? { tmuxWindowName: session.tmuxWindowName }
          : {}),
        ...(typeof session?.tmuxWindowIndex === "number"
          ? { tmuxWindowIndex: session.tmuxWindowIndex }
          : {}),
        ...(typeof session?.tmuxPaneIndex === "number"
          ? { tmuxPaneIndex: session.tmuxPaneIndex }
          : {}),
        ...(typeof session?.lastTmuxNudgeAt === "string"
          ? { lastTmuxNudgeAt: session.lastTmuxNudgeAt }
          : {}),
        ...(typeof session?.lastSeenToolsHash === "string"
          ? { lastSeenToolsHash: session.lastSeenToolsHash }
          : {}),
        ...(typeof session?.lastNotifiedToolsHash === "string"
          ? { lastNotifiedToolsHash: session.lastNotifiedToolsHash }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    }

    this.logger.info("Submitting direct human terminal message", {
      sessionId,
      terminalTarget,
      sourceLabel: input.source_label,
      attachmentCount: input.attachments?.length ?? 0,
      textLength: submittedText.length,
    });

    await sendTerminalLiteralLine(
      this.config.tmux,
      terminalTarget,
      submittedText,
    );

    this.logger.info("Direct human terminal message submitted", {
      sessionId,
      terminalTarget,
      sourceLabel: input.source_label,
      attachmentCount: input.attachments?.length ?? 0,
    });

    return {
      ok: true,
      session_id: sessionId,
      terminal_target: terminalTarget,
      submitted_text: submittedText,
    };
  }
}
