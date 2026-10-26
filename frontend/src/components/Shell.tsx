import { Outlet } from 'react-router-dom';
import type { Me } from '../api/client';
import { Sidebar } from './Sidebar';

export function Shell({ me }: { me: Me }) {
  return (
    <div className="app">
      <Sidebar me={me} />
      <main>
        <Outlet context={me} />
      </main>
    </div>
  );
}
