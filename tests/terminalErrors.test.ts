import { describe, expect, it } from "vitest";

import {
  isTerminalTargetInvalidError,
  isTerminalUnavailableError,
} from "@src/services/features/telegram-mcp/src/shared/integrations/terminal/client";

describe("terminal error classifiers", () => {
  it("detects unavailable terminal runtime errors", () => {
    expect(
      isTerminalUnavailableError(new Error("pty target is unavailable")),
    ).toBe(true);
  });

  it("detects stale terminal target errors", () => {
    expect(
      isTerminalTargetInvalidError(new Error("unknown pty target: pty:missing")),
    ).toBe(true);
  });

  it("does not confuse generic errors with invalid target errors", () => {
    expect(isTerminalTargetInvalidError(new Error("permission denied"))).toBe(false);
    expect(
      isTerminalUnavailableError(new Error("unknown pty target: pty:missing")),
    ).toBe(false);
  });
});
