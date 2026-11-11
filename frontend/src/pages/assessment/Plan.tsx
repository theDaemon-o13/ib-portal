// «План улучшений»: разрывы «сейчас → цель», задачи по ним и их статусы с доски, счётчики. Целевой уровень
// задаётся в чек-листе; задачи живут на общей доске, здесь — только их состояние.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Assessment } from '../../api/assessments';
import { dateRu } from '../dashboard/logic';
import { LevelPill } from './Charts';
import { GapTaskDialog } from './GapTaskDialog';
import { planCounts, sectionsOf, taskState, type Section } from './logic';

export function Plan({ a }: { a: Assessment }) {
  const navigate = useNavigate();
  const [taskFor, setTaskFor] = useState<Section | null>(null);
  const s = a.score;
  const c = planCounts(s, a.tasks);
  const sections = new Map(sectionsOf(a.methodology).map((x) => [x.code, x]));
  const canTask = a.status !== 'archived';
  const goto = (code: string) => navigate(`/assessment/checklist?id=${a.id}&dom=${sections.get(code)?.domainNo ?? 1}&sec=${code}`);

  return (
    <>
      <div className="kpis">
        <div className="kpi"><span className="v">{c.gaps}</span><span className="l">разделов с разрывом</span></div>
        <div className="kpi"><span className="v">+{c.points}</span><span className="l">баллов к итогу при достижении целей</span></div>
        <div className={`kpi${c.withoutTask ? ' warn' : ''}`}><span className="v">{c.withoutTask}</span><span className="l">разрывов без задачи</span></div>
        <div className="kpi"><span className="v">{c.done} / {c.total}</span><span className="l">задач выполнено</span></div>
      </div>
      <section className="panel">
        <div className="panel-h"><h3>Разрывы и задачи</h3><span className="hint">Целевой уровень задаётся в чек-листе. Задачи живут на общей доске «Задачи».</span></div>
        <div className="tbl-wrap">
          <table className="sa-plan">
            <thead><tr><th>Раздел</th><th>Сейчас → цель</th><th>Задача</th><th>Исполнитель</th><th>Срок</th><th>Статус задачи</th></tr></thead>
            <tbody>
              {!s.gaps.length && <tr><td colSpan={6} className="hint">Целевые уровни не заданы. Задайте их в чек-листе, и здесь появятся разрывы.</td></tr>}
              {s.gaps.map((g) => {
                const ts = a.tasks.filter((t) => t.code === g.code);
                const head = (span: number) => (
                  <>
                    <td rowSpan={span}>
                      <button className="btn ghost sm" type="button" onClick={() => goto(g.code)}><span className="sa-code">{g.code}</span> {g.name}</button>
                      {g.key && <span className="chip high">ключевой</span>}
                      {!g.inTotal && <span className="chip sa-out" title="Домен вне итога: разрыв не меняет итог КБ">вне итога</span>}
                    </td>
                    <td rowSpan={span} className="sa-nowrap"><LevelPill level={g.level} /> → <LevelPill level={g.target} /></td>
                  </>
                );
                const add = canTask && (
                  <button className="btn sm" type="button" onClick={() => setTaskFor(sections.get(g.code) ?? null)}>Создать задачу</button>
                );
                if (!ts.length) {
                  return (
                    <tr key={g.code} data-code={g.code}>
                      {head(1)}
                      <td colSpan={4}>{add || <span className="hint">Задачи нет</span>}</td>
                    </tr>
                  );
                }
                return ts.map((t, i) => {
                  const st = taskState(t);
                  return (
                    <tr key={t.id} data-code={g.code}>
                      {i === 0 && head(ts.length)}
                      <td><span className="sa-code">#{t.number}</span> {t.title}{i === ts.length - 1 && add && <div className="sa-add">{add}</div>}</td>
                      <td>{t.assignee ?? '—'}</td>
                      <td className="num">{t.dueDate ? dateRu(t.dueDate) : '—'}</td>
                      <td><span className={`chip ${st.tone}`}>{st.text}</span></td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </section>
      {taskFor && <GapTaskDialog a={a} s={taskFor} onClose={() => setTaskFor(null)} />}
    </>
  );
}
