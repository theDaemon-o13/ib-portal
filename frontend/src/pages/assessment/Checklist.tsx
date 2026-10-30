// «Чек-лист»: слева домены с заполненностью и средним, справа карточки разделов. Ответ сохраняется сразу, итог
// пересчитывает backend. Вне черновика — только просмотр с пояснением.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { akeys, assessmentsApi, type Answer, type AnswerPatch, type Assessment, type SaveAnswerResult } from '../../api/assessments';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { GapTaskDialog } from './GapTaskDialog';
import { changedText, LEVELS, levelName, logText, n1, type Section, sectionsOf, taskState } from './logic';

/** Ответ сервера — в кэш оценки: ответ раздела, итог и версия оценки. */
function applySaved(old: Assessment | undefined, code: string, res: SaveAnswerResult): Assessment | undefined {
  if (!old || !res.answer) return old;
  const saved = res.answer;
  const s = res.score;
  return {
    ...old,
    version: res.version,
    answers: old.answers.map((x) => (x.code === code ? saved : x)),
    score: s,
    total: s.total, max: s.max, answered: s.answered, sections: s.sections, preliminary: s.preliminary, level: s.level,
  };
}

function useSaveAnswer(a: Assessment) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ code, body }: { code: string; body: AnswerPatch }) => assessmentsApi.saveAnswer(a.id, code, body),
    onSuccess: async (res, { code }) => {
      qc.setQueryData<Assessment>(akeys.one(a.id), (old) => applySaved(old, code, res));
      toast(`Сохранено. Итог ${res.score.total} из ${res.score.max}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: akeys.list }),
        qc.invalidateQueries({ queryKey: akeys.log(a.id) }),
        qc.invalidateQueries({ queryKey: akeys.history(a.id, code) }),
      ]);
    },
    onError: async (err) => {
      await qc.invalidateQueries({ queryKey: akeys.one(a.id) });
      toast(err instanceof ApiError && err.code === 'VERSION_CONFLICT'
        ? 'Ответ уже изменился. Обновили — проверьте и повторите'
        : err instanceof Error ? err.message : 'Не удалось сохранить ответ', 'error');
    },
  });
}

function SectionHistory({ a, code }: { a: Assessment; code: string }) {
  const h = useQuery({ queryKey: akeys.history(a.id, code), queryFn: () => assessmentsApi.history(a.id, code) });
  if (h.isPending) return <div className="hint">Загрузка…</div>;
  if (h.isError) return <div className="hint">Не удалось загрузить историю: {h.error.message}</div>;
  if (!h.data.items.length) return <div className="hint">Изменений ещё не было.</div>;
  return (
    <div className="sa-log">
      {h.data.items.map((e) => <div key={e.id}><span>{formatDateTime(e.at)}</span>{logText(e.summary, a.title)} · {e.actor}</div>)}
    </div>
  );
}

function SectionCard({ a, s, answer, editable, flash, save, busy }: {
  a: Assessment; s: Section; answer: Answer; editable: boolean; flash: boolean;
  save: (code: string, body: Omit<AnswerPatch, 'version'>) => void; busy: boolean;
}) {
  const [history, setHistory] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const tasks = a.tasks.filter((t) => t.code === s.code && !t.deleted);
  const m = a.methodology;
  const gap = answer.targetLevel !== null && answer.targetLevel > (answer.level ?? 0);
  return (
    <article className={`panel sa-sec${flash ? ' flash' : ''}`} id={`sec-${s.code}`} data-code={s.code}>
      <div className="sa-sec-h">
        <h3><span className="sa-code">{s.code}</span>{s.name}</h3>
        <div className="row">
          {s.key && <span className="chip high">ключевой</span>}
          {answer.level ? <span className="chip acc">{answer.level} · {levelName(m, answer.level)}</span> : <span className="chip crit">нет ответа</span>}
          {gap && <span className="chip low">цель {answer.targetLevel}</span>}
        </div>
      </div>
      <details className="sa-target"><summary>Целевое состояние</summary><p>{s.target}</p></details>
      <div className="sa-opts" role="group" aria-label={`Уровень раздела ${s.code}`}>
        {LEVELS.map((l) => (
          <button key={l} type="button" className={`sa-opt${answer.targetLevel === l ? ' tgt' : ''}`} aria-pressed={answer.level === l}
            disabled={!editable || busy} onClick={() => save(s.code, { level: answer.level === l ? null : l })}
            title={editable && answer.level === l ? 'Щелчок ещё раз снимает ответ' : undefined}>
            <span className="oh"><i>{l}</i>{levelName(m, l)}{answer.targetLevel === l && answer.level !== l && <span className="chip low">цель</span>}</span>
            <span className="ot">{s.criteria[String(l)] ?? ''}</span>
          </button>
        ))}
      </div>
      <div className="sa-sec-f">
        <label className="fd-label">Целевой уровень
          <select className="inp" value={answer.targetLevel ?? ''} disabled={!editable || busy}
            onChange={(e) => save(s.code, { targetLevel: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l} · {levelName(m, l)}</option>)}
          </select>
        </label>
        <label className="fd-label">Комментарий
          {/* key — версия ответа: после сохранения или перечитывания поле показывает текст с сервера. */}
          <textarea key={answer.version} className="inp" rows={2} maxLength={4000} defaultValue={answer.comment} disabled={!editable}
            placeholder={editable ? 'Обоснование ответа, ссылки на документы' : ''}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (editable && v !== answer.comment) save(s.code, { comment: v });
            }} />
        </label>
      </div>
      <div className="sa-sec-x">
        <div className="sa-tasks">
          {tasks.map((t) => {
            const st = taskState(t);
            return <span key={t.id} className={`chip ${st.tone}`} title={`${t.title} · ${t.assignee ?? 'без исполнителя'}`}>#{t.number} · {st.text}</span>;
          })}
          {a.status !== 'archived' && <button className="btn sm" type="button" onClick={() => setTaskOpen(true)}>Создать задачу</button>}
        </div>
        <div className="row">
          <span className="hint">{changedText(answer)}</span>
          <button className="btn ghost sm" type="button" aria-expanded={history} onClick={() => setHistory(!history)}>
            {history ? 'Скрыть историю' : 'История раздела'}
          </button>
        </div>
      </div>
      {history && <div className="sa-sec-hist"><SectionHistory a={a} code={s.code} /></div>}
      {taskOpen && <GapTaskDialog a={a} s={s} onClose={() => setTaskOpen(false)} />}
    </article>
  );
}

export function Checklist({ a }: { a: Assessment }) {
  const [params, setParams] = useSearchParams();
  const m = a.methodology;
  const dom = Number(params.get('dom')) || m.domains[0]?.no || 1;
  const sec = params.get('sec');
  const domain = m.domains.find((d) => d.no === dom) ?? m.domains[0];
  const ds = a.score.domains.find((d) => d.no === domain?.no);
  const editable = a.status === 'draft';
  const by = new Map(a.answers.map((x) => [x.code, x]));
  const sections = sectionsOf(m).filter((x) => x.domainNo === domain?.no);
  const saver = useSaveAnswer(a);
  const [pending, setPending] = useState<string | null>(null);
  const save = (code: string, body: Omit<AnswerPatch, 'version'>) => {
    const cur = by.get(code);
    if (!cur) return;
    setPending(code);
    saver.mutate({ code, body: { ...body, version: cur.version } }, { onSettled: () => setPending(null) });
  };

  // Переход из «Обзора» к разделу: прокрутить и подсветить.
  useEffect(() => {
    if (sec) document.getElementById(`sec-${sec}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [sec, dom]);

  const pick = (no: number) => setParams({ id: a.id, dom: String(no) }, { replace: true });
  const why = a.status === 'final' ? 'Оценка зафиксирована. Чтобы изменить ответы, верните её в черновик.'
    : a.status === 'archived' ? 'Оценка в архиве: только просмотр.' : '';

  if (!domain) return null;
  return (
    <div className="sa-cl">
      <nav className="panel sa-doms" aria-label="Домены">
        {a.score.domains.map((d) => (
          <button key={d.no} type="button" aria-pressed={d.no === domain.no} onClick={() => pick(d.no)}>
            <b>{d.no}. {d.name}</b>
            <span className="avg">{n1(d.avg)}</span>
            <small>{d.answered}/{d.sections} · {d.sum} из {d.max}</small>
            <span className="sa-prog"><i className={d.answered === d.sections ? 'full' : ''} style={{ width: `${(d.answered / d.sections) * 100}%` }} /></span>
          </button>
        ))}
      </nav>
      <div className="sa-secs">
        <div className="sa-dom-h">
          <h2>{domain.no}. {domain.name}</h2>
          <span className="hint">Сумма {ds?.sum ?? 0} из {ds?.max ?? 0} · средний {n1(ds?.avg)}</span>
        </div>
        {why ? <div className="note ro">{why}</div> : (
          <div className="note">
            Выберите один вариант на раздел. Идите от базового уровня к продвинутому: критерий выполнен, если описание совпадает
            с текущим состоянием на {m.rules.criterionThresholdPct}% и более. Сохраняется сразу.
          </div>
        )}
        {sections.map((s) => {
          const answer = by.get(s.code);
          return answer ? (
            <SectionCard key={s.code} a={a} s={s} answer={answer} editable={editable} flash={sec === s.code} save={save} busy={pending === s.code} />
          ) : null;
        })}
      </div>
    </div>
  );
}
