import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../api/client';
import { docsApi, dkeys } from '../api/documents';
import { evidenceApi, ekeys } from '../api/evidence';
import { tasksApi, tkeys } from '../api/tasks';
import { SEARCH_PERMS } from '../api/search';
import { isKiosk, visibleNav } from '../nav';
import { Brand } from './Brand';
import { Icon } from './Icons';
import { ThemeSwitch } from './ThemeSwitch';

function initials(fullName: string): string {
  const letters = fullName.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]);
  return (letters.slice(-2).join('') || '?').toUpperCase();
}

export function Sidebar({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Уведомления пока только внутри портала: число просроченных задач отдела у пункта «Задачи».
  const summary = useQuery({
    queryKey: tkeys.summary,
    queryFn: tasksApi.summary,
    enabled: me.permissions.includes('ib.work'),
    refetchInterval: 60_000,
  });
  const overdue = summary.data?.overdue ?? 0;
  // «Документы» видят все: сколько документов ждёт вашего этапа; сотрудникам ИБ — ещё просроченный пересмотр.
  const docs = useQuery({ queryKey: dkeys.summary, queryFn: docsApi.summary, refetchInterval: 60_000 });
  const waiting = docs.data?.waitingForMe ?? 0;
  const reviewOverdue = docs.data?.reviewOverdue ?? 0;
  // Доказательства на проверке — тем, кто их проверяет.
  const ev = useQuery({ queryKey: ekeys.summary, queryFn: evidenceApi.summary, enabled: me.permissions.includes('evidence.review'), refetchInterval: 60_000 });
  const pendingEvidence = ev.data?.pending ?? 0;
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  return (
    <aside className="rail">
      <Brand />
      {!isKiosk(me.permissions) && me.permissions.some((p) => SEARCH_PERMS.includes(p)) && (
        <form className="rail-search" role="search" onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q')?.toString().trim() ?? '';
          if (q.length >= 2) navigate(`/search?q=${encodeURIComponent(q)}`);
        }}>
          <input className="inp" name="q" type="search" minLength={2} placeholder="Поиск по порталу" aria-label="Поиск по порталу" />
        </form>
      )}
      <nav className="nav" aria-label="Разделы">
        {visibleNav(me.permissions).map((item) => (
          <NavLink key={item.path} to={item.path}>
            <Icon name={item.icon} />
            <span>{item.title}</span>
            {item.path === '/tasks' && overdue > 0 && (
              <span className="nav-n" title={`Просрочено задач: ${overdue}, из них мои: ${summary.data?.overdueMine ?? 0}`} aria-label={`просрочено задач: ${overdue}`}>{overdue}</span>
            )}
            {item.path === '/documents' && waiting > 0 && (
              <span className="nav-n acc" title={`Ждут вашего согласования: ${waiting}`} aria-label={`ждут вас: ${waiting}`}>{waiting}</span>
            )}
            {item.path === '/evidence' && pendingEvidence > 0 && (
              <span className="nav-n acc" title={`На проверке: ${pendingEvidence}`} aria-label={`доказательств на проверке: ${pendingEvidence}`}>{pendingEvidence}</span>
            )}
            {item.path === '/documents' && reviewOverdue > 0 && (
              <span className="nav-n" title={`Пересмотр просрочен: ${reviewOverdue}`} aria-label={`пересмотр просрочен: ${reviewOverdue}`}>{reviewOverdue}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="rail-foot">
        <div className="me">
          <span className="av" aria-hidden="true">{initials(me.fullName)}</span>
          <div className="me-t">
            <b title={me.fullName}>{me.fullName}</b>
            <small>{me.login}</small>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Выйти
          </button>
        </div>
        <ThemeSwitch />
      </div>
    </aside>
  );
}
