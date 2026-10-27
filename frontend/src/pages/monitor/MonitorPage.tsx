import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../../api/client';
import { dashboardApi, dashkeys, type Kpi, type MonitorItem, type MonitorVuln } from '../../api/dashboard';
import { applyThemeMode, loadThemeMode } from '../../theme/theme';
import {
  barWidth, dateRu, daysBox, daysText, MONITOR_FLIP_MS, MONITOR_IDLE_MS, MONITOR_REFRESH_MS, pageOf, rowsPerPage, timeOf,
} from '../dashboard/logic';

/** KPI на стене — по порядку; «на проверке» оставлен дашборду. */
const WALL_KPIS: Kpi['key'][] = [
  'vulns_open', 'vulns_overdue', 'vulns_soon', 'incidents_30d', 'tasks_overdue', 'docs_review', 'risks_no_decision', 'evidence_expiring',
];
const KIND_NAMES: Record<MonitorItem['kind'], string> = { task: 'Задача', document: 'Документ', risk: 'Риск ИБ', evidence: 'Доказательство' };
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function Days({ days }: { days: number | null }) {
  const d = daysBox(days);
  return <div className={`days ${d.tone}`}><b>{d.value}</b><span>{d.caption}</span></div>;
}

function useViewport() {
  const [size, setSize] = useState(() => ({ h: window.innerHeight || 900, w: window.innerWidth || 1600 }));
  useEffect(() => {
    const on = () => setSize({ h: window.innerHeight, w: window.innerWidth });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** Экран не гаснет, пока открыт мониторинг (Wake Lock); после возврата на вкладку — запросить снова. */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let alive = true;
    const request = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') {
          const l = await wl.request('screen');
          if (alive) lock = l;
          else void l.release();
        }
      } catch {
        // браузер не дал (энергосбережение, нет HTTPS) — экран просто может погаснуть
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void request(); };
    void request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

/** Чёрная тема по умолчанию: если в переключателе «Авто», на время мониторинга — «Чёрная». */
function useWallTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const mode = loadThemeMode(window.localStorage);
    if (mode === 'auto') applyThemeMode(root, 'dark');
    return () => applyThemeMode(root, mode);
  }, []);
}

const icons = {
  prev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>,
  next: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>,
  pause: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>,
  play: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>,
  full: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
};

/**
 * Экран мониторинга для настенного монитора: один экран без прокрутки, страницы листаются каждые 12 с,
 * данные обновляются раз в минуту; без связи с сервером остаются последние данные и плашка «Нет связи».
 */
