import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GraduationCap,
  Pencil,
  Send,
  Square,
  ThumbsUp,
  Wrench,
  X,
} from 'lucide-react';
import { MarkdownContent } from '../components/MarkdownContent';
import { apiRequest, streamConversationTurn } from '../services/api';
import { ProviderId, ProviderMode } from '../stores/authStore';

interface ToolTrace {
  id: string;
  name: string;
  riskLevel: 'low' | 'moderate' | 'high';
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected';
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider?: ProviderId;
  model?: string;
  latencyMs?: number;
  providerSwitched?: { from: ProviderId; to: ProviderId; reason: string };
  toolCalls: ToolTrace[];
  taskId?: string;
  feedback?: {
    rating: 'good' | 'error';
    note?: string;
    lessonId?: string;
  };
  createdAt: string;
}

interface ConversationMeta {
  id: string;
  title: string;
  providerMode: ProviderMode;
  activeProvider: ProviderId;
}

const SLASH_HINTS = [
  { cmd: '/train ', desc: 'Teach a permanent rule' },
  { cmd: '/correct ', desc: 'Fix mistake => rule' },
  { cmd: '/analyze-errors', desc: 'Learn from thread errors' },
  { cmd: '/lessons', desc: 'List learned rules' },
  { cmd: '/forget ', desc: 'Deactivate matching rule' },
  { cmd: '/test ', desc: 'Verify trained behavior' },
  { cmd: '/help', desc: 'Command reference' },
];

const MODE_OPTIONS: { value: ProviderMode; label: string }[] = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'gemini_only', label: 'Gemini Only' },
  { value: 'groq_only', label: 'Groq Only' },
];

