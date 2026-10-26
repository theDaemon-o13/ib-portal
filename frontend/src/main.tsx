import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api/client';
import { App } from './App';
import { ME_KEY } from './auth/useMe';
import { initTheme } from './components/ThemeSwitch';
import { ToastProvider } from './components/Toast';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';

initTheme();

// Сессия истекла (30 минут без действий) — любой 401 возвращает на страницу входа.
const onApiError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401 && error.code !== 'INVALID_CREDENTIALS') {
    queryClient.setQueryData(ME_KEY, null);
  }
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
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
