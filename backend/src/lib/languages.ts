// Языки портала (1.13.7) — единственный список. Перевод документа (этап 23) выбирает язык из него; учебные письма
// берут отсюда названия и Content-Language. Frontend получает тот же список сгенерированным файлом
// frontend/src/api/generated/languages.ts (npm run openapi:export; тест languages.test.ts сверяет файл).
//
// Коды — ISO 639-1 (таджикский — tg). Учебные письма с 1.9.0 хранят у себя ключ tj (база, API, «Рассылки») —
// он не меняется, переводится псевдонимом LETTER_LANG_TO_CODE.

export const LANGUAGES = [
  { code: 'ru', name: 'Русский', short: 'RU' },
  { code: 'tg', name: 'Таджикский', short: 'TJ' },
  { code: 'en', name: 'Английский', short: 'EN' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];

export function languageByCode(code: LanguageCode): Language {
  const l = LANGUAGES.find((x) => x.code === code);
  if (!l) throw new Error(`Неизвестный код языка: ${code}`);
  return l;
}

/**
 * Как старые строки, где язык введён текстом (до 1.13.7), сопоставляются со списком — только при показе и проверке
 * дубля, в базу ничего не пишется (решение владельца 10.11.2026). Название из списка тоже здесь.
 */
const ALIASES: Record<LanguageCode, readonly string[]> = {
  ru: ['русский', 'russian', 'ru', 'rus', 'рус'],
  tg: ['таджикский', 'tj', 'tg', 'тоҷикӣ', 'tajik'],
  en: ['английский', 'en', 'eng', 'english'],
};

/** Нормализация текста языка: регистр, пробелы по краям и внутри, «ё» = «е». */
export const normalizeLanguageText = (v: string) => v.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

const BY_TEXT = new Map<string, LanguageCode>(
  (Object.entries(ALIASES) as [LanguageCode, readonly string[]][]).flatMap(([code, list]) =>
    [...list, languageByCode(code).name].map((t) => [normalizeLanguageText(t), code] as const)),
);

/** Код языка по тексту строки перевода; не сопоставляется — null (показывается как есть). */
export function languageCodeOf(text: string): LanguageCode | null {
  return BY_TEXT.get(normalizeLanguageText(text)) ?? null;
}

/** Ключ языка учебного письма (ru / tj, 1.9.0) → код списка. */
export const LETTER_LANG_TO_CODE = { ru: 'ru', tj: 'tg' } as const satisfies Record<string, LanguageCode>;

/** Текст файла frontend/src/api/generated/languages.ts — из этого же списка. */
export function frontendLanguagesModule(): string {
  const rows = LANGUAGES.map((l) => `  { code: '${l.code}', name: '${l.name}', short: '${l.short}' },`).join('\n');
  return `// Сгенерировано из backend/src/lib/languages.ts (npm run openapi:export). Вручную не править.
export const LANGUAGES = [
${rows}
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type Language = (typeof LANGUAGES)[number];

/** Ключ языка учебного письма (ru / tj) → код списка. */
export const LETTER_LANG_TO_CODE = { ${Object.entries(LETTER_LANG_TO_CODE).map(([k, v]) => `${k}: '${v}'`).join(', ')} } as const;
`;
}
