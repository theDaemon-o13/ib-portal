// Обёртка редактора писем (1.9.0): ленивая загрузка TipTap, вкладки RU и TJ с темой и текстом, размер письма.
// Сам редактор (LetterEditor.tsx) — отдельный чанк: его грузят только экраны писем, шаблонов и «Подписи ИБ».
import { LANGUAGES, LETTER_LANG_TO_CODE } from '../../../api/generated/languages';
import { lazy, Suspense, useState } from 'react';
import { kb, letterBytes, sizeWarning } from './paste';

export const LetterEditor = lazy(() => import('./LetterEditor'));

export interface Texts {
  subjectRu: string;
  subjectTj: string;
  htmlRu: string;
  htmlTj: string;
  /** Шапка письма (1.12.0): «Заголовок» и «Метка» языка, «Тема общая» RU+TJ; пусто — по умолчанию. */
  headerRu: string;
  headerTj: string;
  labelRu: string;
  labelTj: string;
  subjectBoth: string;
}
export const HEAD_KEYS = ['headerRu', 'headerTj', 'labelRu', 'labelTj', 'subjectBoth'] as const;
export const EMPTY_TEXTS: Texts = { subjectRu: '', subjectTj: '', htmlRu: '', htmlTj: '', headerRu: '', headerTj: '', labelRu: '', labelTj: '', subjectBoth: '' };
export const sameTexts = (a: Texts, b: Texts) =>
  a.subjectRu === b.subjectRu && a.subjectTj === b.subjectTj && a.htmlRu === b.htmlRu && a.htmlTj === b.htmlTj && HEAD_KEYS.every((k) => a[k] === b[k]);
/** Тексты из ответа API: у прежних писем и шаблонов поля шапки пустые. */
export const textsOf = (c: Partial<Texts> & Pick<Texts, 'subjectRu' | 'subjectTj' | 'htmlRu' | 'htmlTj'>): Texts => ({ ...EMPTY_TEXTS, ...c });
export interface Limits { maxImageKb: number; maxLetterKb: number; warnLetterKb: number }

export function EditorFallback() {
  return <div className="aw-editor loading" role="status">Загружаем редактор…</div>;
}

/** Языки письма: ключи ru / tj (база и API писем, 1.9.0), названия и метки — из общего списка языков (1.13.7). */
const LANGS = (['ru', 'tj'] as const).map((key) => {
  const l = LANGUAGES.find((x) => x.code === LETTER_LANG_TO_CODE[key]);
  if (!l) throw new Error(`Нет языка ${key} в общем списке`);
  return { key, label: l.name, short: l.short };
});

/** Пометка заполненности языка на вкладке: тема и текст — «●», половина — «◐», ничего — пусто. */
function fill(subject: string, html: string): '' | '◐' | '●' {
  const s = subject.trim().length > 0;
  const t = html.replace(/<[^>]+>/g, '').trim().length > 0 || /<img\s/i.test(html);
  return s && t ? '●' : s || t ? '◐' : '';
}

export function BilingualFields(p: {
  value: Texts;
  resetKey: string;
  onChange: (t: Texts) => void;
  signature: { htmlRu: string; htmlTj: string };
  limits: Limits;
  readOnly?: boolean;
  onWarning: (text: string) => void;
  /** Подсказка под темой: в шаблоне — про переменные. */
  subjectHint?: string;
  /** Метки по умолчанию из «Оформления писем» — подсказка в пустом поле. */
  defaultLabels?: { ru: string; tj: string };
}) {
  const [lang, setLang] = useState<'ru' | 'tj'>('ru');
  const bytes = letterBytes(p.value.htmlRu, p.value.htmlTj);
  const size = sizeWarning(bytes, p.limits);
  const subjectKey = lang === 'ru' ? 'subjectRu' : 'subjectTj';
  const headerKey = lang === 'ru' ? 'headerRu' : 'headerTj';
  const labelKey = lang === 'ru' ? 'labelRu' : 'labelTj';
  const L = lang === 'ru' ? 'RU' : 'TJ';
  return (
    <div className="aw-bilingual">
      <div className="row aw-langs" role="tablist" aria-label="Язык письма">
        {LANGS.map((l) => {
          const mark = fill(l.key === 'ru' ? p.value.subjectRu : p.value.subjectTj, l.key === 'ru' ? p.value.htmlRu : p.value.htmlTj);
          return (
            <button key={l.key} type="button" role="tab" aria-selected={lang === l.key} className={`aw-lang${lang === l.key ? ' on' : ''}`}
              onClick={() => setLang(l.key)} title={l.label}>
              {l.short}{mark && <span className="aw-fill" aria-label={mark === '●' ? 'заполнено' : 'заполнено частично'}>{mark}</span>}
            </button>
          );
        })}
        <span className="grow" />
        <span className={`aw-size ${size.level}`} data-testid="letter-size" title="HTML обоих языков вместе с изображениями">
          {kb(bytes)} КБ из {p.limits.maxLetterKb}
        </span>
      </div>
      {size.text && <div className={`note ${size.level === 'over' ? 'conflict' : 'aw-warn'}`} role="status">{size.text}</div>}
      <label className="aw-subject">Тема ({lang === 'ru' ? 'RU' : 'TJ'})
        <input className="inp" maxLength={300} value={p.value[subjectKey]} disabled={p.readOnly}
          onChange={(e) => p.onChange({ ...p.value, [subjectKey]: e.target.value })} />
        {p.subjectHint && <span className="hint">{p.subjectHint}</span>}
      </label>
      <div className="aw-head-fields">
        <label>Заголовок в шапке ({L})
          <input className="inp" maxLength={300} value={p.value[headerKey]} disabled={p.readOnly} placeholder={p.value[subjectKey] || 'По умолчанию — тема'}
            onChange={(e) => p.onChange({ ...p.value, [headerKey]: e.target.value })} />
        </label>
        <label>Метка ({L})
          <input className="inp" maxLength={300} value={p.value[labelKey]} disabled={p.readOnly} placeholder={p.defaultLabels?.[lang] ?? 'По умолчанию — из «Оформления писем»'}
            onChange={(e) => p.onChange({ ...p.value, [labelKey]: e.target.value })} />
        </label>
      </div>
      <label className="aw-subject">Тема общая (RU+TJ)
        <input className="inp" maxLength={610} value={p.value.subjectBoth} disabled={p.readOnly}
          placeholder={[p.value.subjectRu.trim(), p.value.subjectTj.trim()].filter(Boolean).join(' | ') || 'Тема RU | Тема TJ'}
          onChange={(e) => p.onChange({ ...p.value, subjectBoth: e.target.value })} />
        <span className="hint">Тема письма, когда отправляются оба языка. Пусто — «тема RU | тема TJ».</span>
      </label>
      {/* Оба редактора живут одновременно (скрыт неактивный): история правок и курсор не теряются при переключении. */}
      {LANGS.map((l) => (
        <div key={l.key} hidden={lang !== l.key}>
          <Suspense fallback={<EditorFallback />}>
            <LetterEditor
              label={`Текст (${l.short})`}
              value={l.key === 'ru' ? p.value.htmlRu : p.value.htmlTj}
              resetKey={p.resetKey}
              onChange={(html) => p.onChange({ ...p.value, [l.key === 'ru' ? 'htmlRu' : 'htmlTj']: html })}
              signatureHtml={l.key === 'ru' ? p.signature.htmlRu : p.signature.htmlTj}
              maxImageKb={p.limits.maxImageKb}
              readOnly={p.readOnly}
              onWarning={p.onWarning}
            />
          </Suspense>
        </div>
      ))}
    </div>
  );
}
