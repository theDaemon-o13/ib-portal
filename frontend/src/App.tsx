import { Navigate, Route, Routes } from 'react-router-dom';
import { HomeRedirect, MonitorRoute, ProtectedShell, RequireUser, Section } from './components/guards';
import { NAV } from './nav';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { ChangePasswordPage } from './pages/change-password/ChangePasswordPage';
import { DocumentsPage } from './pages/documents/DocumentsPage';
import { EvidencePage } from './pages/evidence/EvidencePage';
import { LoginPage } from './pages/login/LoginPage';
import { RegistersPage } from './pages/registers/RegistersPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { StubPage } from './pages/stub/StubPage';
import { TasksPage } from './pages/tasks/TasksPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<RequireUser>{(me) => <ChangePasswordPage me={me} />}</RequireUser>} />
      {/* Мониторинг — на весь экран, без меню (настенный монитор). */}
      <Route path="/monitor" element={<MonitorRoute />} />
      <Route element={<ProtectedShell />}>
        <Route index element={<HomeRedirect />} />
        {NAV.filter((item) => item.path !== '/monitor').map((item) =>
          item.path === '/dashboard' ? (
            <Route key={item.path} path="/dashboard" element={<Section item={item}><DashboardPage /></Section>} />
          ) : item.path === '/settings' ? (
            <Route key={item.path} path="/settings/:tab?" element={<Section item={item}><SettingsPage /></Section>} />
          ) : item.path === '/tasks' ? (
            <Route key={item.path} path="/tasks" element={<Section item={item}><TasksPage /></Section>} />
          ) : item.path === '/documents' ? (
            <Route key={item.path} path="/documents" element={<Section item={item}><DocumentsPage /></Section>} />
          ) : item.path === '/evidence' ? (
            <Route key={item.path} path="/evidence" element={<Section item={item}><EvidencePage /></Section>} />
          ) : item.path === '/registers' ? (
            <Route key={item.path} path="/registers/:registerId?/:tab?" element={<Section item={item}><RegistersPage /></Section>} />
          ) : (
            <Route key={item.path} path={item.path} element={<Section item={item}><StubPage item={item} /></Section>} />
          ),
        )}
        <Route path="*" element={<HomeRedirect />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
