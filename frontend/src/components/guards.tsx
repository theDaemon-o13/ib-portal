import type { ReactNode } from 'react';
import { Navigate, useLocation, useOutletContext } from 'react-router-dom';
import type { Me } from '../api/client';
import { useMe } from '../auth/useMe';
import { canSee, homePath, type NavItem } from '../nav';
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
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children(me)}</>;
}

export function ProtectedShell() {
  return (
    <RequireUser>
      {(me) => (me.mustChangePassword ? <Navigate to="/change-password" replace /> : <Shell me={me} />)}
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
