// Раздел «Самооценка» (этап Д, docs/self-assessment.md, раздел 10): личный раздел по праву assessment.manage.
// Шапка — выбор оценки, статус и действия; вкладки «Обзор», «Чек-лист», «План улучшений», «История». Расчёт итога — на backend.
import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { akeys, assessmentsApi, type Assessment } from '../../api/assessments';
import type { Me } from '../../api/client';
import { dateRu } from '../dashboard/logic';
import { Checklist } from './Checklist';
import { ArchiveDialog, NewAssessmentDialog, ProfileDialog, ReopenDialog, UpgradeDialog } from './Dialogs';
import { History } from './History';
import { ImportDialog } from './ImportDialog';
import { defaultAssessmentId, STATUS_TONE } from './logic';
import { Overview } from './Overview';
import { Plan } from './Plan';
import { Presentation } from './Presentation';
import { useAssessmentAction } from './useAssessmentAction';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';

const TABS = [
  { key: 'overview', title: 'Обзор' },
  { key: 'checklist', title: 'Чек-лист' },
  { key: 'plan', title: 'План улучшений' },
  { key: 'history', title: 'История' },
] as const;
type Tab = (typeof TABS)[number]['key'];

type Dialog = 'new' | 'reopen' | 'profile' | 'import' | 'present' | 'upgrade' | { archive: { id: string; title: string; version: number } } | null;

export function AssessmentPage() {
  const me = useOutletContext<Me>();
  const { tab = 'overview' } = useParams();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const list = useQuery({ queryKey: akeys.list, queryFn: assessmentsApi.list });
  const items = list.data?.items ?? [];
  const id = params.get('id') ?? defaultAssessmentId(items);
  const one = useQuery({ queryKey: akeys.one(id ?? ''), queryFn: () => assessmentsApi.get(id ?? ''), enabled: !!id });
  const a = one.data;
  const open = (next: string) => setParams({ id: next }, { replace: true });

  const finalize = useAssessmentAction(
    (x: Assessment) => assessmentsApi.finalize(x.id, x.version),
    (x) => `Оценка зафиксирована: ${x.total} из ${x.max}, «${x.level.name}»`,
  );
  const hasDraft = items.some((x) => x.status === 'draft');
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  // Выгрузка — все оценки, кроме архивных: плоские таблицы для сводных и Power BI.
  const exportXlsx = async () => {
    setExporting(true);
    try {
      const { blob, fileName } = await assessmentsApi.exportFile();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выгрузить', 'error');
    } finally {
      setExporting(false);
    }
  };

  if (!TABS.some((t) => t.key === tab)) return <Navigate to="/assessment/overview" replace />;

  return (
    <>
      <div className="head">
        <div>
          <h1>Самооценка уровня кибербезопасности</h1>
          <p>Личный раздел. Экспресс-оценка по доменам и разделам методики: баллы 1–4, итог из 96 и уровень считаются сами; домены вне итога — отдельно.</p>
        </div>
      </div>

      {list.isPending ? <div className="hint sa-wait">Загрузка…</div>
        : list.isError ? <div className="note sa-warn">Не удалось загрузить оценки: {list.error.message}</div>
          : !items.length ? (
            <div className="panel stub">
              <h2>Оценок пока нет</h2>
              <p>Создайте первую оценку и заполните чек-лист: итог и уровень посчитаются сами.</p>
              <button className="btn primary" type="button" onClick={() => setDialog('new')}>Новая оценка</button>
            </div>
          ) : (
            <>
              <div className="sa-bar">
                <Select className="inp" aria-label="Оценка" value={id ?? ''} onChange={(e) => open(e.target.value)}>
                  {items.filter((x) => x.status !== 'archived' || x.id === id).map((x) => (
                    <option key={x.id} value={x.id}>{x.title} · {dateRu(x.assessedOn)}{x.status === 'archived' ? ' · архив' : ''}</option>
                  ))}
                </Select>
                {a && <span className={`chip ${STATUS_TONE[a.status]}`} data-status={a.status}><span className="dot" />{a.statusName}</span>}
                <span className="grow" />
                {a?.status === 'draft' && (
                  <>
                    {/* Черновик на прежней методике (1.13.8): обновить до активной с подтверждением. */}
                    {a.methodologyUpgrade && (
                      <button className="btn" type="button" data-testid="sa-upgrade" onClick={() => setDialog('upgrade')}>
                        Обновить методику до v{a.methodologyUpgrade.version}
                      </button>
                    )}
                    <button className="btn" type="button" onClick={() => setDialog('import')}>Импорт Excel</button>
                    <button className="btn" type="button" onClick={() => setDialog('profile')}>Профиль</button>
                    <button className="btn primary" type="button" disabled={a.preliminary || finalize.isPending}
                      title={a.preliminary ? `Заполнено ${a.answered} из ${a.sections}: зафиксировать можно, когда отвечены все разделы` : undefined}
                      onClick={() => finalize.mutate(a)}>Зафиксировать</button>
                  </>
                )}
                {a?.status === 'final' && <button className="btn ghost" type="button" onClick={() => setDialog('reopen')}>Вернуть в черновик</button>}
                {!hasDraft && <button className="btn primary" type="button" onClick={() => setDialog('new')}>Новая оценка</button>}
                {a && <button className="btn" type="button" onClick={() => setDialog('present')}>Презентация</button>}
                <button className="btn ghost" type="button" disabled={exporting} title="Все оценки, кроме архивных, — таблицы для анализа" onClick={() => void exportXlsx()}>
                  Выгрузить .xlsx
                </button>
              </div>

              <div className="tabs page-tabs" role="tablist">
                {TABS.map((t) => (
                  <NavLink key={t.key} to={`/assessment/${t.key}${id ? `?id=${id}` : ''}`} role="tab" aria-selected={t.key === tab}>{t.title}</NavLink>
                ))}
              </div>

              {one.isError ? <div className="note sa-warn">Не удалось открыть оценку: {one.error.message}</div>
                : !a ? <div className="hint sa-wait">Загрузка…</div>
                  : (tab as Tab) === 'overview' ? <Overview a={a} />
                    : (tab as Tab) === 'checklist' ? <Checklist a={a} />
                      : (tab as Tab) === 'plan' ? <Plan a={a} />
                      : <History a={a} items={items} onOpen={open} onArchive={(x) => setDialog({ archive: x })} />}
            </>
          )}

      {dialog === 'new' && <NewAssessmentDialog items={items} onClose={() => setDialog(null)} onCreated={(x) => open(x.id)} />}
      {dialog === 'reopen' && a && <ReopenDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'profile' && a && <ProfileDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'import' && a && <ImportDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'upgrade' && a?.methodologyUpgrade && <UpgradeDialog a={a} to={a.methodologyUpgrade} onClose={() => setDialog(null)} />}
      {/* «Подготовил» — ФИО вошедшего из сессии, вручную не вводится. */}
      {dialog === 'present' && a && <Presentation a={a} preparedBy={me.fullName} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <ArchiveDialog target={dialog.archive} onClose={() => setDialog(null)} />}
    </>
  );
}
