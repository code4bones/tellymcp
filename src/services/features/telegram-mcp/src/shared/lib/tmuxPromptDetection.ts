import { createHash } from "node:crypto";

export type TmuxPromptScanStrategy = "strict" | "balanced";

export type TmuxPromptDetection = {
  score: number;
  fingerprint: string;
  excerpt: string;
  matchedLines: string[];
  reasons: string[];
};

type DetectionOptions = {
  strategy?: TmuxPromptScanStrategy;
  minScore?: number;
  maxLines?: number;
};

type ScoreContribution = {
  score: number;
  reason: string;
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
];

const MEDIUM_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  {
    pattern: /\b(confirm|approve|allow|continue|proceed|select|choose)\b/iu,
    score: 2,
    reason: "action_keyword",
  },
  {
    pattern: /\?\s*$/u,
    score: 2,
    reason: "question_mark",
  },
];

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

function scoreLine(line: string, strategy: TmuxPromptScanStrategy): ScoreContribution[] {
  const contributions: ScoreContribution[] = [];

  for (const candidate of STRONG_PATTERNS) {
    if (candidate.pattern.test(line)) {
      contributions.push({
        score: candidate.score,
        reason: candidate.reason,
      });
    }
  }

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

function collectCandidateLines(rawText: string, maxLines: number): string[] {
  const normalized = rawText
    .split("\n")
    .map(normalizeLine)
    .filter((line) => line.length > 0);

  return normalized.slice(-Math.max(1, maxLines));
}

export function detectTmuxInteractivePrompt(
  rawText: string,
  options: DetectionOptions = {},
): TmuxPromptDetection | null {
  const strategy = options.strategy ?? "strict";
  const minScore = options.minScore ?? (strategy === "balanced" ? 4 : 5);
  const candidateLines = collectCandidateLines(rawText, options.maxLines ?? 40);

  if (candidateLines.length === 0) {
    return null;
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

    const contributions = scoreLine(line, strategy);
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

  if (score < minScore || scoredLines.length === 0) {
    return null;
  }

  const matchedLines = scoredLines
    .map((entry) => entry.line)
    .slice(-6);
  const excerpt = matchedLines.join("\n");
  const fingerprint = createHash("sha1")
    .update(`${strategy}\n${excerpt}`)
    .digest("hex");

  return {
    score,
    fingerprint,
    excerpt,
    matchedLines,
    reasons: Array.from(reasons),
  };
}
