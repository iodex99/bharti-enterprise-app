import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { IS_APP_BUILD, bootApp } from './local/boot';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

function render(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

if (IS_APP_BUILD) {
  // The app build has no server to talk to: start the in-app one (database open,
  // migrations applied) BEFORE rendering, or the first queries would race the boot.
  // bootApp() renders its own failure screen; nothing more to do here.
  void bootApp()
    .then(render)
    .catch(() => undefined);
} else {
  render();

  // PWA shell: production only; never caches /api (see public/sw.js)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js');
    });
  }
}
