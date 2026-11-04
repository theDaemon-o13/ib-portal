// Ключ заголовка для цепочек задач (релиз 1.7.0, ADR-0035): «RE: FW: Тестовая тема» и «тестовая тема» — один ключ.
// Ключ сравнивается точно (подсказка «та же тема», поиск среди старых задач) и по словам (подсказка «похожая»).
// Снятие почтовых префиксов — общее с разбором письма (mail-parse.ts): там оно строит название задачи.

/**
 * Префиксы с двоеточием: «RE:», «Re[2]:», «FW:», «Fwd:», «Отв:», «Ответ:», «ВО:», «Пересл.:», немецкие и скандинавские
 * «AW:», «WG:», «SV:», «VS:», «TR:», «RV:». Двоеточие — обычное или широкое (до NFKC).
 */
const WITH_COLON = /^(?:re(?:\s*[[(]\d+[\])])?|fwd?|aw|wg|sv|vs|tr|rv|отв|ответ|во|пересл|переслать|переадр)\.?\s*[:：]\s*/iu;
/**
 * Без двоеточия — только латинские «RE», «Re[2]», «FW», «Fwd» и только если дальше есть текст: «Во вторник»,
 * «Ответственный за доступ» и «TR-069» не режутся.
 */
const BARE = /^(?:re(?:\s*[[(]\d+[\])])?|fwd?)\s+(?=\S)/iu;
/** Метки внешней почты: «[EXT]», «[External]», «(EXT)», «[Внешнее]». */
const TAG = /^[[(](?:ext|external|внешн(?:ее|ий|яя)|внешнее письмо)[\])]\s*/iu;

/** Снять повторяющиеся почтовые префиксы в начале, в любом порядке. Регистр и символы остатка не меняются. */
export function stripReplyPrefixes(title: string): string {
  let s = title.replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = s.replace(TAG, '').replace(WITH_COLON, '').replace(BARE, '').replace(/^[\s\-–—:;,.]+/u, '');
    if (next === s) return s;
    s = next;
  }
}

/** Пунктуация и символы по краям ключа. */
const EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

/**
 * Ключ заголовка: NFKC, нижний регистр, «ё» → «е», пробелы схлопнуты, префиксы сняты, пунктуация по краям обрезана.
 * Пустой остаток — null: ключа нет, подсказки нет.
 */
export function titleKey(title: string): string | null {
  const base = title.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const key = stripReplyPrefixes(base).replace(EDGE, '').replace(/\s+/g, ' ');
  return key || null;
}

/** Слова ключа для похожести: слова из одной-двух букв (предлоги «к», «в», «на») не учитываются (решение владельца). */
export function keyWords(key: string): Set<string> {
  return new Set(key.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
}

export interface SimilarityRule {
  /** Коэффициент Жаккара по словам, не меньше. */
  minJaccard: number;
  /** Общих слов не меньше. */
  minCommonWords: number;
}

/** Похожи ли ключи: доля общих слов (Жаккар) и число общих слов не ниже порога. Одинаковые ключи — тоже похожи. */
export function similarKeys(a: string, b: string, rule: SimilarityRule): boolean {
  if (a === b) return true;
  const wa = keyWords(a);
  const wb = keyWords(b);
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const union = wa.size + wb.size - common;
  return union > 0 && common >= rule.minCommonWords && common / union >= rule.minJaccard;
}

/**
 * Слово для предварительного отбора задач в SQL (ILIKE): самое длинное слово ключа. «е» в нём заменяется на «_»
 * (любой символ): в заголовке может быть «ё». Точное сравнение ключей — потом, в приложении.
 */
export function prefilterPattern(key: string): string {
  const words = [...keyWords(key)];
  const longest = words.sort((x, y) => y.length - x.length || x.localeCompare(y))[0] ?? key;
  return `%${longest.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/е/g, '_')}%`;
}
