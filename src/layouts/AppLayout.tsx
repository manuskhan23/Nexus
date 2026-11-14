import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Brain,
  Check,
  CheckSquare,
  Cpu,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquarePlus,
  Pencil,
  Plug,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';
import { apiRequest } from '../services/api';
import { getStoredRefreshToken, useAuthStore } from '../stores/authStore';

export interface ConversationItem {
  id: string;
  title: string;
  providerMode: 'automatic' | 'gemini_only' | 'groq_only';
  activeProvider: 'gemini' | 'groq';
  messageCount: number;
  lastMessageAt: string;
}

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/connectors', label: 'Connectors', icon: Plug },
  { to: '/training', label: 'AI Training', icon: GraduationCap },
  { to: '/providers', label: 'AI Providers', icon: Cpu },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, clearSession } = useAuthStore();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  async function loadConversations() {
    try {
      const data = await apiRequest<{ conversations: ConversationItem[] }>('/api/conversations');
      setConversations(data.conversations);
    } catch {
      // Handled by auth interceptor
    }
  }

  useEffect(() => {
    loadConversations();
  }, [location.pathname]);

  useEffect(() => {
    const handler = () => loadConversations();
    window.addEventListener('nexus:conversations-changed', handler);
    return () => window.removeEventListener('nexus:conversations-changed', handler);
  }, []);

  async function handleNewChat() {
    if (creating) return;
    setCreating(true);
    try {
      const data = await apiRequest<{ conversation: ConversationItem }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadConversations();
      setMobileOpen(false);
      navigate(`/chat/${data.conversation.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteConversation(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await apiRequest(`/api/conversations/${id}`, { method: 'DELETE' });
      await loadConversations();
      if (location.pathname === `/chat/${id}`) {
        navigate('/dashboard');
      }
    } catch {
      // Handled by auth interceptor or reload
    }
  }

  function startEditingConversation(e: React.MouseEvent, conv: ConversationItem) {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(conv.id);
    setEditingTitle(conv.title);
  }

  function cancelEditingConversation(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    setEditingId(null);
    setEditingTitle('');
  }

  async function saveConversationTitle(id: string) {
    const trimmed = editingTitle.trim();
    const current = conversations.find((c) => c.id === id);
    if (!trimmed || (current && trimmed === current.title)) {
      setEditingId(null);
      setEditingTitle('');
      return;
    }
    if (savingRename) return;
    setSavingRename(true);
    try {
      const data = await apiRequest<{ conversation: ConversationItem }>(
        `/api/conversations/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title: trimmed }),
        }
      );
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: data.conversation.title } : c))
      );
      window.dispatchEvent(
        new CustomEvent('nexus:conversation-renamed', {
          detail: { id, title: data.conversation.title },
        })
      );
      setEditingId(null);
      setEditingTitle('');
    } catch {
      // Keep editor open or revert on failure
    } finally {
      setSavingRename(false);
    }
  }

  async function handleLogout() {
    const refreshToken = getStoredRefreshToken();
    await apiRequest('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    }).catch(() => undefined);
    clearSession();
    navigate('/login');
  }

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-zinc-900/70 border-r border-slate-200 dark:border-zinc-800">
      <div className="flex items-center justify-between px-4 py-4 border-b border-slate-200 dark:border-zinc-800">
        <NavLink
          to="/dashboard"
          onClick={() => setMobileOpen(false)}
          className="text-base font-bold tracking-tight text-slate-900 dark:text-zinc-100 whitespace-nowrap shrink-0"
        >
          NEXUS
        </NavLink>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="lg:hidden rounded-md p-1.5 text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3">
        <button
          type="button"
          onClick={handleNewChat}
          disabled={creating}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-3 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>{creating ? 'Creating...' : 'New Chat'}</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 space-y-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 font-medium border border-slate-200 dark:border-zinc-700'
                  : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-200/60 dark:hover:bg-zinc-800/60 hover:text-slate-900 dark:hover:text-zinc-100'
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
          </NavLink>
        ))}

        <div className="pt-5 pb-1.5 px-3 text-xs font-medium text-slate-500 dark:text-zinc-500">
          Recent Conversations
        </div>
        <div className="space-y-0.5 pb-4">
          {conversations.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-slate-500 dark:text-zinc-500">
              No conversations yet
            </p>
          ) : (
            conversations.map((conv) =>
              editingId === conv.id ? (
                <div
                  key={conv.id}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600"
                >
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void saveConversationTitle(conv.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditingConversation();
                      }
                    }}
                    maxLength={140}
                    autoFocus
                    aria-label="Edit conversation name"
                    className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-900 dark:text-zinc-100 outline-none"
                  />
                  <button
                    type="button"
                    disabled={savingRename || !editingTitle.trim()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void saveConversationTitle(conv.id)}
                    title="Save name"
                    aria-label="Save conversation name"
                    className="rounded p-1 text-emerald-600 dark:text-emerald-400 hover:bg-slate-100 dark:hover:bg-zinc-700 cursor-pointer disabled:opacity-40 shrink-0"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={cancelEditingConversation}
                    title="Cancel"
                    aria-label="Cancel rename"
                    className="rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 cursor-pointer shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <NavLink
                  key={conv.id}
                  to={`/chat/${conv.id}`}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    `group flex items-center justify-between gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      isActive
                        ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 font-medium border border-slate-200 dark:border-zinc-700'
                        : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-200/60 dark:hover:bg-zinc-800/60 hover:text-slate-900 dark:hover:text-zinc-100'
                    }`
                  }
                >
                  <span className="truncate flex-1 min-w-0">{conv.title}</span>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => startEditingConversation(e, conv)}
                      title="Rename conversation"
                      aria-label="Rename conversation"
                      className="rounded p-1 text-slate-400 hover:text-slate-800 dark:hover:text-zinc-100 cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteConversation(e, conv.id)}
                      title="Delete conversation"
                      aria-label="Delete conversation"
                      className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </NavLink>
              )
            )
          )}
        </div>
      </nav>

      <div className="border-t border-slate-200 dark:border-zinc-800 p-3 space-y-3">
        <ThemeToggle compact />
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-slate-900 dark:text-zinc-100">
              {user?.fullName}
            </p>
            <p className="truncate text-xs text-slate-500 dark:text-zinc-400">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            title="Sign out"
            className="rounded-lg p-2 text-slate-500 dark:text-zinc-400 hover:bg-slate-200/60 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-zinc-100 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100">
      <aside className="hidden lg:block w-64 shrink-0 h-full">{sidebarContent}</aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-50 w-64 h-full">{sidebarContent}</aside>
        </div>
      )}

      <div className="flex flex-1 flex-col min-w-0 h-full overflow-hidden">
        <div className="flex lg:hidden items-center justify-between border-b border-slate-200 dark:border-zinc-800 px-4 py-3 bg-white dark:bg-zinc-950">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1.5 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-900"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-bold tracking-tight">NEXUS</span>
          <div className="w-8" />
        </div>

        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
