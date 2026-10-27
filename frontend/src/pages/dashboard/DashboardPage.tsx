import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { dashboardApi, dashkeys } from '../../api/dashboard';
import type { Me } from '../../api/client';
import { Icon } from '../../components/Icons';
import { timeOf } from './logic';
import { TilesDrawer } from './TilesDrawer';
import { KpiCard, TilePanel, WidgetPanel } from './Widgets';

/** Дашборд отдела ИБ: KPI, плитки-счётчики и виджеты из полей реестров с ролью аналитики. */
export function DashboardPage() {
  const me = useOutletContext<Me>();
  const [tilesOpen, setTilesOpen] = useState(false);
  const kpis = useQuery({ queryKey: dashkeys.kpis, queryFn: dashboardApi.kpis, refetchInterval: 60_000 });
  const layout = useQuery({ queryKey: dashkeys.widgets, queryFn: dashboardApi.widgets, refetchInterval: 60_000 });
  const canManage = me.permissions.includes('registers.manage');

  return (
    <>
      <div className="head">
        <div>
          <h1>Дашборд отдела ИБ</h1>
          <p>Виджеты строятся сами из полей реестров, помеченных для аналитики. Щелчок по числу открывает раздел с этим фильтром.</p>
        </div>
        <div className="row">
          {canManage && <button className="btn" type="button" onClick={() => setTilesOpen(true)}>Плитки</button>}
          <Link className="btn" to="/monitor"><Icon name="monitor" /> Экран мониторинга</Link>
        </div>
      </div>

      <div className="kpis kpis-8" aria-label="Ключевые показатели">
        {kpis.isPending && <div className="hint">Загрузка…</div>}
        {kpis.isError && !kpis.data && <div className="hint">Не удалось загрузить показатели</div>}
        {kpis.data?.items.map((k) => <KpiCard key={k.key} k={k} />)}
      </div>

      {(layout.data?.tiles.length ?? 0) > 0 && (
        <div className="tiles" aria-label="Плитки-счётчики">
          {layout.data?.tiles.map((t) => <TilePanel key={t.key} w={t} />)}
        </div>
      )}

      <div className="dash">
        {layout.data?.widgets.map((w) => <WidgetPanel key={w.key} w={w} />)}
      </div>
      {kpis.data && <p className="hint dash-foot">Обновлено в {timeOf(kpis.data.computedAt)} · данные обновляются раз в минуту</p>}
      {tilesOpen && <TilesDrawer onClose={() => setTilesOpen(false)} />}
    </>
  );
}
