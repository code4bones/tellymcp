import { createHash } from "node:crypto";

export type TerminalPromptScanStrategy = "strict" | "balanced";

export type TerminalPromptDetection = {
  score: number;
  fingerprint: string;
  excerpt: string;
  matchedLines: string[];
  reasons: string[];
  promptActions?: {
    numberedOptions: string[];
    hasEnter: boolean;
    hasEscape: boolean;
  };
};

type DetectionOptions = {
  strategy?: TerminalPromptScanStrategy;
  minScore?: number;
  maxLines?: number;
};

type ScoreContribution = {
  score: number;
  reason: string;
};

type ChoiceActionBlock = {
  footerLine: string | null;
  choiceLines: string[];
  headerLines: string[];
  tailLines: string[];
};

const ANSI_ESCAPE_SEQUENCE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;

const STRONG_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  {
    pattern: /\[(?:[Yy]\/[Nn]|[Nn]\/[Yy])\]|\((?:[Yy]\/[Nn]|[Nn]\/[Yy])\)/u,
    score: 5,
    reason: "yes_no_prompt",
  },
  {
    pattern: /press\s+enter\s+to\s+continue|hit\s+enter\s+to\s+continue/iu,
    score: 5,
    reason: "press_enter_prompt",
  },
  {
    pattern: /press\s+enter\s+to\s+confirm\b.*\besc\s+to\s+cancel/iu,
    score: 5,
    reason: "confirm_cancel_prompt",
  },
  {
    pattern:
      /waiting\s+for\s+(?:user\s+)?input|awaiting\s+(?:user\s+)?(?:input|confirmation)|requires?\s+approval|need\s+your\s+(?:input|permission|approval)|cannot\s+continue\s+without/iu,
    score: 4,
    reason: "waiting_for_input",
  },
  {
    pattern:
      /\b(do\s+you\s+want|are\s+you\s+sure|would\s+you\s+like|should\s+i|can\s+i\s+go\s+ahead|may\s+i\s+proceed)\b/iu,
    score: 4,
    reason: "direct_question_phrase",
  },
  {
    pattern: /\[\s*!\s*\]\s*action\s+required\b/iu,
    score: 5,
    reason: "action_required_banner",
  },
  {
    pattern: /\bfield\s+\d+\/\d+\s+\(\d+\s+required\s+unanswered\)/iu,
    score: 5,
    reason: "required_unanswered_field",
  },
  {
    pattern: /\ballow\s+the\s+.+\?\s*$/iu,
    score: 4,
    reason: "allow_question",
  },
  {
    pattern: /\brun\s+the\s+tool\s+and\s+continue\b/iu,
    score: 4,
    reason: "tool_continue_prompt",
  },
  {
    pattern: /\bwould\s+you\s+like\s+to\s+run\s+the\s+following\s+command\b/iu,
    score: 5,
    reason: "command_approval_prompt",
  },
];

const MEDIUM_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  {
    pattern: /\b(confirm|approve|allow|continue|proceed|select|choose)\b/iu,
    score: 1,
    reason: "action_keyword",
  },
  {
    pattern: /\?\s*$/u,
    score: 1,
    reason: "question_mark",
  },
  {
    pattern: /\b(?:always\s+allow|allow\s+for\s+this\s+session|cancel\s+this\s+tool\s+call)\b/iu,
    score: 1,
    reason: "tool_choice_keyword",
  },
];

const NUMBERED_CHOICE_LINE_PATTERN = /^(?:[>›*•-]\s*)?\d+\.\s+.+$/u;
const CONFIRM_CANCEL_FOOTER_PATTERN =
  /\b(?:press\s+enter\s+to\s+confirm|enter\s+to\s+submit)\b.*\besc\s+to\s+cancel\b/iu;
const SUBMIT_CANCEL_FOOTER_PATTERN = /\benter\s+to\s+submit\b.*\besc\s+to\s+cancel\b/iu;
const CONTINUE_FOOTER_PATTERN = /\b(?:press\s+enter\s+to\s+continue|hit\s+enter\s+to\s+continue)\b/iu;
const NUMBERED_HOTKEY_FOOTER_PATTERN =
  /\bpress\s+(?:(?:\d+\s*,\s*)+\s*(?:or\s+)?\d+\s*,?\s*)?(?:enter\b.*\besc|esc\b.*\benter|\d+\b.*\benter|\d+\b.*\besc).*\b(?:quit|continue|cancel|confirm|submit)\b/iu;
