import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Play,
  Plus,
  Search,
  Sparkles,
  Terminal,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { apiRequest } from '../services/api';
import { useAuthStore } from '../stores/authStore';

interface TrainingLesson {
  id: string;
  source: 'user_correction' | 'ai_error' | 'tool_error' | 'command';
  triggerPattern: string;
  mistakeSummary: string;
  learnedRule: string;
  exampleCorrection?: string;
  confidence: number;
  timesApplied: number;
  active: boolean;
  updatedAt: string;
}

interface CommandMeta {
  cmd: string;
  desc: string;
  example: string;
}

interface CommandOutputItem {
  command: string;
  ok: boolean;
  replyMarkdown: string;
}

const SOURCE_LABELS: Record<TrainingLesson['source'], string> = {
  ai_error: 'AI error',
  user_correction: 'User correction',
  tool_error: 'Tool error',
  command: 'Command',
};

export function TrainingPage() {
  const { user, setUser, accessToken } = useAuthStore();
  const [lessons, setLessons] = useState<TrainingLesson[]>([]);
  const [commands, setCommands] = useState<CommandMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const [cmdInput, setCmdInput] = useState(
    '/train Always verify edge cases and explain root causes when debugging errors.'
  );
  const [runningCmd, setRunningCmd] = useState(false);
  const [cmdOutputs, setCmdOutputs] = useState<CommandOutputItem[]>([]);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const [triggerPattern, setTriggerPattern] = useState('');
  const [mistakeSummary, setMistakeSummary] = useState('');
  const [learnedRule, setLearnedRule] = useState('');
  const [exampleCorrection, setExampleCorrection] = useState('');
  const [savingRule, setSavingRule] = useState(false);

  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [pageError, setPageError] = useState('');

  async function loadLessons() {
    setLoading(true);
    try {
      const data = await apiRequest<{ lessons: TrainingLesson[]; commands: CommandMeta[] }>(
        '/api/training/lessons'
      );
      setLessons(data.lessons);
      setCommands(data.commands);
      setPageError('');
    } catch (err: any) {
      if (err?.status !== 401) {
        setPageError(err?.message || 'Unable to load training lessons.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLessons();
  }, []);

  async function handleToggleAutoLearn() {
    setPageError('');
    try {
      const next = !(user?.preferences.autoLearnFromErrors ?? true);
      const data = await apiRequest<{ user: any }>('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ autoLearnFromErrors: next }),
      });
      setUser(data.user);
    } catch (err: any) {
      setPageError(err?.message || 'Unable to update auto-learn preference.');
    }
  }

  async function handleRunCommands(e: React.FormEvent) {
    e.preventDefault();
    if (!cmdInput.trim() || runningCmd) return;
    setRunningCmd(true);
    setPageError('');
    try {
      const isBatch = cmdInput.trim().includes('\n');
      const data = await apiRequest<any>('/api/training/command', {
        method: 'POST',
        body: JSON.stringify(isBatch ? { script: cmdInput } : { command: cmdInput.trim() }),
      });

      if (data.batch && Array.isArray(data.results)) {
        setCmdOutputs(data.results);
      } else if (data.result) {
        setCmdOutputs([data.result]);
      }
      await loadLessons();
    } catch (err: any) {
      setPageError(err?.message || 'Unable to execute training command.');
    } finally {
      setRunningCmd(false);
    }
  }

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    if (!triggerPattern.trim() || !mistakeSummary.trim() || !learnedRule.trim()) return;
    setSavingRule(true);
    setPageError('');
    try {
      await apiRequest('/api/training/lessons', {
        method: 'POST',
        body: JSON.stringify({
          triggerPattern: triggerPattern.trim(),
          mistakeSummary: mistakeSummary.trim(),
          learnedRule: learnedRule.trim(),
          exampleCorrection: exampleCorrection.trim(),
          source: 'command',
        }),
      });
      setTriggerPattern('');
      setMistakeSummary('');
      setLearnedRule('');
      setExampleCorrection('');
      await loadLessons();
    } catch (err: any) {
      setPageError(err?.message || 'Unable to save training lesson.');
    } finally {
      setSavingRule(false);
    }
  }

  async function handlePatchLesson(id: string, patch: { active?: boolean; reinforce?: boolean }) {
    setPageError('');
    try {
      await apiRequest(`/api/training/lessons/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadLessons();
    } catch (err: any) {
      setPageError(err?.message || 'Unable to update training lesson.');
    }
  }

  async function handleDeleteLesson(id: string) {
    setPageError('');
    try {
      await apiRequest(`/api/training/lessons/${id}`, { method: 'DELETE' });
      await loadLessons();
    } catch (err: any) {
      setPageError(err?.message || 'Unable to delete training lesson.');
    }
  }

  const curlSnippet = `curl -X POST "${window.location.origin}/api/training/command" \\\n  -H "Authorization: Bearer ${accessToken ? '<YOUR_TOKEN>' : '<ACCESS_TOKEN>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"command": "/train Always validate JSON payloads before parsing."}'`;

  function handleCopyCurl() {
    navigator.clipboard.writeText(curlSnippet);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 1500);
  }

  const filtered = lessons.filter((l) => {
    const matchesSource = sourceFilter === 'all' || l.source === sourceFilter;
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      l.triggerPattern.toLowerCase().includes(q) ||
      l.mistakeSummary.toLowerCase().includes(q) ||
      l.learnedRule.toLowerCase().includes(q);
    return matchesSource && matchesSearch;
  });

  const autoLearnEnabled = user?.preferences.autoLearnFromErrors ?? true;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Training & Error Learning</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            Train NEXUS through slash commands, batch scripts, and mistakes flagged in chat. Active rules are injected into every conversation and task plan.
          </p>
        </div>

        <button
          type="button"
          onClick={handleToggleAutoLearn}
          className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium cursor-pointer transition-colors ${
            autoLearnEnabled
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
              : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Auto-Learn Tool Errors: {autoLearnEnabled ? 'On' : 'Off'}</span>
        </button>
      </header>

      {pageError && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {pageError}
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-slate-500" />
              <h2 className="text-base font-semibold">Command Trainer (Single or Batch Script)</h2>
            </div>
            <span className="text-xs text-slate-500 dark:text-zinc-400 font-mono">
              /train · /correct · /test · /forget
            </span>
          </div>

          <form onSubmit={handleRunCommands} className="space-y-3">
            <textarea
              rows={6}
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              placeholder="/train Use strict TypeScript types&#10;/correct Missing null guard => Always check nullable inputs first"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3.5 py-2.5 font-mono text-xs outline-none focus:ring-2 focus:ring-blue-500/40 resize-y"
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {commands.slice(0, 5).map((c) => (
                  <button
                    key={c.cmd}
                    type="button"
                    onClick={() => setCmdInput(c.example)}
                    className="rounded border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-2 py-1 font-mono text-[11px] text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    {c.cmd.split(' ')[0]}
                  </button>
                ))}
              </div>

              <button
                type="submit"
                disabled={runningCmd || !cmdInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{runningCmd ? 'Training...' : 'Execute Command(s)'}</span>
              </button>
            </div>
          </form>

          {cmdOutputs.length > 0 && (
            <div className="max-h-72 overflow-y-auto space-y-2 pt-2 border-t border-slate-200 dark:border-zinc-800">
              {cmdOutputs.map((out, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-medium truncate max-w-[420px]" title={out.command}>
                      {out.command}
                    </span>
                    <span
                      className={
                        out.ok
                          ? 'shrink-0 text-emerald-600 dark:text-emerald-400'
                          : 'shrink-0 text-red-600 dark:text-red-400'
                      }
                    >
                      {out.ok ? 'applied' : 'notice'}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-xs text-slate-700 dark:text-zinc-300">
                    {out.replyMarkdown}
                  </pre>
                </div>
              ))}
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 dark:border-zinc-800 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-zinc-400">
              <span>CLI / HTTP Training Request</span>
              <button
                type="button"
                onClick={handleCopyCurl}
                className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer"
              >
                {copiedCurl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedCurl ? 'Copied' : 'Copy cURL'}</span>
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-3 font-mono text-[11px] text-slate-700 dark:text-zinc-300">
              {curlSnippet}
            </pre>
          </div>
        </div>

        <form
          onSubmit={handleAddRule}
          className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-3"
        >
          <h2 className="text-base font-semibold">Add Direct Training Lesson</h2>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Explicitly define a mistake pattern and the corrective rule NEXUS should enforce.
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
              Trigger / Topic Pattern
            </label>
            <input
              type="text"
              required
              value={triggerPattern}
              onChange={(e) => setTriggerPattern(e.target.value)}
              placeholder="e.g. Async Express route error handling"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
              Mistake to Avoid (Yours or AI&apos;s)
            </label>
            <input
              type="text"
              required
              value={mistakeSummary}
              onChange={(e) => setMistakeSummary(e.target.value)}
              placeholder="e.g. Unhandled promise rejections crash request flow"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
              Learned Corrective Rule
            </label>
            <textarea
              rows={2}
              required
              value={learnedRule}
              onChange={(e) => setLearnedRule(e.target.value)}
              placeholder="e.g. Wrap async handlers with try/catch and pass errors cleanly."
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
              Example Correction (Optional)
            </label>
            <input
              type="text"
              value={exampleCorrection}
              onChange={(e) => setExampleCorrection(e.target.value)}
              placeholder="e.g. try { ... } catch (err) { next(err); }"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={savingRule}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            <span>{savingRule ? 'Saving...' : 'Save Training Lesson'}</span>
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-1 min-w-[240px] items-center gap-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search learned rules, triggers, or error summaries..."
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs font-medium"
          >
            <option value="all">All Sources ({lessons.length})</option>
            <option value="ai_error">AI Errors</option>
            <option value="user_correction">User Corrections</option>
            <option value="tool_error">Tool Errors</option>
            <option value="command">Commands</option>
          </select>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Loading training lessons...</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-zinc-400">
              No training lessons yet. Report an error in chat or run a `/train` command above to start training NEXUS.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-zinc-800">
              {filtered.map((lesson) => (
                <div key={lesson.id} className="px-5 py-4 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-900 dark:text-zinc-100">
                        {lesson.triggerPattern}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600 dark:text-zinc-400">
                        {SOURCE_LABELS[lesson.source]}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-zinc-400">
                        confidence {lesson.confidence} · applied {lesson.timesApplied}x
                      </span>
                      {!lesson.active && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span className="text-amber-600 dark:text-amber-400">paused</span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => handlePatchLesson(lesson.id, { reinforce: true })}
                        title="Reinforce confidence (+1)"
                        className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-zinc-700 px-2 py-1 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                      >
                        <ThumbsUp className="h-3 w-3" />
                        <span>+1</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePatchLesson(lesson.id, { active: !lesson.active })}
                        className="rounded border border-slate-200 dark:border-zinc-700 px-2 py-1 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                      >
                        {lesson.active ? 'Pause' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteLesson(lesson.id)}
                        title="Delete rule"
                        className="rounded p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    <span className="font-medium text-slate-700 dark:text-zinc-300">Mistake:</span>{' '}
                    {lesson.mistakeSummary}
                  </p>
                  <p className="text-sm text-slate-900 dark:text-zinc-100">
                    <span className="font-medium">Rule:</span> {lesson.learnedRule}
                  </p>
                  {lesson.exampleCorrection && (
                    <pre className="overflow-x-auto rounded border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-2 font-mono text-[11px] text-slate-700 dark:text-zinc-300">
                      {lesson.exampleCorrection}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
