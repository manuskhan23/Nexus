import { Monitor, Moon, Sun } from 'lucide-react';
import { ThemeMode, useThemeStore } from '../stores/themeStore';

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
  { mode: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useThemeStore();

  return (
    <div
      role="group"
      aria-label="Theme selection"
      className="inline-flex items-center rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-900 p-1 gap-0.5"
    >
      {OPTIONS.map(({ mode: m, label, icon: Icon }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            title={label}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              active
                ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
