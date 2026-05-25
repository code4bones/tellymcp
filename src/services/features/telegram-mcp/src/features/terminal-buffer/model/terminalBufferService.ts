import type { AppConfig } from "../../../app/config/env";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";
import type { SessionStore } from "../../../shared/api/storage/contract";
import { captureTerminalPaneRange, getTerminalWindowHeight } from "../../../shared/integrations/terminal/client";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";
import type { TerminalCaptureScope } from "../../../shared/integrations/telegram/transportTypes";
import { slugifyFilenamePart } from "../../../shared/integrations/telegram/transportUtils";

type RemoteConsoleInvoker = {
  invokeForRelaySession<T>(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<T>;
};

export type CaptureTerminalBufferInput = {
  session_id?: string;
  cwd?: string;
  scope: TerminalCaptureScope;
};

export type CaptureTerminalBufferOutput = {
  session_id: string;
  session_label?: string;
  terminal_target: string;
  filename: string;
  markdown_content: string;
  capture_mode: TerminalCaptureScope["mode"];
  scope_description: string;
};

export class TerminalBufferService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
    private readonly remoteConsoleInvoker?: RemoteConsoleInvoker,
  ) {}

  public async captureBuffer(
    input: CaptureTerminalBufferInput,
  ): Promise<CaptureTerminalBufferOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const remote = await this.remoteConsoleInvoker?.invokeForRelaySession<CaptureTerminalBufferOutput>(
      resolved.sessionId,
      "telegramMcp.terminalBuffer.captureBufferRemote",
      input as Record<string, unknown>,
    );
    if (remote) {
      return remote;
    }

    const session = await this.sessionStore.getSession(resolved.sessionId);
    const target = session?.terminalTarget?.trim();
    if (!target) {
      throw new Error("terminal target is not configured for this session");
    }

    const paneStart = await this.resolveCaptureStart(target, input.scope);
    const stdout = await captureTerminalPaneRange(
      this.config.terminal,
      target,
      paneStart,
      false,
    );

    const capturedAt = new Date().toISOString();
    const scopeDescription = this.describeCaptureScope(input.scope);
    const titleBase = session?.label ?? resolved.sessionLabel ?? resolved.sessionId;
    const filenameBase = slugifyFilenamePart(titleBase) || "session-buffer";
    const timestamp = capturedAt.replace(/[:.]/g, "-");
    const filename = `${filenameBase}-${timestamp}.md`;
    const markdownContent = [
      "# Terminal Buffer",
      "",
      `- Session: ${session?.label ?? resolved.sessionLabel ?? resolved.sessionId}`,
      `- Session ID: ${resolved.sessionId}`,
      `- terminal target: ${target}`,
      `- Capture scope: ${scopeDescription}`,
      `- Captured at: ${capturedAt}`,
      "",
      "```text",
      stdout.replaceAll("\u0000", ""),
      "```",
      "",
    ].join("\n");

    this.logger.info("Terminal buffer captured", {
      sessionId: resolved.sessionId,
      terminalTarget: target,
      captureMode: input.scope.mode,
      scopeDescription,
      isRelay: Boolean(parseLiveRelaySessionId(resolved.sessionId)),
    });

    return {
      session_id: resolved.sessionId,
      ...(session?.label ?? resolved.sessionLabel
        ? { session_label: session?.label ?? resolved.sessionLabel }
        : {}),
      terminal_target: target,
      filename,
      markdown_content: markdownContent,
      capture_mode: input.scope.mode,
      scope_description: scopeDescription,
    };
  }

  private async resolveCaptureStart(
    target: string,
    scope: TerminalCaptureScope,
  ): Promise<string> {
    if (scope.mode === "full") {
      return "-";
    }
    if (scope.mode === "lines") {
      return `-${scope.lines}`;
    }
    const height = await getTerminalWindowHeight(this.config.terminal, target);
    if (typeof height !== "number" || height <= 0) {
      return `-${this.config.terminal.captureLines}`;
    }
    return `-${height}`;
  }

  private describeCaptureScope(scope: TerminalCaptureScope): string {
    switch (scope.mode) {
      case "visible":
        return "visible pane";
      case "lines":
        return `last ${scope.lines} lines`;
      case "full":
        return "full history";
    }
  }
}
