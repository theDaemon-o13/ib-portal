// Импорт скана в узел (ADR-0029): файл → предпросмотр сравнения с реестром узла → выбор по строкам → применение одной транзакцией.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ChangeEvent } from 'react';
import { registersApi } from '../../api/registers';
import { settingsApi } from '../../api/settings';
import { vkeys, vulnsApi, type ScanPreview, type VulnGroup, type VulnNode } from '../../api/vulns';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { Modal } from './Dialogs';
import { applyLabel, defaultSelection, groupCount, selectionBody, toggleAll, toggleOne, type ImportGroup, type Selection } from './logic';
import { useTodayIso } from './today';

const GROUPS: { key: ImportGroup | 'unchanged'; title: string; hint: string }[] = [
  { key: 'new', title: 'Новые', hint: 'Ключа нет в узле — создаётся запись. Срока нет до передачи ИКТ.' },
  { key: 'deleted', title: 'Были удалены', hint: 'Запись с этим ключом удалили в узле (причина — в строке). По умолчанию не загружается; выбранная заводится новой записью, удалённая остаётся в корзине.' },
  { key: 'reopened', title: 'Повторно', hint: 'Запись была «Устранена» — откроется заново, срок пойдёт от передачи ИКТ этого скана; продления и решение п. 7.3 снимутся.' },
  { key: 'changed', title: 'Изменились', hint: 'Отличаются Уровень, CVSS, Эксплойт, Сетевой вектор, Обновить до версии или Обнаружений. Поля обновятся, в истории — было → стало.' },
  { key: 'unchanged', title: 'Без изменений', hint: 'Всё совпадает: отмечаются как найденные в этом скане.' },
  { key: 'gone', title: 'Пропали', hint: 'Открытые записи узла, которых нет в файле. Выбранные станут «Устранена» со ссылкой на скан, остальные останутся открытыми.' },
];

