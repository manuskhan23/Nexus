import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Play, RotateCcw, XCircle } from 'lucide-react';
import { MarkdownContent } from '../components/MarkdownContent';
import { apiRequest, subscribeTaskStream } from '../services/api';

interface TaskStep {
  stepId: string;
  action: string;
  toolName?: string;
  riskLevel: 'low' | 'moderate' | 'high';
  status: string;
  idempotencyKey?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  verified?: boolean;
  retries?: number;
  error?: string;
  durationMs?: number;
}

interface TaskItem {
  id: string;
  conversationId?: string;
  goal: string;
  status:
    | 'pending'
    | 'planning'
    | 'running'
    | 'awaiting_approval'
    | 'paused'
    | 'completed'
    | 'partially_completed'
    | 'failed'
    | 'cancelled';
  providerMode: string;
  activeProvider: string;
  currentStepIndex?: number;
  finalReport?: string;
  error?: string;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
}

type StatusFilter = 'all' | 'awaiting_approval' | 'running' | 'completed' | 'failed';

export function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('task'));
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [goalInput, setGoalInput] = useState('');
  const [launching, setLaunching] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  async function loadTasks() {
    setLoading(true);
    try {
      const data = await apiRequest<{ tasks: TaskItem[] }>('/api/tasks');
      setTasks(data.tasks);
      if (!selectedId && data.tasks.length > 0) {
        setSelectedId(data.tasks[0].id);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTasks();
  }, []);

  const selectedTask = tasks.find((t) => t.id === selectedId) || null;

  useEffect(() => {
    if (!selectedTask) return;
    if (selectedTask.status !== 'planning' && selectedTask.status !== 'running') return;

    const controller = new AbortController();
    void subscribeTaskStream(selectedTask.id, controller.signal, {
      onEvent: (_event, payload) => {
        const nextTask = payload?.task ? payload.task : payload;
        if (nextTask?.id) {
          setTasks((prev) => prev.map((t) => (t.id === nextTask.id ? nextTask : t)));
        }
      },
    });
    return () => controller.abort();
  }, [selectedTask?.id, selectedTask?.status]);

  async function handleLaunchTask(e: React.FormEvent) {
    e.preventDefault();
    if (!goalInput.trim() || launching) return;
    setLaunching(true);
    setErrorMsg('');
    try {
      const data = await apiRequest<{ task: TaskItem }>('/api/tasks/run', {
        method: 'POST',
        body: JSON.stringify({ goal: goalInput.trim() }),
      });
      setGoalInput('');
      setTasks((prev) => [data.task, ...prev.filter((t) => t.id !== data.task.id)]);
      setSelectedId(data.task.id);
      setSearchParams({ task: data.task.id });
    } catch (err: any) {
      setErrorMsg(err.message || 'Unable to start task');
    } finally {
      setLaunching(false);
    }
  }

  async function handleTaskAction(
    id: string,
    action: 'approve' | 'reject' | 'retry' | 'cancel'
  ) {
    setActionBusy(true);
    setErrorMsg('');
    try {
      const data = await apiRequest<{ task: TaskItem }>(`/api/tasks/${id}/${action}`, {
        method: 'POST',
      });
      setTasks((prev) => prev.map((t) => (t.id === data.task.id ? data.task : t)));
    } catch (err: any) {
      setErrorMsg(err.message || `Failed to ${action} task`);
    } finally {
      setActionBusy(false);
    }
  }

  const filtered = tasks.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'running') return t.status === 'running' || t.status === 'planning' || t.status === 'pending';
    if (filter === 'completed') return t.status === 'completed' || t.status === 'partially_completed';
    if (filter === 'failed') return t.status === 'failed' || t.status === 'cancelled';
    return t.status === filter;
  });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks & Orchestrator</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            Launch planned multi-step workflows, approve moderate/high-risk steps, and inspect verified results.
          </p>
        </div>

        <div className="inline-flex rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-900 p-1 gap-0.5 overflow-x-auto">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'awaiting_approval', label: 'Needs Approval' },
              { id: 'running', label: 'Active' },
              { id: 'completed', label: 'Completed' },
              { id: 'failed', label: 'Failed / Cancelled' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                filter === tab.id
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                  : 'text-slate-600 dark:text-zinc-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <form
        onSubmit={handleLaunchTask}
        className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 p-4 flex flex-col sm:flex-row gap-3"
      >
        <input
          type="text"
          value={goalInput}
          onChange={(e) => setGoalInput(e.target.value)}
          placeholder="Describe a multi-step goal (e.g. Calculate (3200 * 1.15) / 12 and save my monthly budget to memory)..."
          className="flex-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3.5 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
        />
        <button
          type="submit"
          disabled={!goalInput.trim() || launching}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          <span>{launching ? 'Planning & Running...' : 'Plan & Run Task'}</span>
        </button>
      </form>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 h-64 rounded-xl bg-slate-100 dark:bg-zinc-900" />
          <div className="lg:col-span-7 h-64 rounded-xl bg-slate-100 dark:bg-zinc-900" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-10 text-center">
          <p className="text-sm text-slate-600 dark:text-zinc-400">
            No tasks match this filter yet. Launch a multi-step task above to inspect step-by-step planning, approval pauses, and verification.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-slate-200 dark:divide-zinc-800 overflow-hidden">
            {filtered.map((task) => {
              const active = selectedTask?.id === task.id;
              const completedSteps = task.steps.filter((s) => s.status === 'completed').length;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(task.id);
                    setSearchParams({ task: task.id });
                  }}
                  className={`w-full text-left px-4 py-3.5 transition-colors cursor-pointer ${
                    active
                      ? 'bg-slate-100 dark:bg-zinc-800/80'
                      : 'hover:bg-slate-50 dark:hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-zinc-100 line-clamp-2">
                    {task.goal}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400 font-mono tabular-nums">
                    <span
                      className={
                        task.status === 'awaiting_approval'
                          ? 'text-amber-600 dark:text-amber-400 font-medium'
                          : task.status === 'failed'
                          ? 'text-red-600 dark:text-red-400 font-medium'
                          : task.status === 'completed'
                          ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                          : ''
                      }
                    >
                      {task.status.replace('_', ' ')}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {completedSteps}/{task.steps.length} steps
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{task.activeProvider}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
            {selectedTask ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                      {selectedTask.goal}
                    </h2>
                    <div className="mt-1 text-xs text-slate-500 dark:text-zinc-400 font-mono tabular-nums">
                      {selectedTask.status.replace('_', ' ')} · {selectedTask.activeProvider} ·{' '}
                      {new Date(selectedTask.updatedAt).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {selectedTask.conversationId && (
                      <Link
                        to={`/chat/${selectedTask.conversationId}`}
                        className="rounded-lg border border-slate-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 whitespace-nowrap"
                      >
                        Open Chat
                      </Link>
                    )}

                    {selectedTask.status === 'awaiting_approval' && (
                      <>
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleTaskAction(selectedTask.id, 'approve')}
                          className="rounded-lg bg-slate-900 dark:bg-zinc-100 px-3 py-1.5 text-xs font-medium text-white dark:text-zinc-900 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          Approve & Continue
                        </button>
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleTaskAction(selectedTask.id, 'reject')}
                          className="rounded-lg border border-slate-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          Reject
                        </button>
                      </>
                    )}

                    {selectedTask.status === 'failed' && (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleTaskAction(selectedTask.id, 'retry')}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-zinc-100 px-3 py-1.5 text-xs font-medium text-white dark:text-zinc-900 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Retry Step</span>
                      </button>
                    )}

                    {(selectedTask.status === 'running' ||
                      selectedTask.status === 'awaiting_approval' ||
                      selectedTask.status === 'pending') && (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleTaskAction(selectedTask.id, 'cancel')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        <span>Cancel</span>
                      </button>
                    )}
                  </div>
                </div>

                {selectedTask.error && (
                  <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
                    {selectedTask.error}
                  </div>
                )}

                <div className="space-y-3">
                  <h3 className="text-xs font-medium text-slate-500 dark:text-zinc-400">
                    Execution Steps
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-zinc-800 border-t border-b border-slate-200 dark:border-zinc-800">
                    {selectedTask.steps.map((step, idx) => (
                      <div key={step.stepId} className="py-3.5 space-y-2">
                        <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
                          <div className="flex items-start gap-2 min-w-0 flex-1">
                            <span className="font-mono tabular-nums text-slate-400 shrink-0">
                              {String(idx + 1).padStart(2, '0')}.
                            </span>
                            <span className="font-medium text-slate-900 dark:text-zinc-100">
                              {step.action}
                            </span>
                          </div>
                          <div className="font-mono tabular-nums text-slate-500 dark:text-zinc-400 shrink-0">
                            {step.toolName ? `${step.toolName} · ` : ''}
                            {step.riskLevel} risk · {step.status.replace('_', ' ')}
                            {step.verified ? ' · verified' : ''}
                            {typeof step.durationMs === 'number' ? ` · ${step.durationMs}ms` : ''}
                          </div>
                        </div>

                        {step.args && Object.keys(step.args).length > 0 && (
                          <pre className="overflow-x-auto rounded bg-slate-50 dark:bg-zinc-950 p-2 text-[11px] font-mono text-slate-600 dark:text-zinc-400">
                            Input: {JSON.stringify(step.args)}
                          </pre>
                        )}
                        {step.result && (
                          <pre className="overflow-x-auto rounded bg-slate-50 dark:bg-zinc-950 p-2 text-[11px] font-mono text-slate-800 dark:text-zinc-200">
                            {JSON.stringify(step.result, null, 2)}
                          </pre>
                        )}
                        {step.error && (
                          <p className="text-xs text-red-600 dark:text-red-400">{step.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {selectedTask.finalReport && (
                  <div className="space-y-2 pt-2 min-w-0">
                    <h3 className="text-xs font-medium text-slate-500 dark:text-zinc-400">
                      Final Verified Report
                    </h3>
                    <div className="min-w-0 max-w-full overflow-hidden text-sm leading-relaxed text-slate-800 dark:text-zinc-200">
                      <MarkdownContent content={selectedTask.finalReport} />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="p-8 text-center text-sm text-slate-500">
                Select a task to inspect its steps and verified results.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