export function MonitorPage({ me }: { me: Me }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: dashkeys.monitor,
    queryFn: dashboardApi.monitor,
    refetchInterval: MONITOR_REFRESH_MS,
    refetchIntervalInBackground: true,
    retry: 1,
  });
  const { h, w } = useViewport();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [idle, setIdle] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const lastFlip = useRef(Date.now());
  const idleTimer = useRef<number | undefined>(undefined);
  useWakeLock();
  useWallTheme();

  const flip = useCallback((by: number) => {
    setStep((s) => s + by);
    lastFlip.current = Date.now();
  }, []);

  // Автолистание: проверка дважды в секунду, чтобы пауза и ручное листание сбрасывали отсчёт.
  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(new Date());
      if (!paused && Date.now() - lastFlip.current >= MONITOR_FLIP_MS) flip(1);
    }, 500);
    return () => window.clearInterval(t);
  }, [paused, flip]);

  // Панель управления прячется без движения мыши.
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), MONITOR_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    const evs = ['mousemove', 'pointerdown', 'touchstart'] as const;
    evs.forEach((e) => document.addEventListener(e, wake, { passive: true }));
    return () => {
      evs.forEach((e) => document.removeEventListener(e, wake));
      window.clearTimeout(idleTimer.current);
    };
  }, [wake]);
  useEffect(() => {
    document.body.classList.toggle('mon-idle', idle);
    return () => document.body.classList.remove('mon-idle');
  }, [idle]);

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => { qc.clear(); navigate('/login', { replace: true }); },
  });
  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (me.kiosk) {
      if (window.confirm('Выйти из учётной записи настенного монитора?')) logout.mutate();
      return;
    }
    navigate('/dashboard');
  }, [me.kiosk, logout, navigate]);
  const togglePause = useCallback(() => {
    setPaused((p) => !p);
    lastFlip.current = Date.now();
  }, []);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.matches('input,textarea,select')) return;
      if (e.key === 'ArrowRight') flip(1);
      else if (e.key === 'ArrowLeft') flip(-1);
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.key === 'Escape' && !me.kiosk) close();
      else return;
      wake();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flip, togglePause, close, wake, me.kiosk]);

  const data = q.data;
  // Нет связи: запрос упал или браузер считает сеть отключённой (TanStack Query тогда ставит запрос на паузу).
  const offline = !!data && (q.isError || q.fetchStatus === 'paused');
  const per = rowsPerPage(h, w);
  const vulns = pageOf<MonitorVuln>(data?.vulns?.items ?? [], per, step);
  const side = pageOf<MonitorItem>(data?.items ?? [], Math.max(3, per - 1), step);
  const kpis = WALL_KPIS.map((k) => data?.kpis.find((x) => x.key === k)).filter((k): k is Kpi => !!k);
  const buckets = data?.vulns?.buckets ?? [];
  const p2 = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="mon" data-paused={paused ? 'true' : 'false'} data-step={step}>
      <div className="mon-top">
        <div><div className="eyebrow">Отдел информационной безопасности</div><h1>Мониторинг ИБ</h1></div>
        <div className="mon-time">
          <span className="mon-date">{WEEKDAYS[now.getDay()]}, {p2(now.getDate())}.{p2(now.getMonth() + 1)}.{now.getFullYear()}</span>
          <span className="mon-clock">{p2(now.getHours())}:{p2(now.getMinutes())}</span>
        </div>
      </div>

      {offline && (
        <div className="mon-offline" role="status">
          Нет связи с сервером портала · на экране данные на {timeOf(data?.computedAt)} · повторим через минуту
        </div>
      )}
      {!data && q.isPending && <div className="mon-offline mon-wait" role="status">Загрузка данных…</div>}
      {!data && q.isError && <div className="mon-offline" role="status">Нет связи с сервером портала · повторим через минуту</div>}

      <div className="mon-kpis" aria-label="Ключевые показатели">
        {kpis.map((k) => (
          <div key={k.key} className={`mk ${k.tone ?? ''}`} data-kpi={k.key}>
            <div className="l" title={k.label}>{k.label}</div>
            <div className="v">{k.value ?? '—'}</div>
          </div>
        ))}
      </div>

      <div className="mon-main">
        <section className="mp" aria-label="Уязвимости: дни до срока устранения">
          <div className="mp-h"><span>Уязвимости: дни до срока устранения</span><span className="mono pg">{vulns.pages > 1 ? `стр. ${vulns.page + 1} из ${vulns.pages}` : ''}</span></div>
          <div className="mp-b">
            {data && !data.vulns && <div className="hint">Реестр уязвимостей не настроен</div>}
            {data?.vulns && vulns.items.length === 0 && <div className="hint">Открытых уязвимостей нет</div>}
            {vulns.items.map((v) => (
              <div key={v.id} className="mrow">
                <Days days={v.days} />
                <div className="min0">
                  <div className="t1">{v.title} <span>{v.pkg}</span></div>
                  <div className="t2">{v.desc}</div>
                </div>
                <div className="mr">
                  {v.crit && <span className={`chip ${v.crit.tone ?? ''}`}>{v.crit.label}</span>}
                  <span className="mono">{v.hits ? `${v.hits} ПК · ` : ''}{v.due ? `до ${dateRu(v.due)}` : 'без срока'}</span>
                </div>
              </div>
            ))}
          </div>
          {vulns.pages > 1 && <div className="pdots" aria-hidden="true">{Array.from({ length: vulns.pages }, (_, i) => <i key={i} className={i === vulns.page ? 'on' : ''} />)}</div>}
        </section>

        <div className="mcol">
          <section className="mp" aria-label="Сроки устранения">
            <div className="mp-h"><span>Сроки устранения</span><span className="mono pg">{data?.vulns ? `${data.vulns.total} откр.` : ''}</span></div>
            <div className="mp-b">
              <div className="bars">
                {buckets.map((b) => (
                  <div key={b.key} className="bar">
                    <span className="t">{b.label}</span>
                    <span className="track"><span className={`fill${b.tone ? ` c-${b.tone}` : ''}`} style={{ width: `${barWidth(b.count, buckets)}%` }} /></span>
                    <span className="n">{b.count}</span>
                  </div>
                ))}
              </div>
              <div className="mdates">
                {data?.vulns?.dates.map((d) => (
                  <div key={d.date} className="md">
                    <span className="mono">{dateRu(d.date)}</span>
                    <span className={d.days < 0 ? 'neg' : d.days <= 7 ? 'warn' : ''}>{daysText(d.days)}</span>
                    <b className="mono">{d.count}</b>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section className="mp" aria-label="Открытые по пакетам">
            <div className="mp-h"><span>Открытые по пакетам</span></div>
            <div className="mp-b">
              <div className="bars">
                {data?.vulns?.packages.map((p) => (
                  <div key={p.label} className="bar">
                    <span className="t" title={p.label}>{p.label}</span>
                    <span className="track"><span className="fill" style={{ width: `${barWidth(p.count, data.vulns?.packages ?? [])}%` }} /></span>
                    <span className="n">{p.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <section className="mp" aria-label="Задачи, документы, риски, доказательства: дни">
          <div className="mp-h"><span>Задачи, документы, риски, доказательства</span><span className="mono pg">{side.pages > 1 ? `стр. ${side.page + 1} из ${side.pages}` : ''}</span></div>
          <div className="mp-b">
            {data && side.items.length === 0 && <div className="hint">Сроков нет</div>}
            {side.items.map((o) => (
              <div key={`${o.kind}:${o.id}`} className="mrow mrow-2">
                <Days days={o.days} />
                <div className="min0">
                  <div className="t1">{o.title}</div>
                  <div className="t2">{KIND_NAMES[o.kind]} · {o.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="mon-foot">
        <span>{data ? `Обновлено в ${timeOf(data.computedAt, true)}` : ''}</span>
        <span>{paused ? 'на паузе' : 'листается само каждые 12 с'} · ← → листать · пробел — пауза{me.kiosk ? '' : ' · Esc — выход'}</span>
      </div>

      <div className="mon-ctl" role="toolbar" aria-label="Управление мониторингом">
        <button type="button" aria-label="Предыдущая страница" onClick={() => flip(-1)}>{icons.prev}</button>
        <button type="button" className="main" aria-label={paused ? 'Продолжить' : 'Пауза'} onClick={togglePause}>{paused ? icons.play : icons.pause}</button>
        <button type="button" aria-label="Следующая страница" onClick={() => flip(1)}>{icons.next}</button>
        <span className="mon-pg">
          <span className="mono">{vulns.page + 1}/{vulns.pages}</span>
          <span className={`mon-prog${paused ? ' paused' : ''}`}><i key={step} className="mon-prog-bar" /></span>
        </span>
        <button type="button" aria-label="На весь экран" onClick={fullscreen}>{icons.full}</button>
        <button type="button" className="x" aria-label={me.kiosk ? 'Выйти' : 'Закрыть мониторинг'} onClick={close}>{icons.close}</button>
      </div>
    </div>
  );
}