export function ScanImportDialog({ node, nodeLabel, onClose, onDone }: { node: VulnNode; nodeLabel: string; onClose: () => void; onDone: (scanId: string) => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await vulnsApi.previewScan(node.id, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
      toast('Файл не загружен', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (preview) return <PreviewStep key={preview.id} preview={preview} nodeLabel={nodeLabel} onClose={onClose} onDone={onDone} />;
  return (
    <Modal title="Импорт скана" sub={`${nodeLabel}. Файл сравнивается с реестром этого типа систем.`} wide onClose={onClose}
      footer={<>
        <span className="hint v-grow">Ничего не записывается, пока вы не подтвердите предпросмотр.</span>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
      </>}>
      <div className="v-drop">
        <b>Отчёт сканера (.xlsx)</b>
        <span className="hint">Лист хостов ищется по колонке «Имя хоста», листы находок — по колонкам «Пакет» и «CVE». Название листа не важно. Дата скана — из имени файла.</span>
        <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Читаем файл…' : 'Выбрать файл'}</button>
        <input ref={fileRef} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Файл скана" onChange={(e) => void onFile(e)} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

/** Импорт со страницы группы: узел предлагается по профилю из имени файла. Дальше — общий предпросмотр. */
export function GroupScanImportDialog({ group, canStructure, onClose, onDone }: { group: VulnGroup; canStructure: boolean; onClose: () => void; onDone: (scanId: string) => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<{ id: string; label: string } | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      toast(failure, 'error');
    } finally {
      setBusy(false);
    }
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run(async () => {
      const t = await vulnsApi.scanTarget(group.id, f.name);
      setFile(f);
      setDetected(t.detected);
      setNodeId(t.nodeId ?? '');
    }, 'Файл не загружен');
  };
  const load = (id: string) => run(async () => {
    if (file) setPreview(await vulnsApi.previewScan(id, file));
  }, 'Файл не загружен');
  const addType = (type: { id: string; label: string }) => run(async () => {
    if (file) setPreview(await vulnsApi.previewNewNodeScan(group.id, type.id, file));
  }, 'Файл не загружен');

  if (preview) return <PreviewStep key={preview.id} preview={preview} nodeLabel={preview.summary.node.label} onClose={onClose} onDone={onDone} />;
  const missing = detected && !group.nodes.some((n) => n.systemType?.id === detected.id) ? detected : null;
  return (
    <Modal title="Импорт скана" sub={`Группа «${group.name}». Портал предложит узел по имени файла, выбрать можно любой узел группы.`} wide onClose={onClose}
      footer={<>
        <span className="hint v-grow">Ничего не записывается, пока вы не подтвердите предпросмотр.</span>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        {file && missing && canStructure && <button className="btn" type="button" disabled={busy} onClick={() => void addType(missing)}>Добавить тип {missing.label} в группу и импортировать</button>}
        {file && <button className="btn primary" type="button" disabled={busy || !nodeId} onClick={() => void load(nodeId)}>{busy ? 'Читаем файл…' : 'Продолжить'}</button>}
      </>}>
      {!file && (
        <div className="v-drop">
          <b>Отчёт сканера (.xlsx)</b>
          <span className="hint">Один отчёт — один профиль сканирования. Профиль ищется в имени файла, например Scan_Linux_2026-11-01.xlsx.</span>
          <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>Выбрать файл</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Файл скана" onChange={onFile} />
        </div>
      )}
      {file && (
        <>
          <p>Файл «{file.name}». {!detected ? 'Профиль по имени файла не определён: выберите узел.' : missing ? `Похоже на профиль ${missing.label}, такого типа в группе нет.` : `Похоже на профиль ${detected.label}.`}</p>
          {missing && !canStructure && <p className="note v-warn" role="alert">Добавить тип {missing.label} в группу может сотрудник с правом «Конструктор реестров». Либо выберите существующий узел.</p>}
          <label className="fd-label">Узел
            <select className="inp" value={nodeId} aria-label="Узел" onChange={(e) => setNodeId(e.target.value)}>
              <option value="">— выберите</option>
              {group.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </label>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

function PreviewStep({ preview, nodeLabel, onClose, onDone }: { preview: ScanPreview; nodeLabel: string; onClose: () => void; onDone: (scanId: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useTodayIso();
  const s = preview.summary;
  const [scanDate, setScanDate] = useState(s.scanDate ?? '');
  const [systemId, setSystemId] = useState(s.systemId ?? '');
  const [sel, setSel] = useState<Selection>(() => defaultSelection(s));
  const [confirmed, setConfirmed] = useState(false);
  const mismatch = s.profile?.mismatch ? s.profile : null;
  const first = (['new', 'reopened', 'changed', 'deleted', 'gone', 'unchanged'] as const).find((g) => groupCount(s, g) > 0) ?? 'new';
  const [tab, setTab] = useState<ImportGroup | 'unchanged'>(first);
  const systems = useQuery({ queryKey: ['settings', 'items', 'systems', 'active'], queryFn: () => settingsApi.items('systems', false) });
  const badDate = !scanDate || scanDate > today;
  const apply = useMutation({
    mutationFn: () => vulnsApi.applyScan(preview.id, { scanDate, systemId: systemId || null, selected: selectionBody(sel), profileConfirmed: mismatch ? confirmed : undefined }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast(`Скан загружен: новых ${r.created}, повторно ${r.reopened}, изменились ${r.changed}, отмечено устранёнными ${r.gone}`);
      onDone(r.scanId);
    },
  });
  const cancel = () => {
    void registersApi.cancelImport(preview.id).catch(() => undefined); // не критично: предпросмотр сам устареет через 30 минут
    onClose();
  };
  const group = GROUPS.find((g) => g.key === tab);
  const selectable = tab !== 'unchanged';
  const list = tab === 'gone' ? [] : s.groups[tab] ?? [];
  return (
    <Modal title={`Предпросмотр · ${nodeLabel}`} sub={`Файл «${s.fileName}»: строк ${s.rows}, листов находок ${s.sheets.length}. Пока ничего не изменено.`} wide onClose={cancel}
      footer={<>
        <button className="btn" type="button" onClick={cancel} disabled={apply.isPending}>Отмена</button>
        <button className="btn primary" type="button" disabled={badDate || apply.isPending || (!!mismatch && !confirmed)} onClick={() => apply.mutate()}>{applyLabel(sel)}</button>
      </>}>
      {mismatch && (
        <div className="note v-warn" role="alert" data-testid="profile-mismatch">
          <p><b>Файл похож на скан профиля {mismatch.detected?.label}, а узел — {mismatch.nodeType?.label}.</b> Сравнение покажет находки узла как пропавшие.</p>
          <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Я проверил, файл относится к этому узлу</label>
        </div>
      )}
      <div className="row scan-dates">
        <label className="fd-label">Дата скана
          <input className="inp" type="date" value={scanDate} max={today} onChange={(e) => setScanDate(e.target.value)} aria-label="Дата скана" />
        </label>
        <label className="fd-label">Система
          <select className="inp" value={systemId} onChange={(e) => setSystemId(e.target.value)} aria-label="Система">
            <option value="">— не указана</option>
            {systems.data?.items.map((i) => <option key={i.id} value={i.id}>{i.value}{i.owner ? ` · владелец ${i.owner.fullName}` : ''}</option>)}
          </select>
        </label>
        <span className="hint v-grow">Система ставится новым записям: по ней уведомление находит владельца системы.{s.systemId ? ' Взята из прошлого импорта узла.' : ''}</span>
      </div>
      {badDate && <p className="form-error" role="alert">Укажите дату скана: не позже сегодняшней.</p>}
      <div className="v-facts">
        <div><span>Охват</span><b>{s.coverageTitle || '—'}</b></div>
        <div><span>Хостов</span><b>{s.hostsCount}</b></div>
        <div><span>Новых хостов</span><b>{s.coverage.newHosts.length}</b></div>
        <div><span>Выбыло хостов</span><b>{s.coverage.goneHosts.length}</b></div>
        {s.previousScan && <div><span>Прошлый скан</span><b>{formatDate(s.previousScan.scanDate)}</b></div>}
        {s.inFileDuplicates > 0 && <div><span>Повторов ключа</span><b>{s.inFileDuplicates}</b></div>}
        {s.errorRows > 0 && <div><span>Пропущено строк</span><b>{s.errorRows}</b></div>}
      </div>
      {s.critCounts.length > 0 && (
        <div className="cover">{s.critCounts.map((c) => <span key={c.key} className={`chip ${c.key === 'critical' ? 'crit' : c.key === 'medium' ? 'med' : c.key}`}>{c.label}: {c.count}</span>)}</div>
      )}
      {s.warnings.length > 0 && <ul className="warn-list">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {s.newOptions.length > 0 && <div className="hint">Добавятся значения списков: {s.newOptions.map((o) => `${o.field} — ${o.values.length}`).join('; ')}</div>}
      <div className="v-dcards">
        {GROUPS.filter((g) => g.key !== 'deleted' || groupCount(s, 'deleted') > 0).map((g) => (
          <button key={g.key} type="button" className={`v-dcard k-${g.key}`} aria-pressed={tab === g.key} onClick={() => setTab(g.key)}>
            <b>{g.key === 'unchanged' ? s.counts.unchanged : `${sel[g.key].size} / ${groupCount(s, g.key)}`}</b>
            <span>{g.title}</span>
          </button>
        ))}
      </div>
      <p className="hint">{group?.hint}</p>
      {tab === 'gone' && s.coverage.goneHosts.length > 0 && (
        <p className="note crit-note" role="alert">Выбыли из охвата: {s.coverage.goneHosts.join(', ')}. Запись могла пропасть потому, что хост не сканировали.</p>
      )}
      <div className="tbl-wrap v-list">
        <table className="cat-tbl">
          <thead>
            <tr>
              {selectable && (
                <th><input type="checkbox" aria-label={`Выбрать все: ${group?.title}`} checked={groupCount(s, tab) > 0 && sel[tab].size === groupCount(s, tab)} onChange={() => setSel(toggleAll(sel, tab, s))} /></th>
              )}
              <th>Пакет / идентификатор</th>
              <th>{tab === 'changed' ? 'Что изменилось' : tab === 'gone' ? 'Статус' : 'Критичность'}</th>
              <th>Срок</th>
            </tr>
          </thead>
          <tbody>
            {tab === 'gone'
              ? s.groups.gone.map((g) => (
                <tr key={g.key}>
                  <td><input type="checkbox" aria-label={`Выбрать ${g.cve}`} checked={sel.gone.has(g.key)} onChange={() => setSel(toggleOne(sel, 'gone', g.key))} /></td>
                  <td className="v-pk"><b>{g.pkg}</b><span>{g.cve} · #{g.number}</span></td>
                  <td>{g.status} · {g.crit}</td>
                  <td className="mono">{g.due ? formatDate(g.due) : '—'}</td>
                </tr>
              ))
              : list.map((i) => (
                <tr key={i.key}>
                  {selectable && <td><input type="checkbox" aria-label={`Выбрать ${i.cve}`} checked={sel[tab].has(i.key)} onChange={() => setSel(toggleOne(sel, tab, i.key))} /></td>}
                  <td className="v-pk">
                    <b>{i.pkg}</b><span>{i.cve}{i.number ? ` · #${i.number}` : ''}{i.closedStatus ? ` · ${i.closedStatus}` : ''}</span>
                    {i.deleted && <span className="hint">Была удалена #{i.deleted.number} {formatDate(i.deleted.deletedAt.slice(0, 10))}: {i.deleted.reason}</span>}
                  </td>
                  <td>
                    {tab === 'changed' || (tab === 'reopened' && i.changes.length > 0)
                      ? i.changes.map((c) => <div key={c.fieldId} className="v-chg">{c.label}: {c.from || '—'} → <b>{c.to || '—'}</b></div>)
                      : <>{i.crit}{i.score !== null ? ` · Оценка ${String(i.score).replace('.', ',')}` : ''}</>}
                  </td>
                  <td className="mono">
                    {i.dueBefore === i.dueAfter ? (i.dueAfter ? formatDate(i.dueAfter) : '—') : `${i.dueBefore ? formatDate(i.dueBefore) : '—'} → ${i.dueAfter ? formatDate(i.dueAfter) : '—'}`}
                    {i.becomesOverdue && <span className="chip crit"> станет просроченной</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {s.errors.length > 0 && (
        <details className="grid-gap">
          <summary className="eyebrow">Пропущенные строки ({s.errorRows})</summary>
          <div className="tbl-wrap imp-errors">
            <table className="cat-tbl">
              <thead><tr><th>Лист</th><th>Строка</th><th>Причина</th></tr></thead>
              <tbody>{s.errors.map((e, i) => <tr key={i}><td>{e.sheet}</td><td className="mono">{e.row}</td><td>{e.message}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      {s.notes.length > 0 && (
        <details className="grid-gap">
          <summary className="eyebrow">Значения считаются пустыми ({s.notes.length})</summary>
          <div className="tbl-wrap imp-errors">
            <table className="cat-tbl">
              <thead><tr><th>Лист</th><th>Строка</th><th>Сообщение</th></tr></thead>
              <tbody>{s.notes.map((e, i) => <tr key={i}><td>{e.sheet}</td><td className="mono">{e.row}</td><td>{e.message}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      {apply.error && <p className="form-error" role="alert">{apply.error.message}</p>}
    </Modal>
  );
}
