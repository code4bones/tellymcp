import type { PartnerNoteKind } from "../../../entities/collaboration/model/types";
import { getCollabRouteSemantics } from "./collabSemantics";

export function buildProjectMemberDetailText(input: {
  projectName: string;
  sourceLabel: string;
  targetLabel: string;
}): string {
  const askSemantics = getCollabRouteSemantics({
    kind: "question",
    sourceLabel: input.sourceLabel,
    targetLabel: input.targetLabel,
  });
  const shareSemantics = getCollabRouteSemantics({
    kind: "share",
    sourceLabel: input.sourceLabel,
    targetLabel: input.targetLabel,
  });

  return [
    "🤝 Сессия проекта",
    "",
    `Проект: ${input.projectName}`,
    `Текущая сессия: ${input.sourceLabel}`,
    `Исполнитель: ${input.targetLabel}`,
    `Ask: ${askSemantics.route}`,
    `Share: ${shareSemantics.route}`,
    "Live: по подтверждению выбранной сессии",
    "",
    "Выбери тип действия для этой пары сессий.",
  ].join("\n");
}

export function buildPartnerNotePromptText(input: {
  kind: PartnerNoteKind;
  sourceLabel: string;
  targetLabel: string;
  isProjectTarget: boolean;
}): { kindLabel: string; text: string } {
  const semantics = getCollabRouteSemantics({
    kind: input.kind,
    sourceLabel: input.sourceLabel,
    targetLabel: input.targetLabel,
  });
  const executesOnTarget = semantics.executesOnTarget;
  const kindLabel =
    input.kind === "question"
      ? input.isProjectTarget
        ? "Вопрос участнику"
        : "Вопрос напарнику"
      : input.kind === "reply"
        ? input.isProjectTarget
          ? "Ответ участнику"
          : "Ответ напарнику"
        : input.kind === "handoff"
          ? input.isProjectTarget
            ? "Передача участнику"
            : "Передача напарнику"
          : input.isProjectTarget
            ? "Поделиться с участником"
            : "Поделиться обновлением";

  return {
    kindLabel,
    text: [
      `🤝 ${kindLabel}`,
      "",
      `Текущая сессия: ${input.sourceLabel}`,
      executesOnTarget
        ? input.isProjectTarget
          ? `Исполнитель: ${input.targetLabel}`
          : `Напарник: ${input.targetLabel}`
        : input.isProjectTarget
          ? `Получатель: ${input.targetLabel}`
          : `Напарник: ${input.targetLabel}`,
      executesOnTarget
        ? `Ожидаемый ответ: ${semantics.expectedReplyRoute}`
        : `Маршрут отправки: ${semantics.sendRoute}`,
      "",
      executesOnTarget
        ? "Отправь следующим сообщением задачу для выбранной сессии."
        : "Отправь следующим сообщением, чем текущая сессия должна поделиться.",
      executesOnTarget
        ? input.isProjectTarget
          ? "Агент выбранной сессии получит задачу и сможет отправить результат обратно в текущую сессию проекта."
          : "Агент напарника получит задачу и сможет отправить результат обратно в текущую сессию."
        : input.isProjectTarget
          ? "Агент текущей сессии получит задачу и сам отправит результат в выбранную сессию проекта."
          : "Агент текущей сессии получит задачу и сам отправит результат напарнику.",
      "Формат:",
      "1. Первая строка = короткое summary",
      "2. Пустая строка опциональна",
      "3. Остальной текст = основное сообщение",
      "",
      "Команды вроде /menu или /help отменят этот режим.",
    ].join("\n"),
  };
}
