import { messages } from './messages.js';

const translatedLocales = { en: 0, de: 1, fr: 2, es: 3 } as const;
export type Locale = 'ru' | keyof typeof translatedLocales;
type Message = keyof typeof messages;

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

export function t(message: Message, values: Record<string, string | number> = {}) {
  const text = current === 'ru' ? message : messages[message][translatedLocales[current]];
  return text.replace(/\{(\w+)\}/g, (placeholder: string, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

export function localize(root: ParentNode) {
  function translate(source: string) {
    return Object.hasOwn(messages, source) ? t(source as Message) : source;
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
