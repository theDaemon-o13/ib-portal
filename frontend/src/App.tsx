import { Navigate, Route, Routes } from 'react-router-dom';
import { HomeRedirect, ProtectedShell, RequireUser, Section } from './components/guards';
import { NAV } from './nav';
import { ChangePasswordPage } from './pages/change-password/ChangePasswordPage';
import { LoginPage } from './pages/login/LoginPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { StubPage } from './pages/stub/StubPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<RequireUser>{(me) => <ChangePasswordPage me={me} />}</RequireUser>} />
      <Route element={<ProtectedShell />}>
        <Route index element={<HomeRedirect />} />
        {NAV.map((item) =>
          item.path === '/settings' ? (
            <Route key={item.path} path="/settings/:tab?" element={<Section item={item}><SettingsPage /></Section>} />
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
