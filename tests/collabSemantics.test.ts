import { describe, expect, it } from "vitest";

import {
  getCollabRouteSemantics,
  isExecutorTargetKind,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/collabSemantics";

describe("collab semantics", () => {
  it("treats Ask kinds as target-executed", () => {
    expect(isExecutorTargetKind("question")).toBe(true);
    expect(isExecutorTargetKind("request")).toBe(true);
  });

  it("treats Share/Reply/Handoff kinds as current-executed", () => {
    expect(isExecutorTargetKind("share")).toBe(false);
    expect(isExecutorTargetKind("reply")).toBe(false);
    expect(isExecutorTargetKind("handoff")).toBe(false);
  });

  it("builds Ask route as member to current", () => {
    expect(
      getCollabRouteSemantics({
        kind: "question",
        sourceLabel: "leftDev",
        targetLabel: "backend",
      }),
    ).toEqual({
      executesOnTarget: true,
      route: "backend -> leftDev",
      expectedReplyRoute: "backend -> leftDev",
    });
  });

  it("builds Share route as current to member", () => {
    expect(
      getCollabRouteSemantics({
        kind: "share",
        sourceLabel: "leftDev",
        targetLabel: "backend",
      }),
    ).toEqual({
      executesOnTarget: false,
      route: "leftDev -> backend",
      sendRoute: "leftDev -> backend",
    });
  });
});
