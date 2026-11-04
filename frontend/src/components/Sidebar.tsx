import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../api/client';
import { evidenceApi, ekeys } from '../api/evidence';
import { isKiosk, visibleNav } from '../nav';
import { PortalCredit } from './AboutPortal';
import { Brand } from './Brand';
import { Icon } from './Icons';
import { NotificationBell, useAttention } from './NotificationBell';
import { ThemeSwitch } from './ThemeSwitch';

function initials(fullName: string): string {
  const letters = fullName.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]);
  return (letters.slice(-2).join('') || '?').toUpperCase();
}

export function Sidebar({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Цифры в меню (релиз 1.4.0) — только то, что ждёт вашего действия: «Задачи» — на вашей проверке, «Документы» —
  // «ждут вас». Тот же запрос, что у колокольчика. Просроченное — на дашборде и в фильтре доски.
  const attention = useAttention(!isKiosk(me.permissions));
  const reviewing = attention.data?.tasks ?? 0;
  const waiting = attention.data?.documents ?? 0;
  // Действия служебного администратора с доступом (1.8.0, ADR-0036) — держателям «Журнала действий».
  const serviceActions = attention.data?.audit ?? 0;
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
      <div className="rail-top">
        <Brand />
        {!isKiosk(me.permissions) && <NotificationBell />}
      </div>
      {/* Поиск — всем, кроме монитора (1.2.0) и служебной учётной записи (ADR-0036): что видно, решает backend. */}
      {!isKiosk(me.permissions) && !me.service && (
        <form className="rail-search" role="search" onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q')?.toString().trim() ?? '';
          if (q.length >= 2) navigate(`/search?q=${encodeURIComponent(q)}`);
        }}>
          <input className="inp" name="q" type="search" minLength={2} placeholder="Поиск по порталу" aria-label="Поиск по порталу" />
        </form>
      )}
      <nav className="nav" aria-label="Разделы">
        {visibleNav(me.permissions, me.service).map((item) => (
          <NavLink key={item.path} to={item.path}>
            <Icon name={item.icon} />
            <span>{item.title}</span>
            {item.path === '/tasks' && reviewing > 0 && (
              <span className="nav-n acc" data-testid="nav-tasks-n" title={`Ждут вашей проверки: ${reviewing}`} aria-label={`ждут вашей проверки: ${reviewing}`}>{reviewing}</span>
            )}
            {item.path === '/documents' && waiting > 0 && (
              <span className="nav-n acc" data-testid="nav-docs-n" title={`Ждут вас: ${waiting}`} aria-label={`ждут вас: ${waiting}`}>{waiting}</span>
            )}
            {item.path === '/audit' && serviceActions > 0 && (
              <span className="nav-n acc" data-testid="nav-audit-n" title={`Действия служебного администратора с доступом: ${serviceActions}`}
                aria-label={`действия служебного администратора: ${serviceActions}`}>{serviceActions}</span>
            )}
            {item.path === '/evidence' && pendingEvidence > 0 && (
              <span className="nav-n acc" title={`На проверке: ${pendingEvidence}`} aria-label={`доказательств на проверке: ${pendingEvidence}`}>{pendingEvidence}</span>
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
        <PortalCredit />
      </div>
    </aside>
  );
}
