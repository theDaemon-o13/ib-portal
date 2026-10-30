// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029, ADR-0030; эталон — docs/prototype/vulnerabilities-demo.html).
// Дерево «группа → тип систем → сканы», экраны: все группы, группа, узел, скан. Адрес: /vulns/<вид>/<id>.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { registersApi, type RegisterDetail } from '../../api/registers';
import { vkeys, vulnsApi, type NodeRecord, type NodeStats, type ScanBrief, type VulnGroup, type VulnNode, type VulnOverview } from '../../api/vulns';
import { useFileViewer } from '../../components/files/FileViewer';
import { formatDate } from '../registers/logic';
import { rkeys } from '../registers/keys';
import { RecordDrawer } from '../registers/RecordDrawer';
import { AddTypeDialog, GroupDialog, HandoverDialog, RenameGroupDialog, TransferDialog } from './Dialogs';
import { ExtensionDialog, ExtensionList } from './ExtensionDialog';
import { CRIT_TONE, dueHint, groupStats, lastScanOf, parseView, STATE_FILTERS, STATE_LABELS, sumStats, viewPath, type Totals, type VulnView } from './logic';
import { ScanImportDialog } from './ScanImportDialog';
import { useTodayIso } from './today';
import { VulnRecordBlock } from './VulnRecordBlock';
import '../../styles/vulns.css';

type Go = (v: VulnView) => void;
const NO_STATS: NodeStats = { nodeId: '', open: 0, overdue: 0, critical: 0, notHandedOver: 0, fixed: 0, total: 0, lastScan: null, scans: [] };