export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();
  const [conversation, setConversation] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providerMode, setProviderMode] = useState<ProviderMode>('automatic');
  const [executionMode, setExecutionMode] = useState<'chat' | 'task'>('chat');
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [streamingTools, setStreamingTools] = useState<ToolTrace[]>([]);
  const [streamingProvider, setStreamingProvider] = useState<ProviderId>('gemini');
  const [switchNotice, setSwitchNotice] = useState<{ from: string; to: string; reason: string } | null>(
    null
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [loading, setLoading] = useState(true);

  const [analyzingThread, setAnalyzingThread] = useState(false);
  const [decidingTaskIds, setDecidingTaskIds] = useState<Record<string, 'approve' | 'reject'>>({});
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});
  const [learningBanner, setLearningBanner] = useState<string | null>(null);
  const [correctingMsgId, setCorrectingMsgId] = useState<string | null>(null);
  const [correctionOrigin, setCorrectionOrigin] = useState<'ai_error' | 'user_correction'>(
    'ai_error'
  );
  const [correctionNote, setCorrectionNote] = useState('');
  const [regenerateAfterTeach, setRegenerateAfterTeach] = useState(true);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const initialTriggeredRef = useRef<string | null>(null);

  const wordQueueRef = useRef<string[]>([]);
  const pendingTailRef = useRef('');
  const pendingDoneMessageRef = useRef<ChatMessage | null>(null);
  const drainTimerRef = useRef<number | null>(null);
  const tailFlushTimerRef = useRef<number | null>(null);
  const streamingTextRef = useRef('');

  function stopWordPacer() {
    if (drainTimerRef.current !== null) {
      window.clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    if (tailFlushTimerRef.current !== null) {
      window.clearTimeout(tailFlushTimerRef.current);
      tailFlushTimerRef.current = null;
    }
    wordQueueRef.current = [];
    pendingTailRef.current = '';
    pendingDoneMessageRef.current = null;
  }

  function flushPendingTail() {
    if (tailFlushTimerRef.current !== null) {
      window.clearTimeout(tailFlushTimerRef.current);
      tailFlushTimerRef.current = null;
    }
    if (pendingTailRef.current) {
      wordQueueRef.current.push(pendingTailRef.current);
      pendingTailRef.current = '';
    }
  }

  function enqueueStreamChunk(chunk: string) {
    if (!chunk) return;
    if (tailFlushTimerRef.current !== null) {
      window.clearTimeout(tailFlushTimerRef.current);
      tailFlushTimerRef.current = null;
    }

    const combined = pendingTailRef.current + chunk;
    const tokens = combined.match(/\S+\s+|\s+|\S+/g) || [];
    if (tokens.length === 0) return;

    const last = tokens[tokens.length - 1];
    // Hold an incomplete trailing non-whitespace fragment briefly so words appear whole
    if (last && !/\s$/.test(last) && !/[.!?,:;)\]]$/.test(last)) {
      pendingTailRef.current = tokens.pop()!;
      tailFlushTimerRef.current = window.setTimeout(() => {
        flushPendingTail();
      }, 45);
    } else {
      pendingTailRef.current = '';
    }

    if (tokens.length > 0) {
      wordQueueRef.current.push(...tokens);
    }
  }

  function finalizeCompletedStream(finalMsg: ChatMessage) {
    stopWordPacer();
    setMessages((prev) => [...prev, finalMsg]);
    setStreamingText('');
    setStreamingTools([]);
    setIsStreaming(false);
    window.dispatchEvent(new Event('nexus:conversations-changed'));
  }

  function startWordPacer() {
    if (drainTimerRef.current !== null) return;
    drainTimerRef.current = window.setInterval(() => {
      const doneMsg = pendingDoneMessageRef.current;
      if (doneMsg) {
        flushPendingTail();
      }

      const queue = wordQueueRef.current;
      if (queue.length === 0) {
        if (doneMsg) {
          finalizeCompletedStream(doneMsg);
        }
        return;
      }

      let count = 1;
      if (doneMsg) {
        count = Math.max(1, Math.min(8, Math.ceil(queue.length / 8)));
      } else if (queue.length > 80) {
        count = 4;
      } else if (queue.length > 35) {
        count = 2;
      }

      const nextSlice = queue.splice(0, count).join('');
      if (nextSlice) {
        streamingTextRef.current += nextSlice;
        setStreamingText(streamingTextRef.current);
      }

      if (doneMsg && queue.length === 0) {
        finalizeCompletedStream(doneMsg);
      }
    }, 22);
  }

  async function loadMessages() {
    if (!conversationId) return;
    setLoading(true);
    try {
      const data = await apiRequest<{ conversation: ConversationMeta; messages: ChatMessage[] }>(
        `/api/conversations/${conversationId}/messages`
      );
      setConversation(data.conversation);
      setProviderMode(data.conversation.providerMode);
      setStreamingProvider(data.conversation.activeProvider);
      setMessages(data.messages);
    } catch (err: any) {
      if (err?.status !== 401) {
        setStreamError(err?.message || 'Unable to load conversation messages.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    abortRef.current?.abort();
    stopWordPacer();
    streamingTextRef.current = '';
    setIsStreaming(false);
    setStreamingText('');
    setStreamingTools([]);
    setStreamError('');
    setSwitchNotice(null);
    setLearningBanner(null);
    setCorrectingMsgId(null);
    setEditingTitle(false);
    setTitleDraft('');
    shouldAutoScrollRef.current = true;
    loadMessages();
    return () => {
      abortRef.current?.abort();
      stopWordPacer();
    };
  }, [conversationId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; title: string }>).detail;
      if (detail && detail.id === conversationId) {
        setConversation((prev) => (prev ? { ...prev, title: detail.title } : prev));
      }
    };
    window.addEventListener('nexus:conversation-renamed', handler);
    return () => window.removeEventListener('nexus:conversation-renamed', handler);
  }, [conversationId]);

  useEffect(() => {
    const state = location.state as { initialPrompt?: string; executionMode?: 'chat' | 'task' } | null;
    if (
      state?.initialPrompt &&
      conversationId &&
      !loading &&
      initialTriggeredRef.current !== conversationId
    ) {
      initialTriggeredRef.current = conversationId;
      const modeToUse = state.executionMode || 'chat';
      setExecutionMode(modeToUse);
      void sendPrompt(state.initialPrompt, modeToUse);
    }
  }, [conversationId, loading]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) {
      bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
      return;
    }
    if (isStreaming) {
      container.scrollTop = container.scrollHeight;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, streamingText, streamingTools.length, isStreaming]);

  async function handleModeChange(nextMode: ProviderMode) {
    setProviderMode(nextMode);
    if (!conversationId) return;
    try {
      await apiRequest(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ providerMode: nextMode }),
      });
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to update provider mode.');
    }
  }

  function startTitleEdit() {
    if (!conversation) return;
    setTitleDraft(conversation.title);
    setEditingTitle(true);
  }

  async function saveTitleEdit() {
    if (!conversationId || !conversation || savingTitle) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === conversation.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    setStreamError('');
    try {
      const data = await apiRequest<{ conversation: ConversationMeta }>(
        `/api/conversations/${conversationId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title: trimmed }),
        }
      );
      setConversation((prev) => (prev ? { ...prev, title: data.conversation.title } : data.conversation));
      setEditingTitle(false);
      window.dispatchEvent(new Event('nexus:conversations-changed'));
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to rename conversation.');
    } finally {
      setSavingTitle(false);
    }
  }

  async function sendPrompt(promptText: string, modeOverride?: 'chat' | 'task') {
    if (!promptText.trim() || !conversationId || isStreaming) return;
    const activeExecMode = modeOverride || executionMode;
    stopWordPacer();
    shouldAutoScrollRef.current = true;
    streamingTextRef.current = '';
    setStreamError('');
    setSwitchNotice(null);
    setStreamingText('');
    setStreamingTools([]);
    setIsStreaming(true);

    const optimisticUser: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: promptText,
      toolCalls: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    const controller = new AbortController();
    abortRef.current = controller;
    startWordPacer();

    let waitingForQueueDrain = false;

    try {
      await streamConversationTurn(
        conversationId,
        { content: promptText, providerMode, executionMode: activeExecMode },
        controller.signal,
        {
          onEvent: (event, data) => {
            if (event === 'user_message') {
              setMessages((prev) => prev.map((m) => (m.id === optimisticUser.id ? data : m)));
            } else if (event === 'meta') {
              setStreamingProvider(data.provider);
            } else if (event === 'provider_switch') {
              setStreamingProvider(data.to);
              setSwitchNotice(data);
            } else if (event === 'tool_update') {
              setStreamingTools((prev) => {
                const idx = prev.findIndex((t) => t.id === data.id);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = data;
                  return copy;
                }
                return [...prev, data];
              });
            } else if (event === 'stream_reset') {
              wordQueueRef.current = [];
              pendingTailRef.current = '';
              streamingTextRef.current = '';
              setStreamingText('');
            } else if (event === 'token') {
              enqueueStreamChunk(data.token || '');
            } else if (event === 'done') {
              flushPendingTail();
              if (wordQueueRef.current.length === 0) {
                streamingTextRef.current = '';
                finalizeCompletedStream(data.message);
              } else {
                waitingForQueueDrain = true;
                pendingDoneMessageRef.current = data.message;
              }
            } else if (event === 'error') {
              stopWordPacer();
              streamingTextRef.current = '';
              setStreamError(data.error || 'Provider execution failed');
              setIsStreaming(false);
            }
          },
        }
      );
    } catch (err: any) {
      stopWordPacer();
      if (err.name === 'AbortError') {
        const partial = streamingTextRef.current.trim();
        if (partial) {
          setMessages((prev) => [
            ...prev,
            {
              id: `aborted-${Date.now()}`,
              role: 'assistant',
              content: partial,
              provider: streamingProvider,
              toolCalls: [],
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      } else {
        setStreamError(err.message || 'Streaming error');
      }
      streamingTextRef.current = '';
      setStreamingText('');
      setIsStreaming(false);
    } finally {
      if (!waitingForQueueDrain && !pendingDoneMessageRef.current) {
        stopWordPacer();
        setIsStreaming(false);
      }
      abortRef.current = null;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const text = input.trim();
    setInput('');
    void sendPrompt(text);
  }

  async function handleTaskDecision(taskId: string, decision: 'approve' | 'reject') {
    if (decidingTaskIds[taskId]) return;
    setDecidingTaskIds((prev) => ({ ...prev, [taskId]: decision }));
    setStreamError('');
    setMessages((prev) =>
      prev.map((m) =>
        m.taskId === taskId
          ? {
              ...m,
              toolCalls: (m.toolCalls || []).map((tc) =>
                tc.status === 'awaiting_approval'
                  ? { ...tc, status: decision === 'approve' ? 'running' : 'rejected' }
                  : tc
              ),
            }
          : m
      )
    );
    try {
      await apiRequest(`/api/tasks/${taskId}/${decision}`, { method: 'POST' });
      await loadMessages();
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to process task approval.');
      await loadMessages().catch(() => undefined);
    } finally {
      setDecidingTaskIds((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  }

  async function handleAnalyzeConversation() {
    if (!conversationId || analyzingThread) return;
    setAnalyzingThread(true);
    setLearningBanner(null);
    setStreamError('');
    try {
      const data = await apiRequest<{ lessons: Array<{ triggerPattern: string }>; summary: string }>(
        '/api/training/analyze-conversation',
        {
          method: 'POST',
          body: JSON.stringify({ conversationId }),
        }
      );
      if (data.lessons.length > 0) {
        setLearningBanner(
          `Learned ${data.lessons.length} rule(s): ${data.lessons
            .map((l) => l.triggerPattern)
            .join(', ')}`
        );
      } else {
        setLearningBanner(data.summary);
      }
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to analyze conversation errors.');
    } finally {
      setAnalyzingThread(false);
    }
  }

  async function handleMarkHelpful(messageId: string) {
    try {
      const data = await apiRequest<{ message: ChatMessage }>('/api/training/feedback', {
        method: 'POST',
        body: JSON.stringify({ messageId, rating: 'good' }),
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: data.message.feedback } : m)));
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to save feedback.');
    }
  }

  async function handleSubmitCorrection(e: React.FormEvent, message: ChatMessage) {
    e.preventDefault();
    if (!correctionNote.trim() || submittingFeedback) return;
    setSubmittingFeedback(true);
    setStreamError('');
    try {
      const data = await apiRequest<{
        message: ChatMessage;
        lesson: { learnedRule: string; triggerPattern: string };
        reinforced?: boolean;
      }>('/api/training/feedback', {
        method: 'POST',
        body: JSON.stringify({
          messageId: message.id,
          rating: 'error',
          note: correctionNote.trim(),
          errorOrigin: correctionOrigin,
        }),
      });

      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, feedback: data.message.feedback } : m))
      );
      setLearningBanner(
        `${data.reinforced ? 'Reinforced' : 'Learned'} rule [${data.lesson.triggerPattern}]: ${data.lesson.learnedRule}`
      );
      const savedNote = correctionNote.trim();
      setCorrectingMsgId(null);
      setCorrectionNote('');

      if (regenerateAfterTeach && message.role === 'assistant') {
        void sendPrompt(
          `Please apply the correction I just taught you ("${savedNote}") and provide the corrected response.`,
          'chat'
        );
      }
    } catch (err: any) {
      setStreamError(err?.message || 'Unable to submit correction.');
    } finally {
      setSubmittingFeedback(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-white dark:bg-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 px-4 sm:px-6 py-3.5">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <div className="flex items-center gap-1.5 max-w-md">
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveTitleEdit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingTitle(false);
                  }
                }}
                maxLength={140}
                autoFocus
                aria-label="Edit chat name"
                className="min-w-0 flex-1 rounded-md border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm font-semibold text-slate-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-blue-500/40"
              />
              <button
                type="button"
                disabled={savingTitle || !titleDraft.trim()}
                onClick={() => void saveTitleEdit()}
                title="Save chat name"
                aria-label="Save chat name"
                className="rounded-md p-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-40 shrink-0"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setEditingTitle(false)}
                title="Cancel rename"
                aria-label="Cancel rename"
                className="rounded-md p-1.5 text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <h1
                onDoubleClick={startTitleEdit}
                title="Double-click to rename"
                className="truncate text-sm font-semibold text-slate-900 dark:text-zinc-100"
              >
                {conversation?.title || 'Conversation'}
              </h1>
              {conversation && (
                <button
                  type="button"
                  onClick={startTitleEdit}
                  title="Rename chat"
                  aria-label="Rename chat"
                  className="rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
            Active provider: {streamingProvider === 'groq' ? 'Groq' : 'Google Gemini'} ·{' '}
            {providerMode.replace('_', ' ')}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleAnalyzeConversation}
            disabled={analyzingThread || messages.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
          >
            <GraduationCap className="h-3.5 w-3.5" />
            <span>{analyzingThread ? 'Learning...' : 'Learn from Thread'}</span>
          </button>

          <div
            role="group"
            aria-label="AI provider routing mode"
            className="inline-flex items-center rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-900 p-1 gap-0.5 shrink-0"
          >
            {MODE_OPTIONS.map((opt) => {
              const active = providerMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleModeChange(opt.value)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                      : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {learningBanner && (
        <div className="border-b border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 px-6 py-2.5 text-xs text-emerald-800 dark:text-emerald-200 flex items-center justify-between gap-4">
          <span>{learningBanner}</span>
          <Link to="/training" className="font-medium underline whitespace-nowrap shrink-0">
            View Training Rules
          </Link>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          shouldAutoScrollRef.current = distFromBottom < 140;
        }}
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-6"
      >
        <div className="mx-auto max-w-3xl min-w-0 space-y-6">
          {loading ? (
            <div className="space-y-4">
              <div className="h-14 rounded-xl bg-slate-100 dark:bg-zinc-900" />
              <div className="h-24 rounded-xl bg-slate-100 dark:bg-zinc-900" />
            </div>
          ) : messages.length === 0 && !isStreaming ? (
            <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 p-8 text-center">
              <h2 className="text-base font-semibold">Ready for instructions</h2>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-zinc-400">
                Use Chat mode for conversational tools or switch to Multi-Step Task mode to generate a checkpointed execution plan.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {[
                  {
                    label: 'Calculate (14850 * 1.08) / 12 and save monthly_budget to memory',
                    mode: 'task' as const,
                  },
                  {
                    label: '/train Always explain TypeScript fixes with a brief root cause.',
                    mode: 'chat' as const,
                  },
                  {
                    label: '/help',
                    mode: 'chat' as const,
                  },
                ].map((sample) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => {
                      setExecutionMode(sample.mode);
                      void sendPrompt(sample.label, sample.mode);
                    }}
                    className="rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-xs text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex min-w-0 w-full flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                {m.providerSwitched?.from && m.providerSwitched?.to && (
                  <div className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                    Failover: switched from {m.providerSwitched.from} to {m.providerSwitched.to} (
                    {m.providerSwitched.reason})
                  </div>
                )}

                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mb-2.5 w-full min-w-0 space-y-2">
                    {m.toolCalls.map((tc) => {
                      const isAwaitingApproval =
                        tc.status === 'awaiting_approval' && Boolean(m.taskId);
                      const hasDetails = Boolean(
                        (tc.args && Object.keys(tc.args).length > 0) || tc.result
                      );
                      const isExpanded = isAwaitingApproval || Boolean(expandedToolIds[tc.id]);

                      return (
                        <div
                          key={tc.id}
                          className="w-full min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 px-4 py-2.5 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 font-medium text-slate-900 dark:text-zinc-100">
                              <Wrench className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                              <span className="font-mono break-all">{tc.name}</span>
                            </div>
                            <div className="flex items-center gap-2.5 text-slate-500 dark:text-zinc-400 font-mono tabular-nums">
                              <span>
                                {tc.riskLevel} risk · {tc.status.replace('_', ' ')}
                                {typeof tc.durationMs === 'number' ? ` · ${tc.durationMs}ms` : ''}
                              </span>
                              {!isAwaitingApproval && hasDetails && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedToolIds((prev) => ({
                                      ...prev,
                                      [tc.id]: !prev[tc.id],
                                    }))
                                  }
                                  className="inline-flex items-center gap-0.5 font-sans text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                  <span>{isExpanded ? 'Hide' : 'Details'}</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {isExpanded && tc.args && Object.keys(tc.args).length > 0 && (
                            <pre className="mt-2 max-h-40 overflow-auto rounded border border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 text-[11px] text-slate-600 dark:text-zinc-400 font-mono whitespace-pre-wrap break-all">
                              {JSON.stringify(tc.args, null, 2)}
                            </pre>
                          )}

                          {isExpanded && !isAwaitingApproval && tc.result && (
                            <pre className="mt-2 max-h-60 overflow-auto rounded border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 text-[11px] text-slate-800 dark:text-zinc-200 font-mono whitespace-pre-wrap break-all">
                              {JSON.stringify(tc.result, null, 2)}
                            </pre>
                          )}

                          {tc.error && (
                            <p className="mt-2 text-red-600 dark:text-red-400">{tc.error}</p>
                          )}

                          {isAwaitingApproval && m.taskId && (
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                type="button"
                                disabled={Boolean(decidingTaskIds[m.taskId])}
                                onClick={() => handleTaskDecision(m.taskId!, 'approve')}
                                className="rounded-md bg-slate-900 dark:bg-zinc-100 px-3 py-1.5 text-xs font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                              >
                                {decidingTaskIds[m.taskId] === 'approve'
                                  ? 'Approving & running...'
                                  : 'Approve & Continue'}
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(decidingTaskIds[m.taskId])}
                                onClick={() => handleTaskDecision(m.taskId!, 'reject')}
                                className="rounded-md border border-slate-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                              >
                                {decidingTaskIds[m.taskId] === 'reject' ? 'Rejecting...' : 'Reject'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div
                  className={`min-w-0 max-w-full overflow-hidden rounded-xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-slate-900 dark:bg-zinc-100 text-white dark:text-zinc-900 max-w-xl break-words [overflow-wrap:anywhere]'
                      : 'border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 w-full'
                  }`}
                >
                  {m.role === 'user' ? (
                    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.content}</p>
                  ) : (
                    <MarkdownContent content={m.content} />
                  )}
                </div>

                {m.role === 'user' && !m.id.startsWith('temp-') && !m.content.startsWith('/') && (
                  <div className="mt-1 flex items-center gap-3 text-xs text-slate-500 dark:text-zinc-500">
                    <button
                      type="button"
                      onClick={() => {
                        setCorrectingMsgId(correctingMsgId === m.id ? null : m.id);
                        setCorrectionOrigin('user_correction');
                        setCorrectionNote('');
                      }}
                      className="hover:text-slate-800 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      {m.feedback?.rating === 'error' ? 'Learned from prompt' : 'Learn from my mistake'}
                    </button>
                  </div>
                )}

                {m.role === 'assistant' && !m.id.startsWith('aborted-') && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-zinc-500 font-mono tabular-nums">
                    {m.provider && (
                      <span>
                        {m.provider} · {m.model || 'model'}
                        {typeof m.latencyMs === 'number' ? ` · ${m.latencyMs}ms` : ''}
                      </span>
                    )}
                    {m.taskId && (
                      <Link
                        to={`/tasks?task=${m.taskId}`}
                        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-sans"
                      >
                        <span>Inspect Task Steps</span>
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}

                    <div className="flex items-center gap-2 font-sans">
                      <button
                        type="button"
                        onClick={() => handleMarkHelpful(m.id)}
                        className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer ${
                          m.feedback?.rating === 'good'
                            ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                            : ''
                        }`}
                      >
                        <ThumbsUp className="h-3 w-3" />
                        <span>{m.feedback?.rating === 'good' ? 'Helpful' : 'Good'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setCorrectingMsgId(correctingMsgId === m.id ? null : m.id);
                          setCorrectionOrigin('ai_error');
                          setCorrectionNote('');
                        }}
                        className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer ${
                          m.feedback?.rating === 'error'
                            ? 'text-amber-600 dark:text-amber-400 font-medium'
                            : ''
                        }`}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        <span>
                          {m.feedback?.rating === 'error' ? 'Trained from Error' : 'Report Error & Teach'}
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {correctingMsgId === m.id && (
                  <form
                    onSubmit={(e) => handleSubmitCorrection(e, m)}
                    className="mt-2.5 w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 p-4 space-y-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-zinc-100">
                        Teach NEXUS from this error
                      </span>
                      <select
                        value={correctionOrigin}
                        onChange={(e) => setCorrectionOrigin(e.target.value as any)}
                        className="rounded border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      >
                        <option value="ai_error">AI response error</option>
                        <option value="user_correction">My mistake / prompt error</option>
                      </select>
                    </div>

                    <textarea
                      rows={2}
                      required
                      value={correctionNote}
                      onChange={(e) => setCorrectionNote(e.target.value)}
                      placeholder="Explain what was wrong and what NEXUS should do instead..."
                      className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs outline-none"
                    />

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {m.role === 'assistant' ? (
                        <label className="inline-flex items-center gap-2 text-slate-600 dark:text-zinc-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={regenerateAfterTeach}
                            onChange={(e) => setRegenerateAfterTeach(e.target.checked)}
                          />
                          <span>Regenerate corrected reply right away</span>
                        </label>
                      ) : (
                        <span />
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setCorrectingMsgId(null)}
                          className="rounded-md border border-slate-200 dark:border-zinc-700 px-3 py-1.5 text-slate-600 dark:text-zinc-300 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={submittingFeedback || !correctionNote.trim()}
                          className="rounded-md bg-slate-900 dark:bg-zinc-100 px-3 py-1.5 font-medium text-white dark:text-zinc-900 cursor-pointer disabled:opacity-50"
                        >
                          {submittingFeedback ? 'Learning...' : 'Save Rule & Teach'}
                        </button>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            ))
          )}

          {isStreaming && (
            <div className="flex flex-col items-start space-y-2">
              {switchNotice && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  Failover triggered: {switchNotice.from} to {switchNotice.to} ({switchNotice.reason})
                </div>
              )}

              {streamingTools.map((tc) => (
                <div
                  key={tc.id}
                  className="w-full rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 px-4 py-3 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-medium">{tc.name}</span>
                    <span className="font-mono text-slate-500 dark:text-zinc-400">
                      {tc.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              ))}

              <div className="w-full min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm leading-relaxed">
                {streamingText ? (
                  <MarkdownContent content={streamingText} streaming />
                ) : (
                  <span className="text-slate-500 dark:text-zinc-400">
                    {executionMode === 'task'
                      ? `Planning and executing steps via ${streamingProvider}...`
                      : `Thinking via ${streamingProvider}...`}
                  </span>
                )}
              </div>
            </div>
          )}

          {streamError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {streamError}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4"
      >
        <div className="mx-auto max-w-3xl space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-100/80 dark:bg-zinc-900 p-0.5 gap-0.5">
              <button
                type="button"
                onClick={() => setExecutionMode('chat')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap cursor-pointer ${
                  executionMode === 'chat'
                    ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('task')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap cursor-pointer ${
                  executionMode === 'task'
                    ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                Multi-Step Task
              </button>
            </div>
            <span className="text-xs text-slate-500 dark:text-zinc-500">
              {executionMode === 'task'
                ? 'Decomposes into checkpointed steps with approval gates'
                : 'Interactive tool-assisted conversation'}
            </span>
          </div>

          {input.startsWith('/') && (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 p-2">
              {SLASH_HINTS.filter((h) => h.cmd.startsWith(input.split(' ')[0].toLowerCase())).map(
                (h) => (
                  <button
                    key={h.cmd}
                    type="button"
                    onClick={() => setInput(h.cmd)}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <span className="font-mono font-medium">{h.cmd.trim()}</span>
                    <span className="text-slate-500 dark:text-zinc-400">{h.desc}</span>
                  </button>
                )
              )}
            </div>
          )}

          <div className="flex items-end gap-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-900 p-2">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={
                executionMode === 'task'
                  ? 'Describe a multi-step goal for NEXUS to plan and execute...'
                  : 'Ask NEXUS or type /train, /correct, /analyze-errors, /help...'
              }
              className="max-h-40 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-2.5 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 cursor-pointer"
                title="Stop generation"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-lg bg-slate-900 dark:bg-zinc-100 p-2.5 text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors cursor-pointer disabled:opacity-40"
                title="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
