// Презентация самооценки (Д5, docs/self-assessment.md, раздел 10): шесть слайдов на весь экран из тех же графиков,
// что на «Обзоре». ← → и пробел — листать, Esc — выход; панель слева внизу — как у экрана мониторинга.
// Подпись справа внизу на каждом слайде: «Спроектировано: <из настроек>» и «Подготовил: <ФИО из сессии>»; кнопок у неё нет.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { akeys, assessmentsApi, type Assessment } from '../../api/assessments';
import { Overlay } from '../../components/Overlay';
import { dateRu } from '../dashboard/logic';
import { DomainBars, Donut, LevelPill, Radar, RadarLegend, Scale } from './Charts';
import { deltaTone, flipSlide, PRESENTATION_SLIDES, shortTitle, signed, taskState, weakSections } from './logic';

const icons = {
  prev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>,
  next: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>,
  full: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
};

function Slides({ a, i }: { a: Assessment; i: number }): ReactNode {
  const m = a.methodology;
  const s = a.score;
  const prev = a.previous;
  const delta = prev ? s.total - prev.total : null;
  const top = m.scale.at(-1)?.level ?? 4;
  switch (i) {
    case 0: {
      const description = m.maturity.find((x) => x.code === s.level.code)?.description ?? '';
      return (
        <div className="sa-ps-title">
          <div className="hint">
            {[a.profile.organization, dateRu(a.assessedOn)].filter(Boolean).join(' · ')}
            {a.finalizedAt === null && <b className="sa-ps-pre"> · предварительно</b>}
          </div>
          <h1>{a.title}</h1>
          <div className="sa-ps-big"><b>{s.total}</b><span>из {s.max}</span></div>
          <div className="sa-ps-lvl">{s.level.name}</div>
          {description && <p>{description}</p>}
          {prev && delta !== null && <div className={`sa-delta ${deltaTone(delta)} sa-ps-delta`}>{signed(delta)} баллов к «{shortTitle(prev.title)}»</div>}
        </div>
      );
    }
    case 1:
      return (
        <>
          <h2>Где мы на шкале</h2>
          <div className="sa-ps-scale"><Scale m={m} total={s.total} prevTotal={prev?.total} /></div>
          <div className="sa-keys sa-ps-keys">
            <div className="hint">«{m.maturity.at(-1)?.name}» требует {m.maturity.at(-1)?.min}+ баллов и {top} в ключевых разделах</div>
            {s.keySections.map((k) => (
              <div key={k.code} className="sa-key">
                <span className={k.level === top ? 'sa-ok' : 'sa-no'}>{k.level === top ? '✓' : '✗'}</span>
                <span><span className="sa-code">{k.code}</span> {k.name}</span>
                <LevelPill level={k.level} />
              </div>
            ))}
          </div>
        </>
      );
    case 2:
      return (
        <>
          <h2>Профиль по доменам</h2>
          <RadarLegend title={shortTitle(a.title)} prevTitle={prev ? shortTitle(prev.title) : null} hasTarget={s.domains.some((d) => d.targetAvg !== null)} />
          <div className="sa-ps-chart"><Radar score={s} prev={prev?.domains.map((d) => d.avg)} /></div>
        </>
      );
    case 3:
      return (
        <>
          <h2>Средний балл по доменам</h2>
          <div className="sa-ps-bars"><DomainBars score={s} prev={prev} /></div>
        </>
      );
    case 4: {
      const weak = weakSections(m, a.answers);
      return (
        <>
          <h2>Распределение ответов и слабые места</h2>
          <div className="sa-ps-two">
            <div><Donut m={m} dist={s.distribution} /></div>
            <div>
              {weak.length ? weak.slice(0, 7).map((w) => (
                <div key={w.code} className="sa-ps-w">
                  <span className="sa-code">{w.code}</span><span>{w.name}</span>
                  {w.key ? <span className="chip high">ключевой</span> : <span />}
                </div>
              )) : <p className="hint">Разделов на базовом уровне нет.</p>}
            </div>
          </div>
        </>
      );
    }
    default:
      return (
        <>
          <h2>План улучшений</h2>
          {s.gaps.length ? (
            <>
              <div className="sa-ps-plan">
                {s.gaps.map((g) => {
                  const t = a.tasks.find((x) => x.code === g.code && !x.deleted);
                  return (
                    <div key={g.code} className="sa-ps-w">
                      <span className="sa-code">{g.code}</span><span>{g.name}</span>
                      <span className="row sa-nowrap"><LevelPill level={g.level} /> → <LevelPill level={g.target} /></span>
                      <span className="hint">{t ? taskState(t).text : 'задачи нет'}</span>
                    </div>
                  );
                })}
              </div>
              <p className="hint">При достижении целей: +{s.gapPoints} баллов.</p>
            </>
          ) : <p className="hint">Целевые уровни не заданы.</p>}
        </>
      );
  }
}

export function Presentation({ a, preparedBy, onClose }: { a: Assessment; preparedBy: string; onClose: () => void }) {
  const [i, setI] = useState(0);
  const sign = useQuery({ queryKey: akeys.presentation, queryFn: assessmentsApi.presentationSettings, staleTime: 0 });
  const n = PRESENTATION_SLIDES.length;
  const flip = useCallback((d: number) => setI((x) => flipSlide(x, d, n)), [n]);
  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onClose();
  }, [onClose]);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.code === 'Space') { e.preventDefault(); flip(1); }
      else if (e.key === 'ArrowLeft') flip(-1);
      else if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    // Страница под презентацией не прокручивается.
    document.body.classList.add('sa-ps-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sa-ps-open');
    };
  }, [flip, close]);

  return (
    <Overlay>
      <div className="sa-pres" role="dialog" aria-modal="true" aria-label="Презентация самооценки" data-slide={i}>
        <div className="sa-ps-slide"><Slides a={a} i={i} /></div>
        <div className="sa-ps-sign" data-testid="sa-signature">
          <div>Спроектировано: {sign.data?.signature ?? ''}</div>
          <div>Подготовил: {preparedBy}</div>
        </div>
        <div className="sa-ps-ctl mon-ctl" role="toolbar" aria-label="Управление презентацией">
          <button type="button" aria-label="Назад" disabled={i === 0} onClick={() => flip(-1)}>{icons.prev}</button>
          <span className="sa-ps-pg">{i + 1} / {n} · {PRESENTATION_SLIDES[i]}</span>
          <button type="button" aria-label="Вперёд" disabled={i === n - 1} onClick={() => flip(1)}>{icons.next}</button>
          <button type="button" aria-label="На весь экран" onClick={fullscreen}>{icons.full}</button>
          <button type="button" className="x" aria-label="Закрыть презентацию" onClick={close}>{icons.close}</button>
        </div>
      </div>
    </Overlay>
  );
}
