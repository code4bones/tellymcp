import { describe, expect, it } from "vitest";

import { detectTerminalInteractivePrompt } from "../src/services/features/telegram-mcp/src/shared/lib/terminalPromptDetection";

describe("terminal prompt detection", () => {
  it("detects strong interactive prompts with yes/no markers", () => {
    const detection = detectTerminalInteractivePrompt(`
Agent wants to continue with risky cleanup.
Proceed? [y/N]
`);

    expect(detection).not.toBeNull();
    expect(detection?.score).toBeGreaterThanOrEqual(5);
    expect(detection?.reasons).toContain("yes_no_prompt");
  });

  it("detects waiting-for-input prompts with enter hints", () => {
    const detection = detectTerminalInteractivePrompt(`
Setup is almost complete.
Press Enter to continue
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("press_enter_prompt");
  });

  it("ignores generic logs without prompt structure", () => {
    const detection = detectTerminalInteractivePrompt(`
[2026-05-19 15:00:00.000] INFO app started
stack trace follows
at bootstrap (/app/index.js:10:4)
continue reading logs in /tmp/output.log
`);

    expect(detection).toBeNull();
  });

  it("uses balanced mode to pick up softer question flows", () => {
    const detection = detectTerminalInteractivePrompt(
      `
I need your input before I continue.
Choose one option below
1. Apply the patch
2. Stop here
`,
      { strategy: "balanced", minScore: 4 },
    );

    expect(detection).not.toBeNull();
    expect(detection?.score).toBeGreaterThanOrEqual(4);
  });

  it("detects codex action-required tool approval prompts", () => {
    const detection = detectTerminalInteractivePrompt(`
Field 1/1 (1 required unanswered)
Allow the leechmcp MCP server to run tool "notify_telegram"?

1. Allow                        Run the tool and continue.
2. Allow for this session       Run the tool and remember this choice for this session.
3. Always allow                 Run the tool and remember this choice for future tool calls.
4. Cancel                       Cancel this tool call
enter to submit | esc to cancel

"[ ! ] Action Required"
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("action_required_banner");
    expect(detection?.reasons).toContain("required_unanswered_field");
    expect(detection?.reasons).toContain("tool_continue_prompt");
    expect(detection?.score).toBeGreaterThanOrEqual(8);
  });

  it("does not treat a plain user question as an interactive approval prompt", () => {
    const detection = detectTerminalInteractivePrompt(`
› спроси у leftDev сколько время ?
`);

    expect(detection).toBeNull();
  });

  it("detects allow-choice approval screens without relying on the action banner", () => {
    const detection = detectTerminalInteractivePrompt(`
Field 1/1
Allow the telegramHuman MCP server to run tool "refresh_tools_markdown"?

1. Allow                        Run the tool and continue.
2. Allow for this session       Run the tool and remember this choice for this session.
3. Always allow                 Run the tool and remember this choice for future tool calls.
4. Cancel                       Cancel this tool call
enter to submit | esc to cancel
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("approval_choice_group");
    expect(detection?.reasons).toContain("submit_cancel_hint");
    expect(detection?.score).toBeGreaterThanOrEqual(8);
  });

  it("detects command approval blocker screens from the screenshot flow", () => {
    const detection = detectTerminalInteractivePrompt(`
Would you like to run the following command?

Reason: Do you want to restart the system nginx service?

$ systemctl restart nginx

1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with \`systemctl restart nginx\` (p)
3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("command_approval_prompt");
    expect(detection?.reasons).toContain("confirm_cancel_prompt");
    expect(detection?.reasons).toContain("proceed_choice_group");
    expect(detection?.score).toBeGreaterThanOrEqual(8);
  });

  it("detects numbered approval choices when the selected option has a leading marker", () => {
    const detection = detectTerminalInteractivePrompt(`
Would you like to run the following command?
$ rm -f /tmp/test.txt && test ! -e /tmp/test.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`rm -f /tmp/test.txt\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("numbered_choice_group");
    expect(detection?.reasons).toContain("yes_no_choice_group");
    expect(detection?.reasons).toContain("proceed_choice_group");
    expect(detection?.score).toBeGreaterThanOrEqual(8);
    expect(detection?.excerpt).toContain(
      "Would you like to run the following command?",
    );
  });

  it("keeps the same fingerprint when the selection marker moves between numbered choices", () => {
    const first = detectTerminalInteractivePrompt(`
Would you like to run the following command?
$ rm -f /tmp/test.txt && test ! -e /tmp/test.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`rm -f /tmp/test.txt\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
`);

    const second = detectTerminalInteractivePrompt(`
Would you like to run the following command?
$ rm -f /tmp/test.txt && test ! -e /tmp/test.txt
  1. Yes, proceed (y)
› 2. Yes, and don't ask again for commands that start with \`rm -f /tmp/test.txt\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
`);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.fingerprint).toBe(second?.fingerprint);
  });
});
