import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { ApiError, type Me } from '../../api/client';
import { dashboardApi, dashkeys, type Kpi, type LayoutItem, type WidgetRef } from '../../api/dashboard';
import { Icon } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { groupOf, moveEntry, patchEntry, sizeClass, timeOf, type LayoutGroup } from './logic';
import { TilesDrawer } from './TilesDrawer';
import { KpiCard, TilePanel, WidgetPanel } from './Widgets';

// Кэш последней раскладки — только чтобы экран не «прыгал» при загрузке; источник — сервер (ADR-0018).
const CACHE_KEY = 'ibportal.dashboard.layout';
function cachedItems(): LayoutItem[] | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as LayoutItem[]) : undefined;
  } catch {
    return undefined;
  }
}
function cacheItems(items: LayoutItem[]) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(items));
  } catch {
    // хранилище недоступно — просто без кэша
  }
}

const SIZES = [['s', 'S'], ['m', 'M'], ['l', 'L']] as const;

/** Дашборд отдела ИБ: KPI, плитки-счётчики и виджеты; порядок, размер и видимость — по раскладке (релиз 1.1.0). */
export function DashboardPage() {
  const me = useOutletContext<Me>();
  const qc = useQueryClient();
  const toast = useToast();
  const [tilesOpen, setTilesOpen] = useState(false);
  const kpis = useQuery({ queryKey: dashkeys.kpis, queryFn: dashboardApi.kpis, refetchInterval: 60_000 });
  const parts = useQuery({ queryKey: dashkeys.widgets, queryFn: dashboardApi.widgets, refetchInterval: 60_000 });
  const layout = useQuery({ queryKey: dashkeys.layout, queryFn: dashboardApi.layout });
  const canManage = me.permissions.includes('registers.manage');
  const canRoles = me.permissions.includes('settings.manage');

  // Режим «Настроить»: черновик раскладки — своей или роли (для settings.manage).
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<string>('me');
  const [draft, setDraft] = useState<LayoutItem[]>([]);
  const [draftVersion, setDraftVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const roles = useQuery({ queryKey: dashkeys.roleLayouts, queryFn: dashboardApi.roleLayouts, enabled: editing && canRoles });

  useEffect(() => {
    if (layout.data) cacheItems(layout.data.items);
  }, [layout.data]);

  const items = editing ? draft : layout.data?.items ?? cachedItems() ?? [];
  const kpiByKey = new Map((kpis.data?.items ?? []).map((k) => [`kpi:${k.key}`, k]));
  const partByKey = new Map<string, WidgetRef>([
    ...(parts.data?.tiles ?? []).map((t) => [t.key, t] as const),
    ...(parts.data?.widgets ?? []).map((w) => [`widget:${w.key}`, w] as const),
  ]);
  const titleOf = (key: string) => kpiByKey.get(key)?.label ?? partByKey.get(key)?.title ?? key;

  const startEdit = () => {
    setTarget('me');
    setDraft(layout.data?.items ?? []);
    setDraftVersion(layout.data?.source === 'user' ? layout.data.version : 0);
    setEditing(true);
  };
  const pickTarget = async (t: string) => {
    setTarget(t);
    if (t === 'me') {
      setDraft(layout.data?.items ?? []);
      setDraftVersion(layout.data?.source === 'user' ? layout.data.version : 0);
      return;
    }
    const r = await dashboardApi.roleLayout(t);
    setDraft(r.items);
    setDraftVersion(r.version);
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: dashkeys.layout });
      await qc.invalidateQueries({ queryKey: dashkeys.roleLayouts });
      toast(ok);
      setEditing(false);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? 'Раскладку уже изменили в другой вкладке — откройте «Настроить» заново' : e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = () => void run(() => (target === 'me' ? dashboardApi.saveLayout(draftVersion, draft) : dashboardApi.saveRoleLayout(target, draftVersion, draft)),
    target === 'me' ? 'Раскладка сохранена' : 'Раскладка роли сохранена');
  const reset = () => void run(() => (target === 'me' ? dashboardApi.resetLayout() : dashboardApi.resetRoleLayout(target)),
    target === 'me' ? 'Раскладка сброшена' : 'Раскладка роли сброшена — действует системная');

  // Перетаскивание мышью: элемент под указателем той же группы — новое место.
  const dragKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const onHandleDown = (e: ReactPointerEvent, key: string) => {
    e.preventDefault();
    dragKey.current = key;
    setDragging(key);
  };
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-layout-key]');
      const over = el?.dataset.layoutKey;
      const from = dragKey.current;
      if (over && from && over !== from && groupOf(over) === groupOf(from)) setDraft((d) => moveEntry(d, from, over));
    };
    const up = () => {
      dragKey.current = null;
      setDragging(null);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  const cell = (item: LayoutItem, group: LayoutGroup, body: ReactNode) => (
    <div key={item.key} className={`lay-cell ${sizeClass(group, item.size)}${dragging === item.key ? ' dragging' : ''}`} data-layout-key={item.key}>
      {editing && (
        <div className="lay-tools" role="group" aria-label={`Настройка «${titleOf(item.key)}»`}>
          <button type="button" className="lay-handle" aria-label={`Перетащить «${titleOf(item.key)}»`} title="Перетащить" onPointerDown={(e) => onHandleDown(e, item.key)}>⠿</button>
          {group !== 'kpi' && SIZES.map(([v, l]) => (
            <button key={v} type="button" className="lay-size" aria-pressed={item.size === v} onClick={() => setDraft((d) => patchEntry(d, item.key, { size: v }))}>{l}</button>
          ))}
          <button type="button" className="lay-hide" onClick={() => setDraft((d) => patchEntry(d, item.key, { hidden: true }))}>Скрыть</button>
        </div>
      )}
      {body}
    </div>
  );
  const visible = (group: LayoutGroup) => items.filter((i) => !i.hidden && groupOf(i.key) === group);
  const kpiCells = visible('kpi').map((i) => {
    const k: Kpi | undefined = kpiByKey.get(i.key);
    return k ? cell(i, 'kpi', <KpiCard k={k} />) : null;
  });
  const tileCells = visible('tile').map((i) => {
    const w = partByKey.get(i.key);
    return w ? cell(i, 'tile', <TilePanel w={w} />) : null;
  });
  const widgetCells = visible('widget').map((i) => {
    const w = partByKey.get(i.key);
    return w ? cell(i, 'widget', <WidgetPanel w={w} bare />) : null;
  });
  const hidden = items.filter((i) => i.hidden);

  return (
    <>
      <div className="head">
        <div>
          <h1>Дашборд отдела ИБ</h1>
          <p>Виджеты строятся сами из полей реестров, помеченных для аналитики. Щелчок по числу открывает раздел с этим фильтром.</p>
        </div>
        <div className="row">
          {!editing && <button className="btn" type="button" onClick={startEdit} disabled={!layout.data}>Настроить</button>}
          {canManage && !editing && <button className="btn" type="button" onClick={() => setTilesOpen(true)}>Плитки</button>}
          <Link className="btn" to="/monitor"><Icon name="monitor" /> Экран мониторинга</Link>
        </div>
      </div>

      {editing && (
        <div className="panel lay-bar" role="toolbar" aria-label="Настройка дашборда">
          {canRoles && (
            <select className="inp sm-inp" value={target} onChange={(e) => void pickTarget(e.target.value)} aria-label="Чья раскладка">
              <option value="me">Моя раскладка</option>
              {roles.data?.items.map((r) => <option key={r.id} value={r.id}>По умолчанию для роли «{r.name}»</option>)}
            </select>
          )}
          <span className="hint">Перетащите элемент за ⠿, выберите размер или скройте. {layout.data?.source === 'role' && target === 'me' ? `Сейчас действует раскладка роли «${layout.data.role?.name}».` : ''}</span>
          <span className="row">
            <button className="btn" type="button" disabled={busy} onClick={reset}>Сбросить</button>
            <button className="btn" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
            <button className="btn primary" type="button" disabled={busy} onClick={save}>Готово</button>
          </span>
          {hidden.length > 0 && (
            <div className="lay-hidden" aria-label="Скрытые">
              <span className="hint">Скрытые:</span>
              {hidden.map((i) => (
                <button key={i.key} type="button" className="chip" onClick={() => setDraft((d) => patchEntry(d, i.key, { hidden: false }))} title="Показать">+ {titleOf(i.key)}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={`kpis kpis-8${editing ? ' lay-edit' : ''}`} aria-label="Ключевые показатели">
        {kpis.isPending && <div className="hint">Загрузка…</div>}
        {kpis.isError && !kpis.data && <div className="hint">Не удалось загрузить показатели</div>}
        {kpiCells}
      </div>

      {tileCells.some(Boolean) && (
        <div className={`tiles${editing ? ' lay-edit' : ''}`} aria-label="Плитки-счётчики">{tileCells}</div>
      )}

      <div className={`dash${editing ? ' lay-edit' : ''}`}>{widgetCells}</div>
      {kpis.data && <p className="hint dash-foot">Обновлено в {timeOf(kpis.data.computedAt)} · данные обновляются раз в минуту</p>}
      {tilesOpen && <TilesDrawer onClose={() => setTilesOpen(false)} />}
    </>
  );
}
