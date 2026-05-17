import { describe, expect, it } from "vitest";

import {
  isTmuxTargetInvalidError,
  isTmuxUnavailableError,
} from "@src/services/features/telegram-mcp/src/shared/integrations/tmux/client";

describe("tmux error classifiers", () => {
  it("detects unavailable tmux runtime errors", () => {
    expect(isTmuxUnavailableError(new Error("ENOENT: tmux not found"))).toBe(true);
    expect(isTmuxUnavailableError(new Error("error connecting to /tmp/tmux-1000/default"))).toBe(true);
  });

  it("detects stale tmux target errors", () => {
    expect(isTmuxTargetInvalidError(new Error("can't find pane: %1"))).toBe(true);
    expect(isTmuxTargetInvalidError(new Error("can't find window: @3"))).toBe(true);
    expect(isTmuxTargetInvalidError(new Error("can't find session: backend"))).toBe(true);
  });

  it("does not confuse generic errors with invalid target errors", () => {
    expect(isTmuxTargetInvalidError(new Error("permission denied"))).toBe(false);
    expect(isTmuxUnavailableError(new Error("can't find pane: %1"))).toBe(false);
  });
});
