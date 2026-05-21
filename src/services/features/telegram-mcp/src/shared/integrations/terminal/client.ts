import {
  captureTmuxPaneRange,
  captureVisibleTmuxPane,
  ensureTerminalTargetForSession,
  getConfiguredTerminalShell,
  getConfiguredTerminalShellDisplayName,
  getTmuxWindowHeight,
  isTmuxTargetInvalidError,
  isTmuxUnavailableError,
  listXchangeFiles,
  readWorkspaceFile,
  resolveTmuxTargetFromHint,
  sendAllowedTmuxAction,
  sendTmuxLiteralLine,
  sendTmuxLiteralText,
  writeXchangeFile,
  writeXchangeRelativeFile,
  ensureXchangeDir,
  deleteXchangeFile,
  type AllowedTmuxAction,
  type TmuxRuntimeConfig,
} from "../tmux/client";
import {
  resizePtyTarget,
  sendPtyText,
  stopAllPtyTargets,
  stopPtyTarget,
  subscribePtyTarget,
  type PtyExitInfo,
} from "./ptyRegistry";

export type TerminalRuntimeConfig = TmuxRuntimeConfig;
export type AllowedTerminalAction = AllowedTmuxAction;

export {
  captureTmuxPaneRange as captureTerminalPaneRange,
  captureVisibleTmuxPane as captureVisibleTerminal,
  ensureTerminalTargetForSession,
  getConfiguredTerminalShell,
  getConfiguredTerminalShellDisplayName,
  getTmuxWindowHeight as getTerminalWindowHeight,
  isTmuxTargetInvalidError as isTerminalTargetInvalidError,
  isTmuxUnavailableError as isTerminalUnavailableError,
  resolveTmuxTargetFromHint as resolveTerminalTargetFromHint,
  sendAllowedTmuxAction as sendAllowedTerminalAction,
  sendTmuxLiteralLine as sendTerminalLiteralLine,
  sendTmuxLiteralText as sendTerminalLiteralText,
  writeXchangeFile,
  writeXchangeRelativeFile,
  ensureXchangeDir,
  listXchangeFiles,
  deleteXchangeFile,
  readWorkspaceFile,
};

export type TerminalExitInfo = PtyExitInfo;

export function sendForegroundTerminalInput(
  target: string,
  text: string,
): void {
  sendPtyText(target, text);
}

export function resizeForegroundTerminal(
  target: string,
  cols: number,
  rows: number,
): void {
  resizePtyTarget(target, cols, rows);
}

export function subscribeForegroundTerminal(
  target: string,
  input: {
    onData?: ((data: string) => void) | undefined;
    onExit?: ((info: TerminalExitInfo) => void) | undefined;
  },
): () => void {
  return subscribePtyTarget(target, input);
}

export function stopForegroundTerminal(target: string): boolean {
  return stopPtyTarget(target);
}

export function stopAllForegroundTerminals(): void {
  stopAllPtyTargets();
}
