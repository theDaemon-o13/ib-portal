import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { CalendarEditor } from './CalendarEditor';
import { CatalogValues } from './CatalogValues';
import { FormTemplatesEditor } from './FormTemplatesEditor';
import { MonitorSlides } from './MonitorSlides';
import { PartyDirectory } from './PartyDirectory';
import { PortalParams } from './PortalParams';
import { PresentationSettings } from './PresentationSettings';
import { RolesMatrix } from './RolesMatrix';
import { TrashTab } from './TrashTab';
import { UsersTable } from './UsersTable';
import { keys } from './useAction';

const TABS = [
  { key: 'catalogs', title: 'Справочники' },
  { key: 'users', title: 'Пользователи и роли' },
  // Слайды настенных мониторов (релиз 1.1.0): видно и правится по праву «Настройки».
  // С 1.8.0 (ADR-0036) ещё и ib.work: слайды ссылаются на реестры и KPI — данные банка.
  { key: 'monitor', title: 'Экран мониторинга', perms: ['settings.manage', 'ib.work'] },
  // Подпись в презентации самооценки (этап Д5): только право «Настройки».
  { key: 'presentation', title: 'Презентация', perm: 'settings.manage' },
  // Параметры портала (релиз 1.6.0): роль, а не право; решает backend.
  { key: 'params', title: 'Параметры портала', role: 'Супер-администратор' },
  // Корзина (релиз 1.6.1): просмотр — сотрудник ИБ, восстановление — супер-администратор.
  { key: 'trash', title: 'Корзина', perm: 'ib.work' },
] as const;

/** Особые разделы в списке справочников: устроены иначе, чем «значение и цвет». */
const CALENDAR = 'work_calendar';
const TEMPLATES = 'form_templates';
/** Справочник «Ответственные лица» (1.6.7): settings.manage и (с 1.8.0, ADR-0036) ib.work — реальные ФИО; без прав пункта нет. */
const PARTIES = 'document_parties';

function CatalogsTab({ canEdit, canParties }: { canEdit: boolean; canParties: boolean }) {
  // Без settings.manage и ib.work справочник ответственных лиц не показывается и по прямой ссылке (?c=document_parties).
  const catalogs = useQuery({ queryKey: keys.catalogs, queryFn: settingsApi.catalogs });
  const templates = useQuery({ queryKey: keys.templates, queryFn: () => settingsApi.templates(true) });
  const [params, setParams] = useSearchParams();
  const list = catalogs.data?.items ?? [];
  const asked = params.get('c');
  const sel = (asked === PARTIES && !canParties ? null : asked) ?? list[0]?.code ?? '';
  const catalog = list.find((c) => c.code === sel);
  const pick = (c: string) => setParams({ c }, { replace: true });

  return (
    <div className="split set-split">
      <div className="panel">
        <div className="panel-h"><h3>Справочники</h3></div>
        <div className="reglist">
          {list.map((c) => (
            <button key={c.code} type="button" aria-pressed={c.code === sel} onClick={() => pick(c.code)}>
              <b>{c.name}</b>
              <small>
                {c.itemCount} знач.{c.archivedCount ? ` · в архиве ${c.archivedCount}` : ''}
              </small>
            </button>
          ))}
          <button type="button" aria-pressed={sel === CALENDAR} onClick={() => pick(CALENDAR)}>
            <b>Производственный календарь РТ</b>
            <small>праздники и переносы</small>
          </button>
          <button type="button" aria-pressed={sel === TEMPLATES} onClick={() => pick(TEMPLATES)}>
            <b>Шаблоны форм подтверждения</b>
            <small>{templates.data ? `${templates.data.items.length} шабл.` : ''}</small>
          </button>
          {canParties && (
            <button type="button" aria-pressed={sel === PARTIES} onClick={() => pick(PARTIES)}>
              <b>Ответственные лица</b>
              <small>для согласования документов</small>
            </button>
          )}
        </div>
      </div>
      {sel === CALENDAR && <CalendarEditor canEdit={canEdit} />}
      {sel === TEMPLATES && <FormTemplatesEditor canEdit={canEdit} />}
      {sel === PARTIES && canParties && <PartyDirectory />}
      {catalog && <CatalogValues key={catalog.code} catalog={catalog} canEdit={canEdit} />}
      {catalogs.isError && <div className="panel panel-b form-error">{catalogs.error.message}</div>}
    </div>
  );
}

export function SettingsPage() {
  const me = useOutletContext<Me>();
  const { tab } = useParams();
  const canCatalogs = me.permissions.includes('settings.manage');
  const tabs = TABS.filter((t) => ('perm' in t ? me.permissions.includes(t.perm)
    : 'perms' in t ? t.perms.every((p) => me.permissions.includes(p))
      : 'role' in t ? me.roles.includes(t.role) : true));
  // Журнал изменений настроек переехал в раздел «Журнал» (релиз 1.2.0): старые ссылки ведут туда.
  if (tab === 'journal') return <Navigate to={me.permissions.includes('audit.view') ? '/audit' : '/settings/catalogs'} replace />;
  if (!tabs.some((t) => t.key === tab)) return <Navigate to="/settings/catalogs" replace />;
  const canUsers = me.permissions.includes('users.manage');

  return (
    <>
      <div className="head">
        <div>
          <h1>Настройки</h1>
          <p>
            Справочники, производственный календарь, шаблоны форм, пользователи и роли портала. Изменения доступны ролям с
            правами на настройки, остальные сотрудники ИБ видят их для просмотра.
          </p>
        </div>
      </div>
      <div className="tabs page-tabs" role="tablist">
        {tabs.map((t) => (
          <NavLink key={t.key} to={`/settings/${t.key}`} role="tab" aria-selected={t.key === tab}>
            {t.title}
          </NavLink>
        ))}
      </div>
      {tab === 'catalogs' && <CatalogsTab canEdit={canCatalogs} canParties={canCatalogs && me.permissions.includes('ib.work')} />}
      {tab === 'users' && (
        <div className="stack">
          <RolesMatrix canEdit={canUsers} />
          <UsersTable canEdit={canUsers} />
        </div>
      )}
      {tab === 'monitor' && <MonitorSlides />}
      {tab === 'presentation' && <PresentationSettings />}
      {tab === 'params' && <PortalParams />}
      {tab === 'trash' && <TrashTab canRestore={me.roles.includes('Супер-администратор')} />}
    </>
  );
}
