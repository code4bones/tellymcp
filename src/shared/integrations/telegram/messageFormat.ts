import type {
  HumanTransportNotification,
  HumanTransportRequest,
} from "../../api/transport/contract.js";

type TelegramMessageLimits = {
  maxQuestionChars: number;
  maxContextChars: number;
  maxMessageChars: number;
};

function renderList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function renderFiles(files: string[]): string {
  return files.map((item) => `- ${item}`).join("\n");
}

function compactMetaLine(input: {
  task?: string;
  riskLevel?: string;
}): string | null {
  const parts: string[] = [];

  if (input.task) {
    parts.push(`Task: ${input.task}`);
  }
  if (input.riskLevel && input.riskLevel !== "low") {
    parts.push(`Risk: ${input.riskLevel}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

export function formatTelegramMessage(
  input: HumanTransportRequest,
  _limits: TelegramMessageLimits,
): string {
  const question = input.question;
  const context = input.context;
  const metaLine = compactMetaLine({
    ...(input.task ? { task: input.task } : {}),
    ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
  });

  const sections = [
    input.sessionLabel ?? input.sessionId,
    ...(metaLine ? ["", metaLine] : []),
    "",
    question,
    ...(context ? ["", context] : []),
    ...(input.affectedFiles?.length
      ? ["", "Files:", renderFiles(input.affectedFiles)]
      : []),
    ...(input.options?.length
      ? ["", "Options:", renderList(input.options)]
      : []),
    ...(input.recommendedOption
      ? ["", `Recommended: ${input.recommendedOption}`]
      : []),
    ...(input.fallbackIfTimeout
      ? ["", `Fallback if no answer: ${input.fallbackIfTimeout}`]
      : []),
    "",
    "Reply to this message.",
  ];

  return sections.join("\n");
}

export function formatTelegramNotification(
  input: HumanTransportNotification,
  _limits: TelegramMessageLimits,
): string {
  const context = input.context;
  const message = input.message;
  return [
    input.sessionLabel ?? input.sessionId,
    "",
    message,
    ...(context ? ["", context] : []),
  ].join("\n");
}
