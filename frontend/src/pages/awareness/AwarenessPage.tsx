// Раздел «Осведомлённость» (1.9.0; docs/specs/awareness.md, раздел 12): «Письма», «Шаблоны», «Расписание».
// Право ib.work; служебная учётная запись раздела не видит (пункта меню нет, backend отвечает 403).
import { NavLink, useParams } from 'react-router-dom';
import { LettersTab } from './LettersTab';

const TABS = [
  { key: 'letters', title: 'Письма' },
] as const;

export function AwarenessPage() {
  const { tab = 'letters' } = useParams();
  return (
    <>
      <div className="head">
        <div>
          <h1>Осведомлённость: учебные письма</h1>
          <p>Письма сотрудникам о фишинге и мошенничестве: черновик → согласование начальником ИБ → отправка из почтового клиента. Портал писем не отправляет — письмо копируется в Outlook или скачивается файлом .eml.</p>
        </div>
      </div>
      <div className="tabs page-tabs aw-sections" role="tablist" aria-label="Разделы осведомлённости">
        {TABS.map((t) => <NavLink key={t.key} to={`/awareness/${t.key}`} role="tab" aria-selected={t.key === tab}>{t.title}</NavLink>)}
      </div>
      {tab === 'letters' && <LettersTab />}
    </>
  );
}
