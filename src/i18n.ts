import { englishMessages, messages } from './messages.js';

const translatedLocales = { en: 0, de: 1, fr: 2, es: 3 } as const;
export type Locale = 'ru' | keyof typeof translatedLocales;
type LegacyMessage = keyof typeof messages;
type EnglishMessage = keyof typeof englishMessages;

let current: Locale = 'ru';

export function resolveLocale(value: unknown): Locale {
  return typeof value === 'string' && Object.hasOwn(translatedLocales, value) ? value as Locale : 'ru';
}

export function setLocale(value: unknown) {
  current = resolveLocale(value);
}

export function locale() {
  return current;
}

export function t(message: LegacyMessage | EnglishMessage, values: Record<string, string | number> = {}) {
  const text = Object.hasOwn(englishMessages, message) ? englishMessages[message as EnglishMessage][current]
    : current === 'ru' ? message : messages[message as LegacyMessage][translatedLocales[current]];
  return text.replace(/\{(\w+)\}/g, (placeholder: string, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

export function localize(root: ParentNode) {
  function translate(source: string) {
    return Object.hasOwn(messages, source) || Object.hasOwn(englishMessages, source)
      ? t(source as LegacyMessage | EnglishMessage) : source;
  }

  root.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = translate(element.textContent ?? '');
  });
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    root.querySelectorAll('[data-i18n-' + attribute + ']').forEach((element) => {
      element.setAttribute(attribute, translate(element.getAttribute(attribute) ?? ''));
    });
  }
}