function Tree({ groups, stats, view, go, canManage, onNewGroup }: { groups: VulnGroup[]; stats: NodeStats[]; view: VulnView; go: Go; canManage: boolean; onNewGroup: () => void }) {
  const cur = (kind: VulnView['kind'], id?: string) => (view.kind === kind && (kind === 'root' || (view as { id?: string }).id === id) ? 'true' : undefined);
  const count = (t: Totals) => <span className="c">{t.open}{t.overdue > 0 && <span className="o">{t.overdue}</span>}</span>;
  return (
    <nav className="panel v-tree" aria-label="Группы и реестры">
      <div className="v-tree-h">
        <b>ГРУППЫ</b>
        {canManage && <button className="btn sm" type="button" onClick={onNewGroup}>+ Группа</button>}
      </div>
      <button type="button" className="tn g" aria-current={cur('root')} onClick={() => go({ kind: 'root' })}>
        <span className="t">Все группы</span>{count(sumStats(stats))}
      </button>
      <div className="tsep" />
      {groups.map((g) => (
        <div key={g.id}>
          <button type="button" className={`tn g${g.system ? ' sys' : ''}`} aria-current={cur('group', g.id)} onClick={() => go({ kind: 'group', id: g.id })}>
            <span className="t">{g.name}</span>{count(sumStats(groupStats(g, stats)))}
          </button>
          {g.nodes.map((n) => {
            const st = stats.find((s) => s.nodeId === n.id) ?? NO_STATS;
            return (
              <div key={n.id}>
                <button type="button" className="tn n" aria-current={cur('node', n.id)} onClick={() => go({ kind: 'node', id: n.id })}>
                  <span className="t">{n.label}</span>{count(st)}
                </button>
                {!n.legacy && st.scans.map((s) => (
                  <button key={s.id} type="button" className="tn s" aria-current={cur('scan', s.id)} onClick={() => go({ kind: 'scan', id: s.id })}>
                    <span className={`ictdot${s.handedOver ? '' : ' no'}`} title={s.handedOver ? 'Передан ИКТ' : 'Не передан ИКТ'} />
                    <span className="t">Скан {formatDate(s.scanDate)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ))}
      <div className="tsep" />
      <p className="hint v-legend">
        Число — открыто, <span className="v-over">красное</span> — просрочено. Точка у скана: <span className="ictdot" /> передан ИКТ, <span className="ictdot no" /> ждёт передачи.
      </p>
    </nav>
  );
}

function Kpis({ t, extra, extraLabel }: { t: Totals; extra: number; extraLabel: string }) {
  return (
    <div className="v-kpis">
      <div className="panel v-kpi"><span className="v">{t.open}</span><span className="l">Открыто</span></div>
      <div className="panel v-kpi"><span className="v crit">{t.critical}</span><span className="l">Критических открыто</span></div>
      <div className="panel v-kpi"><span className="v crit">{t.overdue}</span><span className="l">Просрочено</span></div>
      <div className="panel v-kpi"><span className="v high">{extra}</span><span className="l">{extraLabel}</span></div>
    </div>
  );
}

const IctChip = ({ handedOver, date }: { handedOver: boolean; date?: string | null }) => (
  <span className={`chip ${handedOver ? 'low' : 'high'}`}>{handedOver ? `Передан ИКТ${date ? ` ${formatDate(date)}` : ''}` : 'Не передан ИКТ'}</span>
);

function Crumbs({ parts, go }: { parts: { t: string; to?: VulnView }[]; go: Go }) {
  return (
    <div className="v-crumbs">
      {parts.map((p, i) => (p.to
        ? <span key={i}><button type="button" onClick={() => go(p.to as VulnView)}>{p.t}</button><i> / </i></span>
        : <span key={i}>{p.t}</span>))}
    </div>
  );
}

function RootView({ groups, ov, go, canManage, onNewGroup }: { groups: VulnGroup[]; ov: VulnOverview; go: Go; canManage: boolean; onNewGroup: () => void }) {
  const labelOf = (id: string) => ov.awaiting.find((a) => a.id === id)?.nodeLabel ?? '';
  return (
    <>
      <div className="head">
        <div>
          <h1>Уязвимости</h1>
          <p>Реестры по группам: сервисы и подразделения, внутри — типы систем. Срок устранения идёт от передачи отчёта ИКТ, продление — по обоснованию ОИКТ.</p>
        </div>
        {canManage && <button className="btn primary" type="button" onClick={onNewGroup}>Создать группу</button>}
      </div>
      <Kpis t={sumStats(ov.nodes)} extra={ov.awaiting.length} extraLabel="Сканов ждут передачи ИКТ" />
      <div className="v-grid">
        <section className="panel v-w8">
          <div className="panel-h"><h3>Группы</h3><span className="hint">Нажмите строку, чтобы открыть группу</span></div>
          <div className="tbl-wrap">
            <table className="cat-tbl v-click">
              <thead><tr><th>Группа</th><th>Вид</th><th>Типы систем</th><th className="v-r">Открыто</th><th className="v-r">Критич.</th><th className="v-r">Просроч.</th><th>Последний скан</th></tr></thead>
              <tbody>
                {groups.map((g) => {
                  const st = groupStats(g, ov.nodes);
                  const t = sumStats(st);
                  const last = lastScanOf(st);
                  return (
                    <tr key={g.id} onClick={() => go({ kind: 'group', id: g.id })}>
                      <td><b>{g.name}</b></td><td><span className="v-kind">{g.kindLabel}</span></td>
                      <td>{g.nodes.map((n) => n.label).join(', ')}</td>
                      <td className="v-r">{t.open}</td><td className="v-r">{t.critical}</td><td className={`v-r${t.overdue ? ' v-over' : ''}`}>{t.overdue}</td>
                      <td>{last ? <>{formatDate(last.scanDate)} <IctChip handedOver={last.handedOver} /></> : <span className="hint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel v-w4">
          <div className="panel-h"><h3>Ждут передачи ИКТ</h3></div>
          <div className="panel-b">
            {ov.awaiting.length === 0 && <p className="hint">Все сканы переданы.</p>}
            {ov.awaiting.map((a) => (
              <button key={a.id} type="button" className="v-await" onClick={() => go({ kind: 'scan', id: a.id })}>
                <span>{labelOf(a.id)}</span><span className="hint">Скан {formatDate(a.scanDate)}</span>
              </button>
            ))}
            <p className="hint">Пока скан не передан ИКТ, сроки по его новым уязвимостям не идут.</p>
          </div>
        </section>
      </div>
    </>
  );
}

function GroupView({ group, ov, go, me }: { group: VulnGroup; ov: VulnOverview; go: Go; me: Me }) {
  const [dialog, setDialog] = useState<'type' | 'rename' | 'extend' | null>(null);
  const canStructure = me.permissions.includes('registers.manage');
  const canDeadlines = me.permissions.includes('vulns.deadlines');
  const st = groupStats(group, ov.nodes);
  const t = sumStats(st);
  const ext = useQuery({ queryKey: vkeys.extensions({ groupId: group.id }), queryFn: () => vulnsApi.extensions({ groupId: group.id }) });
  return (
    <>
      <Crumbs parts={[{ t: 'Уязвимости', to: { kind: 'root' } }, { t: group.name }]} go={go} />
      <div className="head">
        <div>
          <h1>{group.name} <span className="v-kind">{group.kindLabel}</span></h1>
          <p>{group.system ? 'Сюда при обновлении попали записи прежнего реестра уязвимостей. Откройте их и перенесите в нужные группы и типы систем.' : 'Типы систем группы. У каждого свой реестр и свои сканы.'}</p>
        </div>
        <div className="row">
          {!group.system && canStructure && <button className="btn" type="button" onClick={() => setDialog('rename')}>Переименовать</button>}
          {!group.system && canStructure && <button className="btn" type="button" onClick={() => setDialog('type')}>Добавить тип</button>}
          <button className="btn" type="button" disabled={!canDeadlines} title={canDeadlines ? undefined : 'Нужно право «Уязвимости: изменение сроков»'} onClick={() => setDialog('extend')}>Обновить сроки</button>
        </div>
      </div>
      <Kpis t={t} extra={t.notHandedOver} extraLabel="Не передано ИКТ" />
      <div className="v-tcards">
        {group.nodes.map((n) => {
          const s = st.find((x) => x.nodeId === n.id) ?? NO_STATS;
          return (
            <button key={n.id} type="button" className="panel v-tcard" onClick={() => go({ kind: 'node', id: n.id })}>
              <h3>{n.label}</h3>
              <div className="v-tstats">
                <div><b>{s.open}</b><span>открыто</span></div>
                <div className={s.critical ? 'bad' : ''}><b>{s.critical}</b><span>критических</span></div>
                <div className={s.overdue ? 'bad' : ''}><b>{s.overdue}</b><span>просрочено</span></div>
              </div>
              <div className="v-tlast">
                {s.lastScan ? <>Последний скан {formatDate(s.lastScan.scanDate)} <IctChip handedOver={s.lastScan.handedOver} /></> : n.legacy ? 'Записи прежнего реестра' : 'Сканов пока нет'}
              </div>
            </button>
          );
        })}
      </div>
      <section className="panel v-mt">
        <div className="panel-h"><h3>Продления сроков в группе</h3></div>
        <ExtensionList items={ext.data?.items ?? []} canManage={canDeadlines} />
      </section>
      {dialog === 'type' && <AddTypeDialog group={group} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameGroupDialog group={group} onClose={() => setDialog(null)} />}
      {dialog === 'extend' && <ExtensionDialog scope={{ groupId: group.id }} onClose={() => setDialog(null)} />}
    </>
  );
}

function fieldId(reg: RegisterDetail, key: string): string {
  return reg.fields.find((f) => f.systemKey === key)?.id ?? '';
}

function RecordRow({ reg, r, legacy, picked, today, onPick, onOpen, onMove, canEdit }: {
  reg: RegisterDetail; r: NodeRecord; legacy: boolean; picked: boolean; today: string; canEdit: boolean;
  onPick: (id: string) => void; onOpen: (id: string) => void; onMove: (id: string) => void;
}) {
  const f = (k: string) => fieldId(reg, k);
  const st = STATE_LABELS[r.vuln.state];
  const critField = reg.fields.find((x) => x.systemKey === 'crit');
  const critKey = critField?.options.find((o) => o.id === r.values[critField.id])?.systemKey ?? '';
  const due = r.calc[f('due')];
  const dueIso = typeof due === 'string' ? due : null;
  const open = r.vuln.state !== 'fixed' && r.vuln.state !== 'accepted';
  const h = dueHint(dueIso, today, typeof r.values[f('extDays')] === 'number');
  const score = r.calc[f('score')];
  return (
    <tr onClick={() => onOpen(r.id)}>
      {legacy && canEdit && (
        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Выбрать #${r.number}`} checked={picked} onChange={() => onPick(r.id)} /></td>
      )}
      <td className="v-pk"><b>{r.display[f('pkg')] || '—'}</b><span>{r.display[f('cve')]} · #{r.number}</span></td>
      <td>{r.display[f('level')] || '—'}</td>
      <td className="v-r">{r.display[f('cvss')] || '—'}</td>
      <td className="v-r"><b>{typeof score === 'number' ? String(score).replace('.', ',') : '—'}</b></td>
      <td><span className={`chip ${CRIT_TONE[critKey] ?? ''}`}>{r.display[f('crit')] || '—'}{r.manualFieldIds.includes(f('crit')) ? ' · вручную' : ''}</span></td>
      <td>{r.display[f('exploit')] || '—'}</td>
      <td className="v-r">{r.display[f('hits')] || '—'}</td>
      <td>
        {open
          ? <div className={`v-dl ${h.tone}`}><span>{dueIso ? formatDate(dueIso) : '—'}</span><small>{h.text}</small></div>
          : <span className="hint">—</span>}
      </td>
      <td>
        <span className={`chip ${st.tone}`}>{st.label}</span>
        {r.vuln.reopened && <span className="chip crit"> повторно</span>}
      </td>
      {legacy && canEdit && (
        <td onClick={(e) => e.stopPropagation()}><button className="btn sm" type="button" onClick={() => onMove(r.id)}>Перенести</button></td>
      )}
    </tr>
  );
}

function NodeView({ node, group, reg, stats, go, me, groups }: { node: VulnNode; group: VulnGroup; reg: RegisterDetail; stats: NodeStats; go: Go; me: Me; groups: VulnGroup[] }) {
  const qc = useQueryClient();
  const today = useTodayIso();
  const [tab, setTab] = useState<'reg' | 'scans' | 'ext'>('reg');
  const [search, setSearch] = useState('');
  const [crit, setCrit] = useState('');
  const [state, setState] = useState<(typeof STATE_FILTERS)[number][0]>('open');
  const [cursor, setCursor] = useState<string | undefined>();
  const [dialog, setDialog] = useState<'import' | 'extend' | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [moving, setMoving] = useState<string[] | null>(null);
  const canEdit = me.permissions.includes('records.edit');
  const canDelete = me.permissions.includes('records.delete');
  const canDeadlines = me.permissions.includes('vulns.deadlines');
  const q = { search: search || undefined, crit: crit || undefined, state, cursor };
  const records = useQuery({ queryKey: vkeys.records(node.id, q), queryFn: () => vulnsApi.records(node.id, q) });
  const scans = useQuery({ queryKey: vkeys.scans(node.id), queryFn: () => vulnsApi.scans(node.id), enabled: tab === 'scans' });
  const ext = useQuery({ queryKey: vkeys.extensions({ nodeId: node.id }), queryFn: () => vulnsApi.extensions({ nodeId: node.id }), enabled: tab === 'ext' });
  const critField = reg.fields.find((x) => x.systemKey === 'crit');
  const page = records.data;
  const resetPage = () => setCursor(undefined);
  const nodeLabel = `${group.name} / ${node.label}`;
  const togglePick = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const legacy = node.legacy;
  return (
    <>
      <Crumbs parts={[{ t: 'Уязвимости', to: { kind: 'root' } }, { t: group.name, to: { kind: 'group', id: group.id } }, { t: node.label }]} go={go} />
      <div className="head">
        <div>
          <h1>{node.label}</h1>
          <p>{group.name} · {group.kindLabel.toLowerCase()}. {legacy ? 'Записи прежнего реестра: срок перенесён как был. Кнопка «Перенести» отправляет запись в нужный узел.' : 'Реестр — текущее состояние: одна строка на «Пакет + Идентификатор». Скан — история и сравнение.'}</p>
        </div>
        <div className="row">
          {!legacy && canEdit && <button className="btn primary" type="button" onClick={() => setDialog('import')}>Импорт скана</button>}
          <button className="btn" type="button" disabled={!canDeadlines} title={canDeadlines ? undefined : 'Нужно право «Уязвимости: изменение сроков»'} onClick={() => setDialog('extend')}>Обновить сроки</button>
        </div>
      </div>
      <div className="tabs page-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'reg'} onClick={() => setTab('reg')}>Реестр · {stats.open}</button>
        <button type="button" role="tab" aria-selected={tab === 'scans'} onClick={() => setTab('scans')}>Итоги сканирования · {stats.scans.length}</button>
        <button type="button" role="tab" aria-selected={tab === 'ext'} onClick={() => setTab('ext')}>Продления сроков</button>
      </div>
      {tab === 'reg' && (
        <section className="panel">
          <div className="panel-h v-filters">
            <input className="inp v-grow" type="search" value={search} placeholder="Пакет, идентификатор, описание" aria-label="Поиск" onChange={(e) => { setSearch(e.target.value); resetPage(); }} />
            <select className="inp" value={crit} aria-label="Критичность" onChange={(e) => { setCrit(e.target.value); resetPage(); }}>
              <option value="">Любая критичность</option>
              {critField?.options.filter((o) => !o.archived).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <select className="inp" value={state} aria-label="Статус" onChange={(e) => { setState(e.target.value as typeof state); resetPage(); }}>
              {STATE_FILTERS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            {legacy && canEdit && picked.length > 0 && <button className="btn primary" type="button" onClick={() => setMoving(picked)}>Перенести выбранные: {picked.length}</button>}
          </div>
          <div className="tbl-wrap">
            <table className="cat-tbl v-recs v-click">
              <thead>
                <tr>
                  {legacy && canEdit && <th />}
                  <th>Пакет / идентификатор</th><th>Уровень</th><th className="v-r">CVSS</th><th className="v-r">Оценка</th><th>Критичность</th><th>Эксплойт</th>
                  <th className="v-r" title="Не число хостов: одно обнаружение — один найденный пакет">Обн.</th><th>Срок</th><th>Статус</th>
                  {legacy && canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {page?.items.map((r) => <RecordRow key={r.id} reg={reg} r={r} legacy={legacy} canEdit={canEdit} picked={picked.includes(r.id)} today={today} onPick={togglePick} onOpen={setOpened} onMove={(id) => setMoving([id])} />)}
                {page && !page.items.length && <tr><td colSpan={12} className="hint">Записей нет.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="v-cnt row v-between">
            <span>Показано {page?.items.length ?? 0} из {page?.total ?? 0}. Строка открывает карточку записи: расчёт Оценки, история срока, сканы.</span>
            <span className="row">
              {cursor && <button className="btn sm" type="button" onClick={resetPage}>К началу</button>}
              {page?.nextCursor && <button className="btn sm" type="button" onClick={() => setCursor(page.nextCursor ?? undefined)}>Дальше</button>}
            </span>
          </div>
        </section>
      )}
      {tab === 'scans' && <ScansTab items={scans.data?.items ?? []} go={go} />}
      {tab === 'ext' && (
        <section className="panel">
          <div className="panel-h"><h3>Продления сроков</h3><span className="hint">Только по обоснованию ОИКТ, каждое можно отменить целиком</span></div>
          <ExtensionList items={ext.data?.items ?? []} canManage={canDeadlines} />
        </section>
      )}
      {opened && (
        <RecordDrawer key={opened} reg={reg} recordId={opened} canEdit={canEdit} canDelete={canDelete} onClose={() => { setOpened(null); void qc.invalidateQueries({ queryKey: vkeys.all }); }} onCreated={() => undefined}
          extra={<VulnRecordBlock recordId={opened} go={go} />} />
      )}
      {dialog === 'import' && <ScanImportDialog node={node} nodeLabel={nodeLabel} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); go({ kind: 'scan', id }); }} />}
      {dialog === 'extend' && <ExtensionDialog scope={{ nodeId: node.id }} onClose={() => setDialog(null)} />}
      {moving && <TransferDialog recordIds={moving} groups={groups} onClose={() => setMoving(null)} onDone={() => { setMoving(null); setPicked([]); }} />}
    </>
  );
}

function ScansTab({ items, go }: { items: ScanBrief[]; go: Go }) {
  if (!items.length) return <section className="panel panel-b hint">Сканов пока нет.</section>;
  return (
    <section className="panel">
      <div className="tbl-wrap">
        <table className="cat-tbl v-click">
          <thead><tr><th>Скан</th><th>Файл</th><th>Охват</th><th className="v-r">Находок</th><th>Изменения</th><th>Передача ИКТ</th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} onClick={() => go({ kind: 'scan', id: s.id })}>
                <td><b>{formatDate(s.scanDate)}</b></td><td>{s.fileName}</td><td>{s.coverageTitle || '—'} · {s.hostsCount}</td><td className="v-r">{s.findingsCount}</td>
                <td>{s.counts ? `+${s.counts.new} · повторно ${s.counts.reopened} · изм. ${s.counts.changed} · пропали ${s.counts.gone}` : '—'}</td>
                <td><IctChip handedOver={!!s.handover} date={s.handover?.date} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
const num = (r: Row, k: string) => (typeof r[k] === 'number' ? String(r[k]).replace('.', ',') : '—');

function ScanView({ id, go, me, groups }: { id: string; go: Go; me: Me; groups: VulnGroup[] }) {
  const scan = useQuery({ queryKey: vkeys.scan(id), queryFn: () => vulnsApi.scan(id) });
  const [tab, setTab] = useState<'diff' | 'rows' | 'hosts'>('diff');
  const [group, setGroup] = useState('new');
  const [handing, setHanding] = useState(false);
  const viewer = useFileViewer();
  const s = scan.data;
  if (!s) return scan.isError ? <div className="panel panel-b form-error">Скан не найден.</div> : null;
  const owner = groups.find((g) => g.nodes.some((n) => n.id === s.nodeId));
  const node = owner?.nodes.find((n) => n.id === s.nodeId);
  const canEdit = me.permissions.includes('records.edit');
  const cards = [['new', 'Новые'], ['reopened', 'Повторно'], ['changed', 'Изменились'], ['unchanged', 'Без изменений'], ['gone', 'Пропали']] as const;
  const list = (s.comparison?.groups[group] ?? []) as Row[];
  const newCount = s.counts?.new ?? 0;
  const statusLabel = (h: string) => (h === 'new' ? 'новый в охвате' : h === 'gone' ? 'выбыл из охвата' : '');
  return (
    <>
      <Crumbs parts={[
        { t: 'Уязвимости', to: { kind: 'root' } },
        ...(owner ? [{ t: owner.name, to: { kind: 'group' as const, id: owner.id } }] : []),
        ...(node ? [{ t: node.label, to: { kind: 'node' as const, id: node.id } }] : []),
        { t: `Скан ${formatDate(s.scanDate)}` },
      ]} go={go} />
      <div className="head"><div><h1>Скан {formatDate(s.scanDate)}</h1><p>{s.fileName}{s.legacyArchived ? ' · в архиве' : ''}</p></div></div>
      <div className="v-facts">
        <div><span>Охват</span><b>{s.coverageTitle || '—'}</b></div>
        <div><span>Хостов</span><b>{s.hostsCount}</b></div>
        <div><span>Находок</span><b>{s.findingsCount}</b></div>
        <div><span>Загрузил</span><b>{s.createdBy}</b></div>
        {s.critCounts.map((c) => <div key={c.key}><span>Новых: {c.label.toLowerCase()}</span><b>{c.count}</b></div>)}
        {s.fileId && <button className="btn sm" type="button" onClick={() => void viewer.open({ id: s.fileId as string, name: s.fileName, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })}>Файл отчёта</button>}
      </div>
      {s.handover
        ? (
          <div className="note v-ok">
            Передан ИКТ <b>{formatDate(s.handover.date)}</b> · {s.handover.by} → {s.handover.to}.
            {s.handover.fileId && <button className="btn ghost sm" type="button" onClick={() => void viewer.open({ id: s.handover?.fileId as string, name: 'Письмо передачи', mime: '' })}>Письмо</button>}
          </div>
        )
        : (
          <div className="note v-warn row v-between">
            <span>Отчёт ещё не передан ИКТ. Срок по {newCount ? `новым уязвимостям (${newCount})` : 'записям скана'} начнётся с даты передачи.</span>
            {canEdit && <button className="btn sm primary" type="button" onClick={() => setHanding(true)}>Передать ИКТ</button>}
          </div>
        )}
      <div className="tabs page-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'diff'} onClick={() => setTab('diff')}>Сравнение</button>
        <button type="button" role="tab" aria-selected={tab === 'rows'} onClick={() => setTab('rows')}>Находки · {s.findingsCount}</button>
        <button type="button" role="tab" aria-selected={tab === 'hosts'} onClick={() => setTab('hosts')}>Охват · {s.hostsCount}</button>
      </div>
      {tab === 'diff' && !s.comparison && <div className="note ro">Отчёт прежнего реестра: файл не хранился, снимка и сравнения нет.</div>}
      {tab === 'diff' && s.comparison && (
        <>
          <div className="v-dcards">
            {cards.map(([k, t]) => (
              <button key={k} type="button" className={`v-dcard k-${k}`} aria-pressed={group === k} onClick={() => setGroup(k)}>
                <b>{s.counts?.[k] ?? 0}</b><span>{t}</span>
              </button>
            ))}
          </div>
          <section className="panel">
            <div className="tbl-wrap">
              <table className="cat-tbl">
                <thead><tr><th>Пакет / идентификатор</th><th>{group === 'changed' ? 'Что изменилось' : 'Решение при импорте'}</th></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const changes = (r.changes ?? []) as { label: string; from: string; to: string }[];
                    return (
                      <tr key={str(r, 'key')}>
                        <td className="v-pk"><b>{str(r, 'pkg')}</b><span>{str(r, 'cve')}{typeof r.number === 'number' ? ` · #${r.number}` : ''}</span></td>
                        <td>
                          {changes.map((c) => <div key={c.label} className="v-chg">{c.label}: {c.from || '—'} → <b>{c.to || '—'}</b></div>)}
                          {group === 'gone' ? <span className={`chip ${r.selected ? 'low' : ''}`}>{r.selected ? 'Отмечена устранённой' : 'Оставлена открытой'}</span>
                            : group !== 'unchanged' && !r.selected ? <span className="chip">Не выбрано</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                  {!list.length && <tr><td colSpan={2} className="hint">В этой группе пусто.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="v-cnt">Сравнение с реестром узла по ключу «Пакет + Идентификатор» на момент импорта.</div>
          </section>
        </>
      )}
      {tab === 'rows' && (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="cat-tbl v-recs">
              <thead><tr><th>Пакет / идентификатор</th><th>Уровень</th><th className="v-r">CVSS</th><th className="v-r">Оценка</th><th>Критичность</th><th>Эксплойт</th><th>Сетевой вектор</th><th className="v-r">Обн.</th></tr></thead>
              <tbody>
                {(s.findings as Row[]).map((f) => (
                  <tr key={str(f, 'key')}>
                    <td className="v-pk"><b>{str(f, 'pkg')}</b><span>{str(f, 'cve')}</span></td>
                    <td>{str(f, 'level') || '—'}</td><td className="v-r">{num(f, 'cvss')}</td><td className="v-r"><b>{num(f, 'score')}</b></td>
                    <td><span className={`chip ${CRIT_TONE[str(f, 'crit')] ?? ''}`}>{str(f, 'critLabel')}</span></td>
                    <td>{str(f, 'exploit') || '—'}</td><td>{str(f, 'vector') || '—'}</td><td className="v-r">{num(f, 'hits')}</td>
                  </tr>
                ))}
                {!s.findings.length && <tr><td colSpan={8} className="hint">Снимка нет: файл отчёта прежнего реестра не хранился.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="v-cnt">Снимок файла как он был загружен. Оценка и критичность посчитаны порталом, значение «Оценка» из файла не используется.</div>
        </section>
      )}
      {tab === 'hosts' && (
        <section className="panel">
          <div className="panel-h"><h3>{s.coverageTitle || 'Охват скана'}</h3><span className="hint">Хосты не связаны с находками: это только то, что сканировали</span></div>
          <div className="tbl-wrap">
            <table className="cat-tbl">
              <thead><tr><th>Имя хоста</th><th>IP-адрес</th><th>ОС</th><th /></tr></thead>
              <tbody>
                {s.hosts.map((h) => (
                  <tr key={`${h.name}-${h.status}`}>
                    <td>{h.name}</td><td className="mono">{h.ip}</td><td>{h.os}</td>
                    <td>{h.status !== 'same' && <span className={`chip ${h.status === 'new' ? 'acc' : 'high'}`}>{statusLabel(h.status)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {handing && <HandoverDialog scan={s} count={newCount} onClose={() => setHanding(false)} />}
      {viewer.element}
    </>
  );
}

export function VulnsPage() {
  const me = useOutletContext<Me>();
  const params = useParams();
  const navigate = useNavigate();
  const view = parseView(params['*'] ?? '');
  const go = useCallback<Go>((v) => { navigate(viewPath(v)); window.scrollTo({ top: 0 }); }, [navigate]);
  const groups = useQuery({ queryKey: vkeys.groups, queryFn: vulnsApi.groups });
  const overview = useQuery({ queryKey: vkeys.overview, queryFn: vulnsApi.overview });
  const regId = overview.data?.registerId ?? '';
  const reg = useQuery({ queryKey: rkeys.detail(regId), queryFn: () => registersApi.get(regId), enabled: !!regId });
  const [newGroup, setNewGroup] = useState(false);
  const canStructure = me.permissions.includes('registers.manage');
  const gs = groups.data?.items ?? [];
  const ov = overview.data;
  const nodeGroup = view.kind === 'node' ? gs.find((g) => g.nodes.some((n) => n.id === view.id)) : undefined;
  const node = view.kind === 'node' ? nodeGroup?.nodes.find((n) => n.id === view.id) : undefined;
  const group = view.kind === 'group' ? gs.find((g) => g.id === view.id) : undefined;
  return (
    <div className="v-root">
      {ov && <Tree groups={gs} stats={ov.nodes} view={view} go={go} canManage={canStructure} onNewGroup={() => setNewGroup(true)} />}
      <div className="v-main">
        {(groups.isError || overview.isError) && <div className="panel panel-b form-error">Не удалось загрузить раздел. Обновите страницу.</div>}
        {ov && view.kind === 'root' && <RootView groups={gs} ov={ov} go={go} canManage={canStructure} onNewGroup={() => setNewGroup(true)} />}
        {ov && group && <GroupView key={group.id} group={group} ov={ov} go={go} me={me} />}
        {ov && node && nodeGroup && reg.data && (
          <NodeView key={node.id} node={node} group={nodeGroup} reg={reg.data} stats={ov.nodes.find((s) => s.nodeId === node.id) ?? NO_STATS} go={go} me={me} groups={gs} />
        )}
        {ov && view.kind === 'scan' && <ScanView key={view.id} id={view.id} go={go} me={me} groups={gs} />}
      </div>
      {newGroup && <GroupDialog onClose={() => setNewGroup(false)} onCreated={(g) => { setNewGroup(false); go({ kind: 'group', id: g.id }); }} />}
    </div>
  );
}
