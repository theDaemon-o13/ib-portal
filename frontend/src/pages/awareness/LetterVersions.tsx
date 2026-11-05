// Версии письма (1.9.0, ADR-0039; docs/specs/awareness.md, раздел 14): список, просмотр (только чтение), сравнение
// двух любых версий построчно — отдельно тема и текст RU и TJ, «Восстановить версию N» (новая версия, старые не меняются).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { awarenessApi, awarenessKeys, type Letter, type LetterVersion } from '../../api/awareness';
import { hasChanges, htmlToLines, lineDiff, ruDateTime, VERSION_REASON, type DiffLine } from './logic';

const SIG_RE = /<div data-ib-fragment="signature"><\/div>/g;

/** HTML письма для просмотра: санитизирован backend; блок подписи — текущая подпись (у версии sent она уже текстом). */
export function LetterHtml({ html, signature, testId }: { html: string; signature: string; testId?: string }) {
  const shown = html.replace(SIG_RE, `<div class="aw-sig-view">${signature}</div>`);
  return shown ? <div className="aw-doc aw-view" data-testid={testId} dangerouslySetInnerHTML={{ __html: shown }} /> : <div className="hint">Пусто</div>;
}

function Diff({ title, lines }: { title: string; lines: DiffLine[] }) {
  return (
    <div className="aw-diff">
      <div className="eyebrow">{title}{!hasChanges(lines) && <span className="muted"> — без изменений</span>}</div>
      {hasChanges(lines) && (
        <ul>
          {lines.map((l, i) => (
            <li key={i} className={l.kind}><span className="aw-diff-m" aria-label={l.kind === 'add' ? 'добавлено' : l.kind === 'del' ? 'удалено' : 'без изменений'}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LetterVersions({ letter, signature, onRestore, busy }: {
  letter: Letter;
  signature: { htmlRu: string; htmlTj: string };
  onRestore: (no: number) => void;
  busy: boolean;
}) {
  const latest = letter.versionNo ?? 1;
  const [view, setView] = useState<number | null>(null);
  const [cmp, setCmp] = useState<{ a: number; b: number } | null>(null);
  const get = (no: number | null) => ({
    queryKey: awarenessKeys.version(letter.id, no ?? 0),
    queryFn: () => awarenessApi.version(letter.id, no ?? 0),
    enabled: no !== null && no > 0,
    staleTime: Infinity,
  });
  const viewed = useQuery(get(view));
  const va = useQuery(get(cmp?.a ?? null));
  const vb = useQuery(get(cmp?.b ?? null));
  const canRestore = letter.actions.includes('restore');

  const diffs = (a: LetterVersion, b: LetterVersion) => [
    { title: 'Тема RU', lines: lineDiff([a.content.subjectRu].filter(Boolean), [b.content.subjectRu].filter(Boolean)) },
    { title: 'Текст RU', lines: lineDiff(htmlToLines(a.content.htmlRu), htmlToLines(b.content.htmlRu)) },
    { title: 'Тема TJ', lines: lineDiff([a.content.subjectTj].filter(Boolean), [b.content.subjectTj].filter(Boolean)) },
    { title: 'Текст TJ', lines: lineDiff(htmlToLines(a.content.htmlTj), htmlToLines(b.content.htmlTj)) },
  ];

  return (
    <div className="aw-versions" data-testid="letter-versions">
      <table className="cat-tbl">
        <thead><tr><th>Версия</th><th>Что</th><th>Кто, когда</th><th /></tr></thead>
        <tbody>
          {letter.versions.map((v) => (
            <tr key={v.no} className={view === v.no ? 'sel' : undefined}>
              <td className="mono">{v.no}{v.no === latest && <span className="chip acc ml6">текущая</span>}</td>
              <td>{VERSION_REASON[v.reason]}{v.restoredFrom ? ` из версии ${v.restoredFrom}` : ''}
                {v.no === letter.approvedVersionNo && <span className="chip low ml6">утверждена</span>}
              </td>
              <td><div>{v.createdBy.fullName}</div><div className="hint">{ruDateTime(v.createdAt)}</div></td>
              <td className="row nowrap gap6">
                <button className="btn sm" type="button" onClick={() => { setView(view === v.no ? null : v.no); setCmp(null); }}>{view === v.no ? 'Скрыть' : 'Открыть'}</button>
                {v.no !== latest && (
                  <button className="btn sm" type="button" onClick={() => { setCmp({ a: v.no, b: latest }); setView(null); }}>Сравнить с текущей</button>
                )}
                {canRestore && v.no !== latest && v.reason !== 'sent' && (
                  <button className="btn sm" type="button" disabled={busy} onClick={() => onRestore(v.no)}>Восстановить</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {letter.versions.length > 1 && (
        <div className="row aw-cmp" role="group" aria-label="Сравнить версии">
          <span>Сравнить</span>
          <select className="inp sm" aria-label="Версия «было»" value={cmp?.a ?? ''} onChange={(e) => setCmp({ a: Number(e.target.value), b: cmp?.b ?? latest })}>
            <option value="" disabled>версию…</option>
            {letter.versions.map((v) => <option key={v.no} value={v.no}>{v.no}</option>)}
          </select>
          <span>и</span>
          <select className="inp sm" aria-label="Версия «стало»" value={cmp?.b ?? latest} onChange={(e) => setCmp({ a: cmp?.a ?? 1, b: Number(e.target.value) })}>
            {letter.versions.map((v) => <option key={v.no} value={v.no}>{v.no}</option>)}
          </select>
        </div>
      )}

      {view !== null && viewed.data && (
        <div className="aw-version-view" data-testid="version-view">
          <div className="eyebrow">Версия {view} — только чтение</div>
          {(['Ru', 'Tj'] as const).map((lang) => (
            <div key={lang} className="aw-lang-view">
              <div className="w600">{lang.toUpperCase()}: {viewed.data.content[`subject${lang}`] || <span className="muted">без темы</span>}</div>
              <LetterHtml html={viewed.data.content[`html${lang}`]} signature={signature[`html${lang}`]} />
            </div>
          ))}
        </div>
      )}

      {cmp && va.data && vb.data && (
        <div className="aw-compare" data-testid="version-diff">
          <div className="eyebrow">Версия {cmp.a} → версия {cmp.b}</div>
          {cmp.a === cmp.b ? <div className="hint">Выберите две разные версии</div> : diffs(va.data, vb.data).map((d) => <Diff key={d.title} {...d} />)}
        </div>
      )}
    </div>
  );
}
