import { describe, expect, it } from "vitest";

import {
  normalizeLocale,
  translate,
} from "../src/services/features/telegram-mcp/src/shared/i18n";

describe("i18n", () => {
  it("normalizes supported locales with fallback to english", () => {
    expect(normalizeLocale("ru")).toBe("ru");
    expect(normalizeLocale("ru-RU")).toBe("ru");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("de-DE")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
  });

  it("translates keys with locale fallback", () => {
    expect(translate("ru", "menu:main.buttons.storage")).toBe("📦 Storage");
    expect(translate("en", "menu:local.buttons.partner")).toBe("🤝 Partner");
    expect(translate("de", "common:menu.refresh")).toBe("🔄 Refresh");
  });
});
