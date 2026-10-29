import type { ReactNode } from 'react';
import { Navigate, useLocation, useOutletContext } from 'react-router-dom';
import type { Me } from '../api/client';
import { wasExpired } from '../auth/session';
import { useMe } from '../auth/useMe';
import { canSee, homePath, isKiosk, NAV, type NavItem } from '../nav';
import { MonitorPage } from '../pages/monitor/MonitorPage';
import { SessionWatch } from './SessionWatch';
import { Shell } from './Shell';

function Loading() {
  return <div className="loading">Загрузка…</div>;
}

/** Только для вошедших; до смены пароля — только страница смены пароля. */
export function RequireUser({ children }: { children: (me: Me) => ReactNode }) {
  const { data: me, isPending, isError } = useMe();
  const location = useLocation();
  if (isPending) return <Loading />;
  if (isError) return <div className="loading">Сервер недоступен. Обновите страницу позже</div>;
  // Вернуть после входа на ту же страницу — с параметрами (/tasks?task=…).
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search, expired: wasExpired() }} />;
  // Предупреждение о завершении по бездействию; у настенного монитора бездействия нет (ADR-0012).
  return <>{children(me)}{!isKiosk(me.permissions) && <SessionWatch />}</>;
}

export function ProtectedShell() {
  return (
    <RequireUser>
      {(me) => (me.mustChangePassword ? <Navigate to="/change-password" replace />
        // Настенный монитор видит только /monitor: любой другой адрес ведёт туда.
        : isKiosk(me.permissions) ? <Navigate to="/monitor" replace />
          : <Shell me={me} />)}
    </RequireUser>
  );
}

const MONITOR = NAV.find((i) => i.path === '/monitor') as NavItem;

/** /monitor — без меню слева: экран на всю стену. Доступ — ib.work или настенный монитор. */
export function MonitorRoute() {
  return (
    <RequireUser>
      {(me) => (me.mustChangePassword ? <Navigate to="/change-password" replace />
        : canSee(MONITOR, me.permissions) ? <MonitorPage me={me} />
          : <Navigate to={homePath(me.permissions)} replace />)}
    </RequireUser>
  );
}

/** Раздел без нужного права не открывается и по прямой ссылке. Решает всё равно backend. */
export function Section({ item, children }: { item: NavItem; children: ReactNode }) {
  const me = useOutletContext<Me>();
  if (!canSee(item, me.permissions)) return <Navigate to={homePath(me.permissions)} replace />;
  return <>{children}</>;
}

export function HomeRedirect() {
  const me = useOutletContext<Me>();
  return <Navigate to={homePath(me.permissions)} replace />;
}
