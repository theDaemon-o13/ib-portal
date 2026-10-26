import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../api/client';
import { visibleNav } from '../nav';
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
      <nav className="nav" aria-label="Разделы">
        {visibleNav(me.permissions).map((item) => (
          <NavLink key={item.path} to={item.path}>
            <Icon name={item.icon} />
            <span>{item.title}</span>
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
