// Выгрузка учебного письма (1.9.0; 1.12.0 — «Готовое письмо», docs/specs/awareness.md, разделы 16, 22–24).
// «Скачать для Outlook (.eml)» — основная: файл по макету, открывается как новое письмо, остаётся вставить адреса.
// «Скопировать с оформлением» (WorldClient), «Печать / PDF». Языки — только заполненные, версия — любая.
// Предпросмотр — тот же HTML, что уйдёт в .eml. Каждая выгрузка пишется в журнал backend, .eml — сохраняется.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { awarenessApi, awarenessKeys, type ExportLang, type Letter } from '../../api/awareness';
import { useToast } from '../../components/Toast';
import { MailPreview } from './MailPreview';

const LANG_NAME: Record<ExportLang, string> = { ru: 'RU', tj: 'TJ', both: 'RU + TJ' };

/** Буфер с оформлением доступен только в защищённом контексте (HTTPS, localhost) и с ClipboardItem. */
export const canCopyRich = () => typeof window !== 'undefined' && window.isSecureContext && 'ClipboardItem' in window && !!navigator.clipboard?.write;

const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return `?${p.toString()}`;
};

export function LetterExport({ letter, dirty }: { letter: Letter; dirty: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const langs = letter.exportLangs;
  const [lang, setLang] = useState<ExportLang>(langs.includes('both') ? 'both' : langs[0] ?? 'ru');
  const latest = letter.versionNo ?? 1;
  const [version, setVersion] = useState<number>(latest);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null);
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
    setDownloaded(fileName);
    void qc.invalidateQueries({ queryKey: awarenessKeys.exports(letter.id) });
    toast(`Файл ${fileName} скачан — откройте его в Outlook`);
  });

  const printHref = `/awareness/letters/${letter.id}/print?lang=${lang}${ver ? `&version=${ver}` : ''}`;
  const canMark = letter.actions.some((x) => x === 'send' || x === 'send_without_approval' || x === 'resend');

  if (!langs.length) return <div className="hint">Письмо пустое — выгружать нечего. Заполните тему и текст.</div>;
  return (
    <div className="aw-export" data-testid="letter-export">
      {dirty && <div className="note aw-warn" role="status">Выгружается сохранённая версия. Чтобы выгрузить правки, сначала сохраните письмо.</div>}
      <div className="row aw-export-opts">
        <div className="filters" role="group" aria-label="Языки выгрузки">
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
        <button className="btn primary" type="button" disabled={!!busy} onClick={() => void eml()}>Скачать для Outlook (.eml)</button>
        <button className="btn" type="button" disabled={!!busy} onClick={() => void copy()}>Скопировать с оформлением</button>
        <a className="btn" href={printHref} target="_blank" rel="noopener">Печать / PDF</a>
      </div>
      {downloaded && canMark && (
        <div className="note" role="status" data-testid="after-download">Когда отправите, нажмите «Отметить отправленным».</div>
      )}
      {manualCopy && (
        <div className="note aw-warn" role="status">Браузер не дал доступа к буферу обмена. Выделите текст в предпросмотре ниже и нажмите Ctrl+C.</div>
      )}
      <p className="hint">
        Файл .eml откроется в Outlook как новое письмо: добавьте получателей и отправьте. «Скопировать с оформлением» — для WorldClient:
        вставьте в новое письмо и проверьте, что логотип на месте.
      </p>
      <MailPreview
        langs={langs}
        reloadKey={`${letter.id}:${version}:${letter.version}`}
        load={async (l) => {
          const r = await awarenessApi.versionPreview(letter.id, l, ver);
          return { subject: r.subject, src: `/api/v1/awareness/letters/${letter.id}/export/preview.html${qs({ lang: l, version: ver })}` };
        }}
      />
    </div>
  );
}
