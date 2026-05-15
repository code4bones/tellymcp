import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";

export function isExecutorTargetKind(kind: PartnerNoteKind): boolean {
  return kind === "question" || kind === "request";
}

export function getCollabRouteSemantics(input: {
  kind: PartnerNoteKind;
  sourceLabel: string;
  targetLabel: string;
}): {
  executesOnTarget: boolean;
  route: string;
  expectedReplyRoute?: string;
  sendRoute?: string;
} {
  const executesOnTarget = isExecutorTargetKind(input.kind);
  return executesOnTarget
    ? {
        executesOnTarget,
        route: `${input.targetLabel} -> ${input.sourceLabel}`,
        expectedReplyRoute: `${input.targetLabel} -> ${input.sourceLabel}`,
      }
    : {
        executesOnTarget,
        route: `${input.sourceLabel} -> ${input.targetLabel}`,
        sendRoute: `${input.sourceLabel} -> ${input.targetLabel}`,
      };
}
