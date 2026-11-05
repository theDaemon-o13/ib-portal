// Экспорт учебного письма (1.9.0; docs/specs/awareness.md, раздел 16): «Скопировать с оформлением» (text/html и
// text/plain в буфер), файл .eml, печать в PDF. Язык — только заполненные (exportLangs), версия — любая, по умолчанию
// последняя (у отправленного — версия sent). Каждый экспорт пишется в журнал backend; предпросмотр — без запроса.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { awarenessApi, awarenessKeys, type ExportLang, type Letter } from '../../api/awareness';
import { useToast } from '../../components/Toast';
import { LetterHtml } from './LetterVersions';

const LANG_NAME: Record<ExportLang, string> = { ru: 'RU', tj: 'TJ', both: 'RU + TJ' };

/** Буфер с оформлением доступен только в защищённом контексте (HTTPS, localhost) и с ClipboardItem. */
export const canCopyRich = () => typeof window !== 'undefined' && window.isSecureContext && 'ClipboardItem' in window && !!navigator.clipboard?.write;

export function LetterExport({ letter, dirty, signature }: { letter: Letter; dirty: boolean; signature: { htmlRu: string; htmlTj: string } }) {
  const toast = useToast();
  const langs = letter.exportLangs;
  const [lang, setLang] = useState<ExportLang>(langs.includes('both') ? 'both' : langs[0] ?? 'ru');
  const latest = letter.versionNo ?? 1;
  const [version, setVersion] = useState<number>(latest);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState(false);
  const v = useQuery({
    queryKey: awarenessKeys.version(letter.id, version),
    queryFn: () => awarenessApi.version(letter.id, version),
    staleTime: Infinity,
  });
  const sent = letter.versions.find((x) => x.no === version)?.reason === 'sent';
  // У версии sent подпись уже текстом; у остальных — текущая подпись.
  const sig = sent ? { htmlRu: '', htmlTj: '' } : signature;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выгрузить письмо', 'error');
    } finally {
      setBusy(null);
    }
  };
  const ver = version === latest ? undefined : version;

  const copy = () => run('copy', async () => {
    const r = await awarenessApi.exportHtml(letter.id, lang, ver);
    if (!canCopyRich()) {
      setManualCopy(true);
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([r.html], { type: 'text/html' }),
        'text/plain': new Blob([r.text], { type: 'text/plain' }),
      })]);
      setManualCopy(false);
      toast(`Скопировано с оформлением. Тема: ${r.subject}`);
    } catch {
      setManualCopy(true);
    }
  });

  const eml = () => run('eml', async () => {
    const { blob, fileName } = await awarenessApi.exportEml(letter.id, lang, ver);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Файл ${fileName} скачан — откройте его в почтовом клиенте`);
  });

  const printHref = `/awareness/letters/${letter.id}/print?lang=${lang}${ver ? `&version=${ver}` : ''}`;
  const show = (l: 'Ru' | 'Tj') => lang === 'both' || lang === l.toLowerCase();

  if (!langs.length) return <div className="hint">Письмо пустое — выгружать нечего. Заполните тему и текст.</div>;
  return (
    <div className="aw-export" data-testid="letter-export">
      {dirty && <div className="note aw-warn" role="status">Выгружается сохранённая версия. Чтобы выгрузить правки, сначала сохраните письмо.</div>}
      <div className="row aw-export-opts">
        <div className="filters" role="group" aria-label="Язык">
          {langs.map((l) => <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>{LANG_NAME[l]}</button>)}
        </div>
        {letter.versions.length > 1 && (
          <label className="row gap6">Версия
            <select className="inp sm" value={version} onChange={(e) => setVersion(Number(e.target.value))}>
              {letter.versions.map((x) => <option key={x.no} value={x.no}>{x.no}{x.no === latest ? ' — последняя' : ''}{x.reason === 'sent' ? ' (отправленная)' : ''}</option>)}
            </select>
          </label>
        )}
      </div>
      {letter.langMark && <div className="hint">Срочное письмо только на одном языке — выгружается он.</div>}
      <div className="row aw-export-btns">
        <button className="btn primary" type="button" disabled={!!busy} onClick={() => void copy()}>Скопировать с оформлением</button>
        <button className="btn" type="button" disabled={!!busy} onClick={() => void eml()}>Скачать .eml</button>
        <a className="btn" href={printHref} target="_blank" rel="noopener">Печать / PDF</a>
      </div>
      {manualCopy && (
        <div className="note aw-warn" role="status">Браузер не дал доступа к буферу обмена. Выделите текст в предпросмотре ниже и нажмите Ctrl+C.</div>
      )}
      <p className="hint">Вставьте в новое письмо Outlook или WorldClient. Файл .eml откроется как неотправленное письмо: получателей добавьте в почтовом клиенте.</p>

      {v.data && (
        <div className="aw-preview" data-testid="export-preview">
          {(['Ru', 'Tj'] as const).filter(show).map((l, i) => (
            <div key={l} className="aw-lang-view">
              {i > 0 && <hr />}
              <div className="w600">Тема: {v.data.content[`subject${l}`] || <span className="muted">без темы</span>}</div>
              <LetterHtml html={v.data.content[`html${l}`]} signature={sig[`html${l}`]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
