import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  VerifyOtpPage,
} from './pages/AuthPages';
import { ChatPage } from './pages/ChatPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { DashboardPage } from './pages/DashboardPage';
import { MemoryPage } from './pages/MemoryPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { TrainingPage } from './pages/TrainingPage';
import { apiRequest } from './services/api';
import {
  AuthUser,
  getStoredAccessToken,
  getStoredRefreshToken,
  useAuthStore,
} from './stores/authStore';
import { useThemeStore } from './stores/themeStore';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isBootstrapping } = useAuthStore();
  if (isBootstrapping) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-zinc-950 text-sm text-slate-600 dark:text-zinc-400">
        Loading NEXUS workspace...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { setSession, clearSession } = useAuthStore();
  const syncSystemTheme = useThemeStore((s) => s.syncSystemTheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', syncSystemTheme);
    return () => mq.removeEventListener('change', syncSystemTheme);
  }, [syncSystemTheme]);

  useEffect(() => {
    const refreshToken = getStoredRefreshToken();
    apiRequest<{ user: AuthUser; accessToken: string; refreshToken?: string }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    })
      .then((data) => setSession(data.user, data.accessToken, data.refreshToken))
      .catch(async () => {
        const stored = getStoredAccessToken();
        if (stored) {
          try {
            const me = await apiRequest<{ user: AuthUser }>('/api/auth/me', {}, false);
            setSession(me.user, stored);
            return;
          } catch {
            // Token expired or invalid
          }
        }
        clearSession();
      });
  }, [setSession, clearSession]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-otp" element={<VerifyOtpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="chat/:conversationId" element={<ChatPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="connectors" element={<ConnectorsPage />} />
          <Route path="training" element={<TrainingPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
