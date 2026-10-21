import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import pt from "./locales/pt.json";

export const LANGUAGES = ["en", "pt"] as const;

export function resolveLanguage(preference: string | null): string {
  if (preference) return preference;
  return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, pt: { translation: pt } },
  lng: resolveLanguage(null),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
