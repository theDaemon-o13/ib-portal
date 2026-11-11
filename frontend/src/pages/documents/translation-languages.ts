// Язык перевода — только из списка (1.13.7). Список приходит из backend сгенерированным файлом; старые строки,
// где язык введён текстом, backend сопоставляет по псевдонимам и отдаёт code (не сопоставлена — null).
import { LANGUAGES, type LanguageCode } from '../../api/generated/languages';

export interface LanguageOption {
  code: LanguageCode;
  name: string;
  /** Язык уже есть в документе: текст той строки («Таджикский», «TJ»); null — свободен. */
  takenBy: string | null;
}

/** Варианты списка: занятые — недоступны («уже добавлен»). exceptId — строка, которую правят: её язык не занят. */
export function languageOptions(rows: readonly { id: string; language: string; code: LanguageCode | null }[], exceptId?: string): LanguageOption[] {
  return LANGUAGES.map((l) => {
    const row = rows.find((r) => r.id !== exceptId && r.code === l.code);
    return { code: l.code, name: l.name, takenBy: row ? row.language : null };
  });
}

/** Подпись варианта: «Таджикский — уже добавлен», у старой строки — «… (TJ)». */
export function optionLabel(o: LanguageOption): string {
  if (o.takenBy === null) return o.name;
  return `${o.name} — уже добавлен${o.takenBy !== o.name ? ` («${o.takenBy}»)` : ''}`;
}

/**
 * Что выбрано в списке при открытии правки: только если текст строки — ровно название из списка. Старая строка
 * («таджикский», «TJ») открывается без выбора: язык не переписывается, пока его не выберут заново.
 */
export function presetCode(t: { language: string; code: LanguageCode | null }): LanguageCode | '' {
  const l = LANGUAGES.find((x) => x.code === t.code);
  return l && l.name === t.language ? l.code : '';
}
