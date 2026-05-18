import { createInstance } from "i18next";

import { enCommon, enMenu } from "./resources/en";
import { ruCommon, ruMenu } from "./resources/ru";

export type SupportedLocale = "en" | "ru";

const instance = createInstance();

void instance.init({
  lng: "en",
  fallbackLng: "en",
  ns: ["common", "menu"],
  defaultNS: "common",
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  returnEmptyString: false,
  resources: {
    en: {
      common: enCommon,
      menu: enMenu,
    },
    ru: {
      common: ruCommon,
      menu: ruMenu,
    },
  },
});

export function normalizeLocale(
  input: string | null | undefined,
): SupportedLocale {
  const normalized = input?.trim().toLowerCase() ?? "";
  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }

  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }

  return "en";
}

export function translate(
  locale: string | null | undefined,
  key: string,
  options?: Record<string, unknown>,
): string {
  return instance.t(key, {
    lng: normalizeLocale(locale),
    ...(options ?? {}),
  });
}
