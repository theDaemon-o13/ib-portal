import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../api/client';
import { evidenceApi, ekeys } from '../api/evidence';
import { isKiosk, visibleNav } from '../nav';
import { PortalCredit } from './AboutPortal';
import { Brand } from './Brand';
import { Icon } from './Icons';
import { useAttention } from './NotificationBell';

// Меню (1.13.0, ADR-0047): плавающая стеклянная панель — бренд, разделы со счётчиками, внизу подпись «designed by»
// и версия. Поиск, уведомления, тема и профиль — в верхней панели (Topbar). На узком экране меню выезжает по кнопке.
export function Sidebar({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // «Выйти» в меню — на узком экране, где в верхней панели для неё нет места.
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
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
  return (
    <aside className="rail" id="portal-menu" aria-label="Меню портала">
      <div className="rail-top">
        <Brand />
      </div>
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
        <button type="button" className="btn glass sm rail-logout" onClick={() => logout.mutate()} disabled={logout.isPending}>Выйти</button>
        <PortalCredit />
      </div>
    </aside>
  );
}
