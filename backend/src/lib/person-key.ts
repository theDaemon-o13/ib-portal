// «Тот же человек» среди ответственных лиц документа (релиз 1.6.7): совпадают ФИО и подразделение или должность
// без учёта регистра, лишних пробелов и различия «ё» и «е» (1.13.5). Однофамильцы с другой должностью — разные люди (решение владельца 04.11.2026).
// Та же нормализация — во frontend (pages/documents/logic.ts, personKey): метка «уже добавлен(а)» в списке выбора.

/** Текст для сравнения: пробелы схлопнуты, края обрезаны, регистр — нижний (по-русски), «ё» = «е» (1.13.5). */
export function normalizePersonText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

/** Ключ человека: ФИО + подразделение или должность. */
export function personKey(fullName: string, position: string): string {
  return `${normalizePersonText(fullName)}\u0000${normalizePersonText(position)}`;
}