const POSITIVE_CHOICE_PATTERN = /\b(?:yes|allow|approve|proceed|continue)\b/iu;
const NEGATIVE_CHOICE_PATTERN = /\b(?:no|cancel|deny|reject)\b/iu;
const STICKY_CHOICE_PATTERN = /\bdon'?t\s+ask\s+again|always\s+allow|for\s+this\s+session\b/iu;
const SKIP_CHOICE_PATTERN = /\bskip\b/iu;
const LEADING_SELECTION_MARKER_PATTERN = /^(?:[>›*•-]\s*)(?=\d+\.\s)/u;
const ACTION_HINT_PATTERN =
  /\b(?:press|input|choose|choice|select|option|enter|esc(?:ape)?|accept|decline|confirm|cancel|continue|proceed|yes|no)\b|(?:\[[Yy](?:es)?\/[Nn](?:o)?\])|(?:\([Yy](?:es)?\/[Nn](?:o)?\))/u;

function normalizeLine(line: string): string {
  return line
    .replaceAll("\r", "")
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isNoiseLine(line: string): boolean {
  if (!line) {
    return true;
  }

  if (line.length > 260) {
    return true;
  }

  return (
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\b/u.test(line) ||
    /^at\s+.+\(.+\)$/u.test(line) ||
    /^diff --git\b/u.test(line) ||
    /^(---|\+\+\+|@@)\b/u.test(line) ||
    /^[~/.\w-]+:\d+:\d+/u.test(line) ||
    /^https?:\/\/\S+$/u.test(line)
  );
}

function scoreStrongLine(line: string): ScoreContribution[] {
  const contributions: ScoreContribution[] = [];

  for (const candidate of STRONG_PATTERNS) {
    if (candidate.pattern.test(line)) {
      contributions.push({
        score: candidate.score,
        reason: candidate.reason,
      });
    }
  }

  return contributions;
}

function scoreMediumLine(
  line: string,
  strategy: TerminalPromptScanStrategy,
): ScoreContribution[] {
  const contributions: ScoreContribution[] = [];

  for (const candidate of MEDIUM_PATTERNS) {
    if (candidate.pattern.test(line)) {
      contributions.push({
        score: candidate.score,
        reason: candidate.reason,
      });
    }
  }

  if (
    strategy === "balanced" &&
    /\b(input|reply|answer|decision|permission|approval)\b/iu.test(line)
  ) {
    contributions.push({
      score: 1,
      reason: "balanced_context_keyword",
    });
  }

  return contributions;
}

function isStrongReason(reason: string): boolean {
  return STRONG_PATTERNS.some((candidate) => candidate.reason === reason);
}

function collectCandidateLines(rawText: string, maxLines: number): string[] {
  const normalized = rawText
    .split("\n")
    .map(normalizeLine)
    .filter((line) => line.length > 0);

  return normalized.slice(-Math.max(1, maxLines));
}

function normalizeFingerprintLine(line: string): string {
  return normalizeLine(line)
    .replace(LEADING_SELECTION_MARKER_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildDetectionFingerprint(
  strategy: TerminalPromptScanStrategy,
  matchedLines: string[],
): string {
  const normalizedExcerpt = matchedLines
    .map(normalizeFingerprintLine)
    .join("\n");

  return createHash("sha1")
    .update(`${strategy}\n${normalizedExcerpt}`)
    .digest("hex");
}

function buildExcerptWithContext(
  candidateLines: string[],
  matchedLines: string[],
): string {
  if (matchedLines.length === 0) {
    return "";
  }

  const firstMatchedIndex = candidateLines.findIndex(
    (line) => line === matchedLines[0],
  );
  const lastMatchedIndex =
    matchedLines.length === 1
      ? firstMatchedIndex
      : candidateLines.findIndex(
          (line, index) =>
            index >= Math.max(0, firstMatchedIndex) &&
            line === matchedLines[matchedLines.length - 1],
        );

  if (firstMatchedIndex < 0 || lastMatchedIndex < 0) {
    return matchedLines.slice(-8).join("\n");
  }

  const excerptStart = Math.max(0, firstMatchedIndex - 2);
  const excerptEnd = Math.min(candidateLines.length, lastMatchedIndex + 1);
  return candidateLines.slice(excerptStart, excerptEnd).slice(-8).join("\n");
}

function findChoiceActionBlock(candidateLines: string[]): ChoiceActionBlock | null {
  for (let startIndex = candidateLines.length - 1; startIndex >= 0; startIndex -= 1) {
    const line = candidateLines[startIndex] ?? "";
    if (!NUMBERED_CHOICE_LINE_PATTERN.test(line)) {
      continue;
    }

    const choiceLines: string[] = [];
    let firstChoiceIndex = startIndex;
    while (firstChoiceIndex >= 0) {
      const currentLine = candidateLines[firstChoiceIndex] ?? "";
      if (!NUMBERED_CHOICE_LINE_PATTERN.test(currentLine)) {
        break;
      }
      choiceLines.unshift(currentLine);
      firstChoiceIndex -= 1;
    }
    firstChoiceIndex += 1;

    if (choiceLines.length < 2) {
      continue;
    }

    const lastChoiceIndex = firstChoiceIndex + choiceLines.length - 1;
    const headerLines = candidateLines.slice(
      Math.max(0, firstChoiceIndex - 5),
      firstChoiceIndex,
    );
    const tailLines = candidateLines.slice(
      lastChoiceIndex + 1,
      Math.min(candidateLines.length, lastChoiceIndex + 4),
    );
    const footerLine = tailLines[0] ?? null;
    const nearbyLines = [...headerLines, ...tailLines];
    const hasActionHint = nearbyLines.some((candidate) =>
      ACTION_HINT_PATTERN.test(candidate),
    );
    const hasChoiceSemantics =
      POSITIVE_CHOICE_PATTERN.test(choiceLines.join("\n")) ||
      NEGATIVE_CHOICE_PATTERN.test(choiceLines.join("\n")) ||
      STICKY_CHOICE_PATTERN.test(choiceLines.join("\n")) ||
      SKIP_CHOICE_PATTERN.test(choiceLines.join("\n"));

    if (!hasActionHint && !hasChoiceSemantics) {
      continue;
    }

    return {
      footerLine,
      choiceLines,
      headerLines,
      tailLines,
    };
  }

  return null;
}

function detectChoiceFooterSignals(
  candidateLines: string[],
  strategy: TerminalPromptScanStrategy,
): {
  score: number;
  reasons: string[];
  matchedLines: string[];
  promptActions: {
    numberedOptions: string[];
    hasEnter: boolean;
    hasEscape: boolean;
  };
} | null {
  const block = findChoiceActionBlock(candidateLines);
  if (!block) {
    return null;
  }

  const choiceText = block.choiceLines.join("\n");
  const contextLines = [
    ...block.headerLines,
    ...block.choiceLines,
    ...(block.footerLine ? [block.footerLine] : []),
    ...block.tailLines,
  ];
  const reasons = new Set<string>(["numbered_choice_group"]);
  const matchedLines = [
    ...block.choiceLines,
    ...(block.footerLine ? [block.footerLine] : []),
    ...block.tailLines,
  ];
  let score = strategy === "balanced" ? 5 : 6;

  const footerLine = block.footerLine ?? "";

  if (CONFIRM_CANCEL_FOOTER_PATTERN.test(footerLine)) {
    reasons.add("confirm_cancel_footer");
    score += strategy === "balanced" ? 2 : 3;
  }

  if (CONTINUE_FOOTER_PATTERN.test(footerLine)) {
    reasons.add("continue_footer");
    score += strategy === "balanced" ? 2 : 3;
  }

  if (NUMBERED_HOTKEY_FOOTER_PATTERN.test(footerLine)) {
    reasons.add("numbered_hotkey_footer");
    score += strategy === "balanced" ? 2 : 3;
  }

  if (SUBMIT_CANCEL_FOOTER_PATTERN.test(footerLine)) {
    reasons.add("submit_cancel_hint");
  }

  if (/press\s+enter\s+to\s+confirm\b/iu.test(footerLine)) {
    reasons.add("confirm_cancel_hint");
  }

  if (contextLines.some((line) => ACTION_HINT_PATTERN.test(line))) {
    reasons.add("action_hint_present");
    score += 2;
  }

  if (POSITIVE_CHOICE_PATTERN.test(choiceText)) {
    reasons.add("positive_choice_present");
    score += 2;
  }

  if (NEGATIVE_CHOICE_PATTERN.test(choiceText)) {
    reasons.add("negative_choice_present");
    score += 2;
  }

  if (STICKY_CHOICE_PATTERN.test(choiceText)) {
    reasons.add("sticky_choice_present");
    score += 2;
  }

  if (SKIP_CHOICE_PATTERN.test(choiceText)) {
    reasons.add("skip_choice_present");
    score += 2;
  }

  if (reasons.has("positive_choice_present") && reasons.has("negative_choice_present")) {
    reasons.add("yes_no_choice_group");
    reasons.add("approval_choice_group");
    score += 3;
  }

  if (reasons.has("positive_choice_present") && reasons.has("skip_choice_present")) {
    reasons.add("choice_update_group");
    score += 2;
  }

  if (
    /^(?:[>›*•-]\s*)?(?:\d+\.\s+)?yes,\s+proceed\b/imu.test(choiceText) &&
    reasons.has("sticky_choice_present")
  ) {
    reasons.add("proceed_choice_group");
  }

  for (const line of contextLines) {
    for (const contribution of scoreStrongLine(line)) {
      reasons.add(contribution.reason);
      score += contribution.score;
    }
  }

  return {
    score,
    reasons: Array.from(reasons),
    matchedLines,
    promptActions: {
      numberedOptions: block.choiceLines
        .map((line) => line.match(/^(?:[>›*•-]\s*)?(\d+)\.\s+/u)?.[1] ?? null)
        .filter((value): value is string => Boolean(value)),
      hasEnter:
        contextLines.some((line) => /\benter\b/iu.test(line)),
      hasEscape:
        contextLines.some((line) => /\besc(?:ape)?\b/iu.test(line)),
    },
  };
}

export function detectTerminalInteractivePrompt(
  rawText: string,
  options: DetectionOptions = {},
): TerminalPromptDetection | null {
  const strategy = options.strategy ?? "strict";
  const minScore = options.minScore ?? (strategy === "balanced" ? 4 : 5);
  const candidateLines = collectCandidateLines(rawText, options.maxLines ?? 40);

  if (candidateLines.length === 0) {
    return null;
  }

  const choiceFooterDetection = detectChoiceFooterSignals(candidateLines, strategy);
  if (choiceFooterDetection && choiceFooterDetection.score >= minScore) {
    const matchedLines = choiceFooterDetection.matchedLines.slice(-6);
    const excerpt = buildExcerptWithContext(candidateLines, matchedLines);
    const fingerprint = buildDetectionFingerprint(
      strategy,
      matchedLines,
    );

    return {
      score: choiceFooterDetection.score,
      fingerprint,
      excerpt,
      matchedLines,
      reasons: choiceFooterDetection.reasons,
      promptActions: choiceFooterDetection.promptActions,
    };
  }

  const scoredLines: Array<{
    line: string;
    contributions: ScoreContribution[];
  }> = [];

  let score = 0;
  const reasons = new Set<string>();

  for (const line of candidateLines) {
    if (isNoiseLine(line)) {
      continue;
    }

    const contributions = scoreStrongLine(line);
    if (contributions.length === 0) {
      continue;
    }

    scoredLines.push({ line, contributions });
    for (const contribution of contributions) {
      score += contribution.score;
      reasons.add(contribution.reason);
    }
  }

  const optionLineCount = candidateLines.filter((line) =>
    /^(\d+\.\s+|[-*]\s+|\[[ xX]\]\s+)/u.test(line),
  ).length;

  if (scoredLines.length > 0 && optionLineCount >= 2) {
    score += 3;
    reasons.add("multiple_options");
  }

  const hasStrongReason = Array.from(reasons).some(isStrongReason);
  const hasGroupedReason = reasons.has("multiple_options");
  const hasOnlyQuestionMarkReason =
    reasons.size === 1 && reasons.has("question_mark");

  if (strategy === "strict") {
    if (hasOnlyQuestionMarkReason) {
      return null;
    }

    if (!hasStrongReason) {
      if (!hasGroupedReason) {
        return null;
      }
    }
  }

  const canUseMediumSignals =
    strategy === "balanced" ||
    hasStrongReason ||
    hasGroupedReason ||
    reasons.has("multiple_options");

  if (canUseMediumSignals) {
    for (const line of candidateLines) {
      if (isNoiseLine(line)) {
        continue;
      }

      const contributions = scoreMediumLine(line, strategy);
      if (contributions.length === 0) {
        continue;
      }

      const existing = scoredLines.find((entry) => entry.line === line);
      if (existing) {
        existing.contributions.push(...contributions);
      } else {
        scoredLines.push({ line, contributions: [...contributions] });
      }

      for (const contribution of contributions) {
        score += contribution.score;
        reasons.add(contribution.reason);
      }
    }
  }

  if (score < minScore || scoredLines.length === 0) {
    return null;
  }

  const matchedLines = scoredLines
    .map((entry) => entry.line)
    .slice(-6);
  const excerpt = buildExcerptWithContext(candidateLines, matchedLines);
  const fingerprint = buildDetectionFingerprint(strategy, matchedLines);

  return {
    score,
    fingerprint,
    excerpt,
    matchedLines,
    reasons: Array.from(reasons),
  };
}
