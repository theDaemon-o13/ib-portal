import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../../api/client';
import { dashboardApi, dashkeys, type MonitorData } from '../../api/dashboard';
import { applyThemeMode, loadThemeMode } from '../../theme/theme';
import { MONITOR_FLIP_MS, MONITOR_IDLE_MS, MONITOR_REFRESH_MS, rowsPerPage, timeOf } from '../dashboard/logic';
import { stepsOf } from './slides';
import { SlideView } from './SlideView';

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

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
 * Экран мониторинга для настенного монитора: слайды по порядку (релиз 1.1.0, ADR-0019), каждый — своё время
 * (по умолчанию 12 с), длинный список — страницами. Данные и набор слайдов обновляются раз в минуту; новый
 * набор подхватывается на границе слайда, без перезагрузки и мигания. Без связи остаются последние данные.
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

  // Показываемый набор слайдов. Новые данные того же набора — сразу; другой набор (слайды изменили в
  // настройках) — ждёт границы слайда в pending, чтобы экран не перескакивал посреди показа.
  const [shown, setShown] = useState<MonitorData | null>(null);
  const pending = useRef<MonitorData | null>(null);
  useEffect(() => {
    if (!q.data) return;
    if (!shown || shown.signature === q.data.signature) setShown(q.data);
    else pending.current = q.data;
  }, [q.data, shown]);

  const per = rowsPerPage(h, w);
  const steps = stepsOf(shown?.slides ?? [], per);
  const at = steps.length ? ((step % steps.length) + steps.length) % steps.length : 0;
  const cur = steps[at];
  const slide = cur ? shown?.slides[cur.slide] : undefined;
  const slideMs = slide ? slide.seconds * 1000 : MONITOR_FLIP_MS;

  const flip = useCallback((by: number) => {
    if (pending.current) {
      setShown(pending.current);
      pending.current = null;
      setStep(0);
    } else {
      setStep((s) => s + by);
    }
    lastFlip.current = Date.now();
  }, []);

  // Автолистание: проверка дважды в секунду, чтобы пауза и ручное листание сбрасывали отсчёт.
  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(new Date());
      if (!paused && Date.now() - lastFlip.current >= slideMs) flip(1);
    }, 500);
    return () => window.clearInterval(t);
  }, [paused, flip, slideMs]);

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
  const p2 = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="mon" data-paused={paused ? 'true' : 'false'} data-step={step} data-slide-index={cur?.slide ?? -1}>
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

      {shown && slide && cur ? (
        <SlideView key={`${slide.id}:${cur.page}`} slide={slide} page={cur.page} per={per} />
      ) : (
        <div className="mon-slide"><div className="mon-empty">{shown ? 'Нет слайдов для показа — добавьте их в «Настройки → Экран мониторинга»' : ''}</div></div>
      )}

      <div className="mon-foot">
        <span>{data ? `Обновлено в ${timeOf(data.computedAt, true)}` : ''}</span>
        <span>{paused ? 'на паузе' : `листается само каждые ${Math.round(slideMs / 1000)} с`} · ← → листать · пробел — пауза{me.kiosk ? '' : ' · Esc — выход'}</span>
      </div>

      <div className="mon-ctl" role="toolbar" aria-label="Управление мониторингом">
        <button type="button" aria-label="Предыдущая страница" onClick={() => flip(-1)}>{icons.prev}</button>
        <button type="button" className="main" aria-label={paused ? 'Продолжить' : 'Пауза'} onClick={togglePause}>{paused ? icons.play : icons.pause}</button>
        <button type="button" aria-label="Следующая страница" onClick={() => flip(1)}>{icons.next}</button>
        <span className="mon-pg">
          <span className="mono" title="Слайд из всех шагов показа">{steps.length ? at + 1 : 0}/{steps.length}</span>
          <span className={`mon-prog${paused ? ' paused' : ''}`}><i key={step} className="mon-prog-bar" style={{ animationDuration: `${slideMs}ms` }} /></span>
        </span>
        <button type="button" aria-label="На весь экран" onClick={fullscreen}>{icons.full}</button>
        <button type="button" className="x" aria-label={me.kiosk ? 'Выйти' : 'Закрыть мониторинг'} onClick={close}>{icons.close}</button>
      </div>
    </div>
  );
}
