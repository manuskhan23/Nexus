import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  syncSystemTheme: () => void;
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeClass(resolved: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      resolvedTheme: getSystemTheme(),
      setMode: (mode) => {
        const resolved = mode === 'system' ? getSystemTheme() : mode;
        applyThemeClass(resolved);
        set({ mode, resolvedTheme: resolved });
      },
      syncSystemTheme: () => {
        if (get().mode === 'system') {
          const resolved = getSystemTheme();
          applyThemeClass(resolved);
          set({ resolvedTheme: resolved });
        }
      },
    }),
    {
      name: 'nexus-theme',
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolved = state.mode === 'system' ? getSystemTheme() : state.mode;
          applyThemeClass(resolved);
        }
      },
    }
  )
);
