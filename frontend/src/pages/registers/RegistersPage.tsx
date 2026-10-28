import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { registersApi } from '../../api/registers';
import { AutomationTab } from './AutomationTab';
import { DashboardPreview } from './DashboardPreview';
import { FieldsTab } from './FieldsTab';
import { RecordsTab } from './RecordsTab';
import { rkeys } from './keys';
import { REG_TABS, RegisterBar, type RegTab } from './RegisterBar';

/** Адрес: /registers#<id реестра>/<вкладка> — обновление страницы не сбрасывает выбор. */
export function parseRegHash(hash: string): { id: string | null; tab: RegTab } {
  const [id = '', tab = ''] = hash.replace(/^#/, '').split('/');
  const known = REG_TABS.find((t) => t.key === tab && !t.disabled);
  return { id: /^[0-9a-f-]{36}$/i.test(id) ? id : null, tab: known ? known.key : 'records' };
}

export function RegistersPage() {
  const me = useOutletContext<Me>();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const canManage = me.permissions.includes('registers.manage');
  const { id, tab } = parseRegHash(location.hash);
  const list = useQuery({ queryKey: rkeys.listWith(false), queryFn: () => registersApi.list(false) });
  const detail = useQuery({ queryKey: rkeys.detail(id ?? ''), queryFn: () => registersApi.get(id ?? ''), enabled: !!id });
  const go = (regId: string, t: RegTab = tab) => navigate({ pathname: '/registers', hash: `${regId}/${t}` });

  // Первый неархивный реестр, если в адресе ничего не выбрано.
  const first = list.data?.items[0]?.id;
  useEffect(() => {
    if (!id && first && !params.registerId) navigate({ pathname: '/registers', hash: `${first}/records` }, { replace: true });
  }, [id, first, params.registerId, navigate]);

  // Старые адреса /registers/<id>/<вкладка> → /registers#<id>/<вкладка>.
  if (params.registerId) return <Navigate to={{ pathname: '/registers', hash: `${params.registerId}/${params.tab ?? 'records'}` }} replace />;

  const reg = detail.data;
  const owner = reg ? (list.data?.items.find((r) => r.id === reg.id)?.owner?.fullName ?? null) : null;

  return (
    <>
      <div className="head">
        <div>
          <h1>Конструктор реестров</h1>
          <p>Реестр собирается из полей. Форма карточки записи строится по полям: новое поле сразу появляется в карточке. Выгрузка в Excel и обратная загрузка обновляют записи по колонке ID.</p>
        </div>
      </div>
      <RegisterBar reg={reg} owner={owner} tab={tab} canManage={canManage} canDeleteRecords={me.permissions.includes('records.delete')} onPick={go} onTab={(t) => id && go(id, t)} />
      {detail.isError && <div className="panel panel-b form-error">Реестр не найден. Выберите другой в шапке.</div>}
      {list.isSuccess && list.data.items.length === 0 && !id && (
        <div className="panel panel-b hint">Реестров пока нет.{canManage ? ' Создайте первый в списке реестров в шапке.' : ''}</div>
      )}
      {reg && tab === 'fields' && (
        <div className="split reg-split">
          <div className="panel min0">
            <FieldsTab reg={reg} canManage={canManage && !reg.archived} />
          </div>
          <DashboardPreview registerId={reg.id} />
        </div>
      )}
      {reg && tab === 'automation' && (
        <div className="panel min0">
          <AutomationTab key={reg.id} reg={reg} canManage={canManage && !reg.archived} />
        </div>
      )}
      {reg && tab === 'records' && (
        <div className="panel min0">
          <RecordsTab
            key={reg.id}
            reg={reg}
            canEdit={me.permissions.includes('records.edit') && !reg.archived}
            canDelete={me.permissions.includes('records.delete') && !reg.archived}
          />
        </div>
      )}
    </>
  );
}
