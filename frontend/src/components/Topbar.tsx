// Верхняя панель (1.13.0, ADR-0047): кнопка «Меню» (узкий экран), поиск, уведомления, тема, профиль, выход.
// Классы rail-search, bell, me-t сохранены: на них опираются e2e и прежние стили.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../api/client';
import { isKiosk } from '../nav';
import { NotificationBell } from './NotificationBell';
import { ThemeSwitch } from './ThemeSwitch';

export function initials(fullName: string): string {
  const letters = fullName.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]);
  return (letters.slice(-2).join('') || '?').toUpperCase();
}

export function Topbar({ me, menuOpen, onMenu }: { me: Me; menuOpen: boolean; onMenu: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const kiosk = isKiosk(me.permissions);
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
  return (
    <header className="topbar">
      <button type="button" className="icon-btn rail-toggle" aria-label="Меню" aria-expanded={menuOpen} aria-controls="portal-menu" onClick={onMenu}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      {/* Поиск — всем, кроме монитора (1.2.0) и служебной учётной записи (ADR-0036): что видно, решает backend. */}
      {!kiosk && !me.service ? (
        <form className="rail-search search" role="search" onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q')?.toString().trim() ?? '';
          if (q.length >= 2) navigate(`/search?q=${encodeURIComponent(q)}`);
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input className="inp" name="q" type="search" minLength={2} placeholder="Поиск по порталу" aria-label="Поиск по порталу" />
        </form>
      ) : <span className="grow" />}
      <div className="top-tools">
        {!kiosk && <NotificationBell />}
        <ThemeSwitch />
        {/* «Профиль» и «Мои сессии» (1.10.0). */}
        <NavLink className="me-t" to="/profile" title="Профиль и мои сессии">
          <span className="av" aria-hidden="true">{initials(me.fullName)}</span>
          <span className="me-n"><b title={me.fullName}>{me.fullName}</b><small>{me.login}</small></span>
        </NavLink>
        <button type="button" className="btn glass sm" onClick={() => logout.mutate()} disabled={logout.isPending}>Выйти</button>
      </div>
    </header>
  );
}
