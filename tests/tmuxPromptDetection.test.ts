import { describe, expect, it } from "vitest";

import { detectTmuxInteractivePrompt } from "../src/services/features/telegram-mcp/src/shared/lib/tmuxPromptDetection";

describe("tmux prompt detection", () => {
  it("detects strong interactive prompts with yes/no markers", () => {
    const detection = detectTmuxInteractivePrompt(`
Agent wants to continue with risky cleanup.
Proceed? [y/N]
`);

    expect(detection).not.toBeNull();
    expect(detection?.score).toBeGreaterThanOrEqual(5);
    expect(detection?.reasons).toContain("yes_no_prompt");
  });

  it("detects waiting-for-input prompts with enter hints", () => {
    const detection = detectTmuxInteractivePrompt(`
Setup is almost complete.
Press Enter to continue
`);

    expect(detection).not.toBeNull();
    expect(detection?.reasons).toContain("press_enter_prompt");
  });

  it("ignores generic logs without prompt structure", () => {
    const detection = detectTmuxInteractivePrompt(`
[2026-05-19 15:00:00.000] INFO app started
stack trace follows
at bootstrap (/app/index.js:10:4)
continue reading logs in /tmp/output.log
`);

    expect(detection).toBeNull();
  });

  it("uses balanced mode to pick up softer question flows", () => {
    const detection = detectTmuxInteractivePrompt(
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
    const detection = detectTmuxInteractivePrompt(`
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
});
