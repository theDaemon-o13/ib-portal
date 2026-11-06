import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api/client';
import { BUILD } from './build-info';
import { nkeys } from './api/notifications';
import { App } from './App';
import { installInputTracking, markExpired } from './auth/session';
import { ME_KEY } from './auth/useMe';
import { initTheme } from './components/ThemeSwitch';
import { ToastProvider } from './components/Toast';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/assessment.css';
import './styles/awareness.css';

initTheme();
installInputTracking();
// Сборка — служебным атрибутом страницы (1.6.4: в окне версии — только версия и подпись): по нему разбор обращений
// и проверка образа релиза (make-release.sh ищет коммит в сборке).
document.documentElement.dataset.build = [BUILD.version, BUILD.commit, BUILD.date].filter(Boolean).join(' ');

// Сессию закрыли (срок, «Завершить», смена пароля в другой вкладке) — любой 401 возвращает на страницу входа.
const onApiError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401 && error.code !== 'INVALID_CREDENTIALS') {
    // Был вошедший пользователь — сессия завершилась посреди работы: вход объяснит и вернёт на ту же страницу.
    if (queryClient.getQueryData(ME_KEY)) markExpired();
    queryClient.setQueryData(ME_KEY, null);
  }
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  // После любого успешного действия — пересчитать «ждёт вашего действия» (меню и колокольчик, релиз 1.4.0).
  mutationCache: new MutationCache({ onError: onApiError, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: nkeys.attention }); } }),
  defaultOptions: { queries: { refetchOnWindowFocus: true } },
});

const root = document.getElementById('root');
if (!root) throw new Error('нет #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
