import { useEffect, useState } from 'react';
import { Activity, Play, RefreshCw } from 'lucide-react';
import { apiRequest } from '../services/api';
import { ProviderId, ProviderMode, useAuthStore } from '../stores/authStore';

interface ProviderInfo {
  id: ProviderId;
  label: string;
  model: string;
  configured: boolean;
  supportsToolCalling: boolean;
}

interface HealthItem {
  provider: ProviderId;
  label: string;
  model: string;
  configured: boolean;
  healthy: boolean;
  latencyMs: number;
  lastCheckedAt: string;
  error?: string;
}

interface ProviderLog {
  id: string;
  eventType: string;
  provider: ProviderId;
  fallbackTo?: ProviderId;
  model: string;
  latencyMs: number;
  detail: string;
  createdAt: string;
}

interface ToolMeta {
  name: string;
  description: string;
  riskLevel: 'low' | 'moderate' | 'high';
}

export function ProvidersPage() {
  const { user, setUser } = useAuthStore();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [health, setHealth] = useState<HealthItem[]>([]);
  const [simulatedOutage, setSimulatedOutage] = useState<ProviderId | null>(null);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [logs, setLogs] = useState<ProviderLog[]>([]);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [testPrompt, setTestPrompt] = useState('Calculate (1240 * 1.15) / 4 using the calculator tool.');
  const [testMode, setTestMode] = useState<ProviderMode>('automatic');
  const [enableTools, setEnableTools] = useState(true);
  const [runningTest, setRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [testError, setTestError] = useState('');

  async function loadStatus() {
    try {
      const data = await apiRequest<{
        providers: ProviderInfo[];
        simulatedOutage: ProviderId | null;
        tools: ToolMeta[];
        recentLogs: ProviderLog[];
      }>('/api/providers/status');
      setProviders(data.providers);
      setSimulatedOutage(data.simulatedOutage);
      setTools(data.tools);
      setLogs(data.recentLogs);
    } catch {
      // Auth/network errors handled cleanly
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function handleHealthCheck() {
    setCheckingHealth(true);
    try {
      const data = await apiRequest<{ health: HealthItem[]; recentLogs: ProviderLog[] }>(
        '/api/providers/health',
        { method: 'POST' }
      );
      setHealth(data.health);
      setLogs(data.recentLogs);
    } finally {
      setCheckingHealth(false);
    }
  }

  async function handleSimulateOutage(target: ProviderId | null) {
    const data = await apiRequest<{ simulatedOutage: ProviderId | null }>(
      '/api/providers/simulate-outage',
      {
        method: 'POST',
        body: JSON.stringify({ provider: target }),
      }
    );
    setSimulatedOutage(data.simulatedOutage);
  }

  async function handleUpdatePreference(patch: {
    defaultProviderMode?: ProviderMode;
    preferredProvider?: ProviderId;
  }) {
    const data = await apiRequest<{ user: any }>('/api/auth/preferences', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    setUser(data.user);
  }

  async function handleRunTest(e: React.FormEvent) {
    e.preventDefault();
    setRunningTest(true);
    setTestError('');
    setTestResult(null);
    try {
      const data = await apiRequest<any>('/api/providers/test-routing', {
        method: 'POST',
        body: JSON.stringify({
          prompt: testPrompt,
          mode: testMode,
          enableTools,
        }),
      });
      setTestResult(data);
      if (data.recentLogs) setLogs(data.recentLogs);
    } catch (err: any) {
      setTestError(err.message || 'Routing test failed');
      await loadStatus();
    } finally {
      setRunningTest(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Providers & Failover</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            Configure server-managed Gemini and Groq routing, run live health diagnostics, and verify automatic failover.
          </p>
        </div>
        <button
          type="button"
          onClick={handleHealthCheck}
          disabled={checkingHealth}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${checkingHealth ? 'animate-spin' : ''}`} />
          <span>{checkingHealth ? 'Checking...' : 'Check Provider Health'}</span>
        </button>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {providers.map((p) => {
          const h = health.find((item) => item.provider === p.id);
          const isSimulatedDown = simulatedOutage === p.id;
          return (
            <div
              key={p.id}
              className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{p.label}</h2>
                  <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-zinc-400">
                    {h?.model || p.model} · Tool calling {p.supportsToolCalling ? 'supported' : 'unavailable'}
                  </p>
                </div>
                <span
                  className={`text-xs font-medium ${
                    isSimulatedDown
                      ? 'text-amber-600 dark:text-amber-400'
                      : h
                      ? h.healthy
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                      : p.configured
                      ? 'text-slate-700 dark:text-zinc-300'
                      : 'text-slate-500 dark:text-zinc-500'
                  }`}
                >
                  {isSimulatedDown
                    ? 'Simulated Outage'
                    : h
                    ? h.healthy
                      ? `Healthy (${h.latencyMs}ms)`
                      : 'Unhealthy'
                    : p.configured
                    ? 'Configured'
                    : 'Not Configured'}
                </span>
              </div>

              {h?.error && (
                <p className="text-xs text-red-600 dark:text-red-400">{h.error}</p>
              )}

              <div className="pt-2 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-between text-xs">
                <span className="text-slate-500 dark:text-zinc-400">
                  Credentials managed via server secrets
                </span>
                <button
                  type="button"
                  onClick={() => handleSimulateOutage(isSimulatedDown ? null : p.id)}
                  className="font-medium text-slate-700 dark:text-zinc-300 hover:underline cursor-pointer whitespace-nowrap"
                >
                  {isSimulatedDown ? 'Restore Provider' : 'Simulate Transient 503'}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Workspace Routing Policy</h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              In Automatic mode, transient provider failures trigger seamless failover without interrupting execution.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-950 p-1 gap-0.5">
              {(
                [
                  { id: 'automatic', label: 'Automatic' },
                  { id: 'gemini_only', label: 'Gemini Only' },
                  { id: 'groq_only', label: 'Groq Only' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleUpdatePreference({ defaultProviderMode: m.id })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                    user?.preferences.defaultProviderMode === m.id
                      ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="inline-flex rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-950 p-1 gap-0.5">
              {(
                [
                  { id: 'gemini', label: 'Primary: Gemini' },
                  { id: 'groq', label: 'Primary: Groq' },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleUpdatePreference({ preferredProvider: p.id })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                    user?.preferences.preferredProvider === p.id
                      ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-500" />
          <h2 className="text-base font-semibold">Live Routing & Tool-Calling Runner</h2>
        </div>

        <form onSubmit={handleRunTest} className="space-y-4">
          <textarea
            rows={2}
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <select
                value={testMode}
                onChange={(e) => setTestMode(e.target.value as ProviderMode)}
                className="rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-medium"
              >
                <option value="automatic">Mode: Automatic Failover</option>
                <option value="gemini_only">Mode: Gemini Only</option>
                <option value="groq_only">Mode: Groq Only</option>
              </select>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableTools}
                  onChange={(e) => setEnableTools(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Include Function Calling Tools</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={runningTest || !testPrompt.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{runningTest ? 'Running...' : 'Run Diagnostic'}</span>
            </button>
          </div>
        </form>

        {testError && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300">
            {testError}
          </div>
        )}

        {testResult && (
          <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-4 space-y-2 text-xs">
            <div className="font-mono tabular-nums text-slate-600 dark:text-zinc-400">
              Used: {testResult.usedProvider} · Model: {testResult.model} · Latency:{' '}
              {testResult.latencyMs}ms
              {testResult.switched
                ? ` · Failover: ${testResult.switched.from} -> ${testResult.switched.to}`
                : ''}
            </div>
            {testResult.toolCalls?.length > 0 && (
              <pre className="overflow-x-auto rounded border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2.5 font-mono text-[11px]">
                {JSON.stringify(testResult.toolCalls, null, 2)}
              </pre>
            )}
            {testResult.content && (
              <p className="text-sm text-slate-900 dark:text-zinc-100 whitespace-pre-wrap">
                {testResult.content}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Registered Agent Tools</h2>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-zinc-800">
            {tools.map((t) => (
              <div key={t.name} className="px-5 py-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-medium">{t.name}</span>
                  <span className="text-slate-500 dark:text-zinc-400">{t.riskLevel} risk</span>
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Recent Provider Events</h2>
          </div>
          {logs.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 dark:text-zinc-400">
              No provider routing events recorded yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-zinc-800 max-h-96 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between font-mono tabular-nums">
                    <span className="font-medium">
                      {log.eventType} · {log.provider}
                      {log.fallbackTo ? ` -> ${log.fallbackTo}` : ''}
                    </span>
                    <span className="text-slate-500 dark:text-zinc-400">{log.latencyMs}ms</span>
                  </div>
                  <p className="mt-1 text-slate-600 dark:text-zinc-400 truncate">{log.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
