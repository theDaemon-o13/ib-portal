// Каркас (1.13.0, ADR-0047): меню слева, справа — верхняя панель и «сцена» с содержимым страницы.
// На узком экране (до 860 px) меню выезжает по кнопке «Меню» поверх затемнения; закрывается переходом, Esc и щелчком мимо.
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import type { Me } from '../api/client';
import { ScrollControls } from './ScrollControls';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function Shell({ me }: { me: Me }) {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname, loc.search]);
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);
  return (
    <div className={`app${menu ? ' menu-open' : ''}`}>
      <Sidebar me={me} />
      {menu && <div className="menu-scrim" role="presentation" onClick={() => setMenu(false)} />}
      <div className="main-col">
        <Topbar me={me} menuOpen={menu} onMenu={() => setMenu((x) => !x)} />
        <main className="stage">
          <Outlet context={me} />
        </main>
      </div>
      <ScrollControls />
    </div>
  );
}
