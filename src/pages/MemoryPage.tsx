import { useEffect, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { apiRequest } from '../services/api';

interface MemoryItem {
  id: string;
  key: string;
  value: string;
  category: 'preference' | 'fact' | 'workflow';
  source: 'user' | 'agent';
  updatedAt: string;
}

export function MemoryPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [valueInput, setValueInput] = useState('');
  const [category, setCategory] = useState<'preference' | 'fact' | 'workflow'>('preference');
  const [loading, setLoading] = useState(true);

  async function loadMemories() {
    setLoading(true);
    try {
      const data = await apiRequest<{ memories: MemoryItem[] }>('/api/memories');
      setMemories(data.memories);
    } catch {
      // Auth/network errors handled cleanly
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMemories();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!keyInput.trim() || !valueInput.trim()) return;
    await apiRequest('/api/memories', {
      method: 'POST',
      body: JSON.stringify({ key: keyInput.trim(), value: valueInput.trim(), category }),
    });
    setKeyInput('');
    setValueInput('');
    await loadMemories();
  }

  async function handleDelete(id: string) {
    await apiRequest(`/api/memories/${id}`, { method: 'DELETE' });
    await loadMemories();
  }

  const filtered = memories.filter(
    (m) =>
      !search.trim() ||
      m.key.toLowerCase().includes(search.toLowerCase()) ||
      m.value.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-6">
      <header className="border-b border-slate-200 dark:border-zinc-800 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Persistent Memory</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
          Facts, coding preferences, and workflow rules automatically injected into agent reasoning.
        </p>
      </header>

      <form
        onSubmit={handleAdd}
        className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 grid grid-cols-1 md:grid-cols-12 gap-3"
      >
        <input
          type="text"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="Key (e.g. primary_language)"
          required
          className="md:col-span-3 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
        />
        <input
          type="text"
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value)}
          placeholder="Value (e.g. TypeScript with strict mode)"
          required
          className="md:col-span-5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as any)}
          className="md:col-span-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 px-3 py-2 text-sm"
        >
          <option value="preference">Preference</option>
          <option value="fact">Fact</option>
          <option value="workflow">Workflow</option>
        </select>
        <button
          type="submit"
          className="md:col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Save</span>
        </button>
      </form>

      <div className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
        <Search className="h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter memories by key or content..."
          className="flex-1 bg-transparent text-sm outline-none"
        />
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading memories...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-zinc-400">
            No memories found.
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-zinc-800">
            {filtered.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-zinc-400">
                    <span className="font-mono font-medium text-slate-900 dark:text-zinc-100">
                      {m.key}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{m.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>source: {m.source}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700 dark:text-zinc-300">{m.value}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(m.id)}
                  title="Delete memory"
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-red-600 cursor-pointer shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
