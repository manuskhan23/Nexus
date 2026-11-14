import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Send } from 'lucide-react';
import { apiRequest } from '../services/api';
import { useAuthStore } from '../stores/authStore';

interface DashboardSummary {
  counts: {
    conversations: number;
    tasksTotal: number;
    tasksAwaitingApproval: number;
    memories: number;
  };
  providers: {
    geminiConfigured: boolean;
    groqConfigured: boolean;
    simulatedOutage: 'gemini' | 'groq' | null;
  };
  recentConversations: Array<{
    id: string;
    title: string;
    activeProvider: 'gemini' | 'groq';
    providerMode: string;
    messageCount: number;
    lastMessageAt: string;
  }>;
  recentTasks: Array<{
    id: string;
    goal: string;
    status: string;
    activeProvider: string;
    updatedAt: string;
  }>;
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    apiRequest<DashboardSummary>('/api/dashboard/summary')
      .then(setSummary)
      .finally(() => setLoading(false));
  }, []);

  async function handleQuickLaunch(e: React.FormEvent) {
    e.preventDefault();
    if (!quickPrompt.trim() || launching) return;
    setLaunching(true);
    try {
      const data = await apiRequest<{ conversation: { id: string } }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: quickPrompt.trim().slice(0, 60) }),
      });
      window.dispatchEvent(new Event('nexus:conversations-changed'));
      navigate(`/chat/${data.conversation.id}`, {
        state: { initialPrompt: quickPrompt.trim(), executionMode: 'task' },
      });
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Welcome back, {user?.fullName}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            Default routing: {user?.preferences.defaultProviderMode.replace('_', ' ')} · Primary provider:{' '}
            {user?.preferences.preferredProvider === 'groq' ? 'Groq Llama' : 'Google Gemini'}
          </p>
        </div>
        <Link
          to="/providers"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
        >
          Provider Diagnostics
          <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 p-6">
        <h2 className="text-sm font-medium text-slate-900 dark:text-zinc-100">
          Start an Agent Task
        </h2>
        <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">
          Run tool-assisted calculations, save workspace memory, create structured plans, or fetch public web content.
        </p>
        <form onSubmit={handleQuickLaunch} className="mt-4 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={quickPrompt}
            onChange={(e) => setQuickPrompt(e.target.value)}
            placeholder="e.g. Calculate (4820 * 1.15) / 12 and save my quarterly budget preference"
            className="flex-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            type="submit"
            disabled={!quickPrompt.trim() || launching}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-5 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            <span>{launching ? 'Starting...' : 'Run Task'}</span>
          </button>
        </form>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">Conversations</div>
          <div className="mt-2 text-2xl font-semibold font-mono tabular-nums">
            {loading ? '—' : summary?.counts.conversations ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-zinc-500">Isolated to your account</div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">Tracked Tasks</div>
          <div className="mt-2 text-2xl font-semibold font-mono tabular-nums">
            {loading ? '—' : summary?.counts.tasksTotal ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-zinc-500">
            {summary?.counts.tasksAwaitingApproval
              ? `${summary.counts.tasksAwaitingApproval} awaiting approval`
              : 'No pending approvals'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">Saved Memories</div>
          <div className="mt-2 text-2xl font-semibold font-mono tabular-nums">
            {loading ? '—' : summary?.counts.memories ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-zinc-500">Injected into context</div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">AI Providers Ready</div>
          <div className="mt-2 text-2xl font-semibold font-mono tabular-nums">
            {loading
              ? '—'
              : `${
                  (summary?.providers.geminiConfigured ? 1 : 0) +
                  (summary?.providers.groqConfigured ? 1 : 0)
                } / 2`}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-zinc-500">
            Gemini {summary?.providers.geminiConfigured ? 'Ready' : 'Unconfigured'} · Groq{' '}
            {summary?.providers.groqConfigured ? 'Ready' : 'Unconfigured'}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Recent Conversations</h2>
            <span className="text-xs text-slate-500 dark:text-zinc-400">History</span>
          </div>
          {loading ? (
            <div className="p-5 space-y-3">
              <div className="h-9 rounded bg-slate-100 dark:bg-zinc-800" />
              <div className="h-9 rounded bg-slate-100 dark:bg-zinc-800" />
            </div>
          ) : summary && summary.recentConversations.length > 0 ? (
            <div className="divide-y divide-slate-200 dark:divide-zinc-800">
              {summary.recentConversations.map((c) => (
                <Link
                  key={c.id}
                  to={`/chat/${c.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="min-w-0 pr-4">
                    <div className="truncate text-sm font-medium">{c.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                      {c.activeProvider === 'groq' ? 'Groq' : 'Gemini'} ·{' '}
                      <span className="font-mono tabular-nums">{c.messageCount}</span> messages
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-400 shrink-0" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-zinc-400">
              No conversations yet. Start an agent task above to begin.
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Recent Tasks</h2>
            <Link to="/tasks" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
              View all
            </Link>
          </div>
          {loading ? (
            <div className="p-5 space-y-3">
              <div className="h-9 rounded bg-slate-100 dark:bg-zinc-800" />
              <div className="h-9 rounded bg-slate-100 dark:bg-zinc-800" />
            </div>
          ) : summary && summary.recentTasks.length > 0 ? (
            <div className="divide-y divide-slate-200 dark:divide-zinc-800">
              {summary.recentTasks.map((t) => (
                <Link
                  key={t.id}
                  to="/tasks"
                  className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="min-w-0 pr-4">
                    <div className="truncate text-sm font-medium">{t.goal}</div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                      Status: {t.status.replace('_', ' ')} · Provider: {t.activeProvider}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-400 shrink-0" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-zinc-400">
              No tracked tasks yet. Ask NEXUS to create a plan or execute a moderate-risk tool.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
