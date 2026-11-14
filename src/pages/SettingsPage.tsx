import { useState } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { apiRequest } from '../services/api';
import { AuthUser, ProviderId, ProviderMode, useAuthStore } from '../stores/authStore';

export function SettingsPage() {
  const { user, setUser } = useAuthStore();
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  async function updatePrefs(patch: Partial<AuthUser['preferences']> & { fullName?: string }) {
    setSaving(true);
    setSavedNotice('');
    try {
      const data = await apiRequest<{ user: AuthUser }>('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setUser(data.user);
      setSavedNotice('Settings saved.');
      setTimeout(() => setSavedNotice(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-6">
      <header className="flex items-center justify-between border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            Manage workspace appearance, default AI routing, and execution guardrails.
          </p>
        </div>
        {savedNotice && (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {savedNotice}
          </span>
        )}
      </header>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
        <h2 className="text-sm font-semibold">Profile</h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="flex-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
          />
          <button
            type="button"
            disabled={saving || fullName.trim().length < 2}
            onClick={() => updatePrefs({ fullName: fullName.trim() })}
            className="rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 cursor-pointer disabled:opacity-50"
          >
            Update Name
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Appearance</h2>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Choose Light, Dark, or follow your operating system preference.
          </p>
        </div>
        <ThemeToggle />
      </section>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
        <h2 className="text-sm font-semibold">Default AI Routing</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1.5">
              Routing Mode
            </label>
            <select
              value={user?.preferences.defaultProviderMode || 'automatic'}
              onChange={(e) =>
                updatePrefs({ defaultProviderMode: e.target.value as ProviderMode })
              }
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="automatic">Automatic Failover</option>
              <option value="gemini_only">Gemini Only</option>
              <option value="groq_only">Groq Only</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1.5">
              Preferred Primary Provider
            </label>
            <select
              value={user?.preferences.preferredProvider || 'gemini'}
              onChange={(e) => updatePrefs({ preferredProvider: e.target.value as ProviderId })}
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="gemini">Google Gemini</option>
              <option value="groq">Groq Llama</option>
            </select>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
        <h2 className="text-sm font-semibold">Permission Guardrails</h2>
        <label className="flex items-start justify-between gap-4 cursor-pointer">
          <div>
            <div className="text-sm font-medium">Auto-execute low-risk tools</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              Read-only lookups, calculations, and JSON validation run immediately.
            </div>
          </div>
          <input
            type="checkbox"
            checked={user?.preferences.autoExecuteLowRisk ?? true}
            onChange={(e) => updatePrefs({ autoExecuteLowRisk: e.target.checked })}
            className="mt-1 h-4 w-4"
          />
        </label>

        <label className="flex items-start justify-between gap-4 pt-3 border-t border-slate-200 dark:border-zinc-800 cursor-pointer">
          <div>
            <div className="text-sm font-medium">Require approval for moderate-risk tools</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              Pause before saving persistent memories or creating tracked tasks until you click Approve.
            </div>
          </div>
          <input
            type="checkbox"
            checked={user?.preferences.requireApprovalForModerate ?? true}
            onChange={(e) => updatePrefs({ requireApprovalForModerate: e.target.checked })}
            className="mt-1 h-4 w-4"
          />
        </label>

        <label className="flex items-start justify-between gap-4 pt-3 border-t border-slate-200 dark:border-zinc-800 cursor-pointer">
          <div>
            <div className="text-sm font-medium">Auto-learn from tool &amp; execution errors</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              Automatically record corrective training rules when a tool call or argument validation fails.
            </div>
          </div>
          <input
            type="checkbox"
            checked={user?.preferences.autoLearnFromErrors ?? true}
            onChange={(e) => updatePrefs({ autoLearnFromErrors: e.target.checked })}
            className="mt-1 h-4 w-4"
          />
        </label>
      </section>
    </div>
  );
}
