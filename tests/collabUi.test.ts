import { describe, expect, it } from "vitest";

import {
  buildPartnerNotePromptText,
  buildProjectMemberDetailText,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/collabUi";

describe("collab UI text", () => {
  it("renders project member detail text with Ask and Share routes", () => {
    const text = buildProjectMemberDetailText({
      projectName: "Project One",
      sourceLabel: "leftDev",
      targetLabel: "backend",
    });

    expect(text).toContain("Проект: Project One");
    expect(text).toContain("Текущая сессия: leftDev");
    expect(text).toContain("Исполнитель: backend");
    expect(text).toContain("Ask: backend -> leftDev");
    expect(text).toContain("Share: leftDev -> backend");
    expect(text).toContain("Live: по подтверждению выбранной сессии");
  });

  it("renders Ask prompt as target-executed for project members", () => {
    const prompt = buildPartnerNotePromptText({
      kind: "question",
      sourceLabel: "leftDev",
      targetLabel: "backend",
      isProjectTarget: true,
    });

    expect(prompt.kindLabel).toBe("Вопрос участнику");
    expect(prompt.text).toContain("Исполнитель: backend");
    expect(prompt.text).toContain("Ожидаемый ответ: backend -> leftDev");
    expect(prompt.text).toContain(
      "Отправь следующим сообщением задачу для выбранной сессии.",
    );
  });

  it("renders Share prompt as current-executed for project members", () => {
    const prompt = buildPartnerNotePromptText({
      kind: "share",
      sourceLabel: "leftDev",
      targetLabel: "backend",
      isProjectTarget: true,
    });

    expect(prompt.kindLabel).toBe("Поделиться с участником");
    expect(prompt.text).toContain("Получатель: backend");
    expect(prompt.text).toContain("Маршрут отправки: leftDev -> backend");
    expect(prompt.text).toContain(
      "Отправь следующим сообщением, чем текущая сессия должна поделиться.",
    );
  });
});
