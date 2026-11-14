import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { ApiError, apiRequest } from '../services/api';

interface CatalogConnector {
  slug: string;
  name: string;
  category: 'Developer' | 'Workspace' | 'Communication' | 'Project Management' | 'CRM & Commerce';
  description: string;
  authType: 'bearer' | 'api_key_header' | 'basic' | 'webhook';
  authHeaderName?: string;
  baseUrl: string;
  defaultTestPath: string;
  primaryFieldLabel: string;
  primaryFieldPlaceholder: string;
  secondaryFieldLabel?: string;
  secondaryFieldPlaceholder?: string;
  domainFieldLabel?: string;
  domainFieldPlaceholder?: string;
  docsHint: string;
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface SavedConnector {
  id: string;
  kind: 'catalog' | 'custom_api' | 'mcp_server' | 'composio_oauth';
  slug: string;
  name: string;
  category: string;
  description: string;
  baseUrl: string;
  healthPath: string;
  authType: 'bearer' | 'api_key_header' | 'basic' | 'webhook' | 'oauth' | 'none';
  authHeaderName?: string;
  secretHint?: string;
  status: 'connected' | 'error';
  lastTestedAt: string;
  lastLatencyMs: number;
  lastTestMessage: string;
  discoveredTools: McpToolSchema[];
  active: boolean;
}

interface OAuthStatusResponse {
  composioConfigured: boolean;
  appUrl: string;
  callbackUrl: string;
  directOAuthSlugs: string[];
  providers: Record<
    string,
    {
      oauthSupported: boolean;
      readyMode: 'composio' | 'direct_env' | 'needs_setup';
      envKeyHint?: string;
      setupDocsUrl?: string;
    }
  >;
}

interface TestResponse {
  ok: boolean;
  latencyMs: number;
  message: string;
  identity?: string;
  discoveredTools: McpToolSchema[];
  verificationProof?: string;
}

type ModalMode =
  | { type: 'closed' }
  | { type: 'catalog'; item: CatalogConnector; tab: 'oauth' | 'token' }
  | { type: 'custom_api' }
  | { type: 'mcp_server' };

const CATEGORIES = [
  'All',
  'Developer',
  'Workspace',
  'Communication',
  'Project Management',
  'CRM & Commerce',
] as const;

function buildDefaultArgsFromSchema(schema?: McpToolSchema['inputSchema']): string {
  const props = schema?.properties || {};
  const template: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries<any>(props)) {
    if (spec?.type === 'number' || spec?.type === 'integer') template[key] = 0;
    else if (spec?.type === 'boolean') template[key] = false;
    else if (spec?.type === 'array') template[key] = [];
    else if (spec?.type === 'object') template[key] = {};
    else template[key] = '';
  }
  return JSON.stringify(template, null, 2);
}

export function ConnectorsPage() {
  const [catalog, setCatalog] = useState<CatalogConnector[]>([]);
  const [connections, setConnections] = useState<SavedConnector[]>([]);
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [oauthNotice, setOAuthNotice] = useState('');
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<(typeof CATEGORIES)[number]>('All');
  const [startingOAuthSlug, setStartingOAuthSlug] = useState<string | null>(null);

  // Add/Connect Modal state
  const [modal, setModal] = useState<ModalMode>({ type: 'closed' });
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [draftHealthPath, setDraftHealthPath] = useState('/');
  const [draftAuthType, setDraftAuthType] = useState<
    'bearer' | 'api_key_header' | 'basic' | 'none' | 'mcp_oauth'
  >('bearer');
  const [draftAuthHeaderName, setDraftAuthHeaderName] = useState('X-API-Key');
  const [draftToken, setDraftToken] = useState('');
  const [draftSecondaryToken, setDraftSecondaryToken] = useState('');
  const [draftDomain, setDraftDomain] = useState('');
  const [draftHeadersJson, setDraftHeadersJson] = useState('');
  const [oauthClientId, setOAuthClientId] = useState('');
  const [oauthClientSecret, setOAuthClientSecret] = useState('');
  const [testingDraft, setTestingDraft] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [testResult, setTestResult] = useState<TestResponse | null>(null);
  const [modalError, setModalError] = useState('');

  // Saved connector actions
  const [retestingId, setRetestingId] = useState<string | null>(null);

  // Runner Modal state
  const [runnerConnector, setRunnerConnector] = useState<SavedConnector | null>(null);
  const [selectedToolName, setSelectedToolName] = useState('');
  const [toolArgsText, setToolArgsText] = useState('{}');
  const [restMethod, setRestMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET');
  const [restPath, setRestPath] = useState('/');
  const [restBodyText, setRestBodyText] = useState('');
  const [invoking, setInvoking] = useState(false);
  const [invokeOutput, setInvokeOutput] = useState<{
    ok: boolean;
    latencyMs: number;
    data?: unknown;
    error?: string;
  } | null>(null);

  async function loadAll() {
    try {
      setError('');
      const origin = encodeURIComponent(window.location.origin);
      const [catData, statusData] = await Promise.all([
        apiRequest<{ catalog: CatalogConnector[]; connections: SavedConnector[] }>('/api/connectors/catalog'),
        apiRequest<OAuthStatusResponse>(`/api/connectors/oauth/status?origin=${origin}`),
      ]);
      setCatalog(catData.catalog);
      setConnections(catData.connections);
      setOAuthStatus(statusData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connectors.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  // Listen for OAuth completion from popup window
  useEffect(() => {
    function handlePopupMessage(event: MessageEvent) {
      const origin = event.origin || '';
      if (!origin.endsWith('.run.app') && !origin.includes('localhost') && origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === 'NEXUS_OAUTH_SUCCESS') {
        const connName = event.data?.connector?.name || 'Connector';
        setOAuthNotice(`${connName} authorized, verified live, and saved to database.`);
        setError('');
        setModal({ type: 'closed' });
        void loadAll();
      } else if (event.data?.type === 'NEXUS_OAUTH_ERROR') {
        setModalError(event.data?.error || 'OAuth authorization failed.');
        setError(event.data?.error || 'OAuth authorization failed.');
      }
    }

    window.addEventListener('message', handlePopupMessage);
    return () => window.removeEventListener('message', handlePopupMessage);
  }, []);

  const connectedSlugs = useMemo(() => new Set(connections.map((c) => c.slug)), [connections]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((item) => {
      if (selectedCategory !== 'All' && item.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [catalog, search, selectedCategory]);

  function resetDraftFields() {
    setDraftName('');
    setDraftDescription('');
    setDraftBaseUrl('');
    setDraftHealthPath('/');
    setDraftAuthType('bearer');
    setDraftAuthHeaderName('X-API-Key');
    setDraftToken('');
    setDraftSecondaryToken('');
    setDraftDomain('');
    setDraftHeadersJson('');
    setOAuthClientId('');
    setOAuthClientSecret('');
    setTestResult(null);
    setModalError('');
  }

  function openCatalogModal(item: CatalogConnector, preferredTab: 'oauth' | 'token' = 'oauth') {
    resetDraftFields();
    setDraftName(item.name);
    const info = oauthStatus?.providers[item.slug];
    const tab = preferredTab === 'oauth' && info?.oauthSupported === false ? 'token' : preferredTab;
    setModal({ type: 'catalog', item, tab });
  }

  function openCustomApiModal() {
    resetDraftFields();
    setDraftAuthType('bearer');
    setDraftHealthPath('/health');
    setModal({ type: 'custom_api' });
  }

  function openMcpModal() {
    resetDraftFields();
    setDraftAuthType('none');
    setModal({ type: 'mcp_server' });
  }

  function clearTestProof() {
    if (testResult) setTestResult(null);
    if (modalError) setModalError('');
  }

  async function launchOAuthPopup(payload: {
    mode?: 'auto' | 'composio' | 'direct_oauth' | 'mcp_oauth';
    slug?: string;
    name?: string;
    mcpUrl?: string;
    clientId?: string;
    clientSecret?: string;
    domain?: string;
  }) {
    setStartingOAuthSlug(payload.slug || payload.mode || 'oauth');
    setModalError('');
    setOAuthNotice('');
    try {
      const res = await apiRequest<{ authUrl: string; mode: string; callbackUrl: string }>(
        '/api/connectors/oauth/start',
        {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            origin: window.location.origin,
          }),
        }
      );

      const popup = window.open(
        res.authUrl,
        'nexus_oauth_popup',
        'width=620,height=720,menubar=no,toolbar=no'
      );
      if (!popup) {
        setModalError('Popup blocked by browser. Allow popups for this site and click Authorize again.');
        setError('Popup blocked by browser. Allow popups for this site to authorize.');
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : 'Unable to start OAuth redirect.';
      if (modal.type === 'closed' && payload.slug) {
        const item = catalog.find((c) => c.slug === payload.slug);
        if (item) {
          openCatalogModal(item, 'oauth');
          setModalError(msg);
          return;
        }
      }
      setModalError(msg);
    } finally {
      setStartingOAuthSlug(null);
    }
  }

  async function handleCopyCallback() {
    const url = oauthStatus?.callbackUrl || `${window.location.origin}/api/connectors/oauth/callback`;
    await navigator.clipboard.writeText(url).catch(() => undefined);
    setCopiedCallback(true);
    setTimeout(() => setCopiedCallback(false), 1800);
  }

  function buildDraftPayload() {
    let customHeaders: Record<string, string> | undefined;
    if (draftHeadersJson.trim()) {
      const parsed = JSON.parse(draftHeadersJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        customHeaders = parsed as Record<string, string>;
      }
    }

    if (modal.type === 'catalog') {
      return {
        kind: 'catalog' as const,
        slug: modal.item.slug,
        name: draftName.trim() || modal.item.name,
        token: draftToken.trim(),
        secondaryToken: draftSecondaryToken.trim() || undefined,
        domain: draftDomain.trim() || undefined,
      };
    }

    if (modal.type === 'mcp_server') {
      return {
        kind: 'mcp_server' as const,
        name: draftName.trim(),
        description: draftDescription.trim() || undefined,
        baseUrl: draftBaseUrl.trim(),
        authType: draftAuthType === 'mcp_oauth' ? 'none' : draftAuthType,
        authHeaderName: draftAuthType === 'api_key_header' ? draftAuthHeaderName.trim() : undefined,
        token: draftToken.trim() || undefined,
        customHeaders,
      };
    }

    return {
      kind: 'custom_api' as const,
      name: draftName.trim(),
      description: draftDescription.trim() || undefined,
      baseUrl: draftBaseUrl.trim(),
      healthPath: draftHealthPath.trim() || '/',
      authType: draftAuthType === 'mcp_oauth' ? 'none' : draftAuthType,
      authHeaderName: draftAuthType === 'api_key_header' ? draftAuthHeaderName.trim() : undefined,
      token: draftToken.trim() || undefined,
      secondaryToken: draftSecondaryToken.trim() || undefined,
      customHeaders,
    };
  }

  async function handleRunDraftTest(e: React.FormEvent) {
    e.preventDefault();
    if (modal.type === 'closed' || testingDraft) return;

    if (modal.type === 'mcp_server' && draftAuthType === 'mcp_oauth') {
      await launchOAuthPopup({
        mode: 'mcp_oauth',
        name: draftName.trim() || undefined,
        mcpUrl: draftBaseUrl.trim(),
      });
      return;
    }

    setModalError('');
    setTestResult(null);
    setTestingDraft(true);

    try {
      const payload = buildDraftPayload();
      const data = await apiRequest<TestResponse>('/api/connectors/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTestResult(data);
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data.ok === 'boolean') {
        setTestResult(err.data as TestResponse);
      } else {
        setModalError(err instanceof Error ? err.message : 'Unable to run connection test.');
      }
    } finally {
      setTestingDraft(false);
    }
  }

  async function handleSaveVerifiedConnector() {
    if (modal.type === 'closed' || !testResult?.ok || !testResult.verificationProof || savingDraft) {
      return;
    }
    setSavingDraft(true);
    setModalError('');
    try {
      const payload = {
        ...buildDraftPayload(),
        verificationProof: testResult.verificationProof,
      };
      await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setModal({ type: 'closed' });
      await loadAll();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to save connector.');
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleRetestSaved(id: string) {
    setRetestingId(id);
    try {
      await apiRequest(`/api/connectors/${id}/test`, { method: 'POST' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retest failed.');
    } finally {
      setRetestingId(null);
    }
  }

  async function handleToggleActive(conn: SavedConnector) {
    try {
      await apiRequest(`/api/connectors/${conn.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !conn.active }),
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connector state.');
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiRequest(`/api/connectors/${id}`, { method: 'DELETE' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove connector.');
    }
  }

  function openRunner(conn: SavedConnector, preselectTool?: string) {
    setRunnerConnector(conn);
    setInvokeOutput(null);
    if (conn.kind === 'mcp_server' || conn.kind === 'composio_oauth') {
      const firstTool =
        conn.discoveredTools.find((t) => t.name === preselectTool) || conn.discoveredTools[0];
      setSelectedToolName(firstTool?.name || '');
      setToolArgsText(buildDefaultArgsFromSchema(firstTool?.inputSchema));
    } else {
      setRestMethod('GET');
      setRestPath(conn.healthPath || '/');
      setRestBodyText('');
    }
  }

  async function handleInvokeConnector(e: React.FormEvent) {
    e.preventDefault();
    if (!runnerConnector || invoking) return;
    setInvoking(true);
    setInvokeOutput(null);

    try {
      let bodyPayload: Record<string, unknown>;
      if (runnerConnector.kind === 'mcp_server' || runnerConnector.kind === 'composio_oauth') {
        const parsedArgs = toolArgsText.trim() ? JSON.parse(toolArgsText) : {};
        bodyPayload = { toolName: selectedToolName, args: parsedArgs };
      } else {
        const parsedBody = restBodyText.trim() ? JSON.parse(restBodyText) : undefined;
        bodyPayload = {
          method: restMethod,
          path: restPath.trim() || '/',
          ...(parsedBody !== undefined ? { body: parsedBody } : {}),
        };
      }

      const res = await apiRequest<{
        ok: boolean;
        latencyMs: number;
        data?: unknown;
        error?: string;
      }>(`/api/connectors/${runnerConnector.id}/invoke`, {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      setInvokeOutput(res);
    } catch (err) {
      setInvokeOutput({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'Invocation failed',
      });
    } finally {
      setInvoking(false);
    }
  }

  const callbackUrlDisplay =
    oauthStatus?.callbackUrl || `${window.location.origin}/api/connectors/oauth/callback`;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Connectors & MCP Servers
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
            <span className="font-mono tabular-nums">{catalog.length}</span> integrations ·{' '}
            OAuth browser authorization · Custom REST APIs · Model Context Protocol servers
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openCustomApiModal}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add Custom Connector</span>
          </button>
          <button
            type="button"
            onClick={openMcpModal}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Server className="h-4 w-4" />
            <span>Add MCP Server</span>
          </button>
        </div>
      </header>

      {/* OAuth Broker & Callback Status */}
      <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {oauthStatus?.composioConfigured ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Unified 1-Click OAuth Active (Composio)
                </span>
              ) : (
                <span>OAuth Browser Authorization Configuration</span>
              )}
            </div>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              {oauthStatus?.composioConfigured
                ? 'Click "Connect with ..." on any supported app to redirect to the provider website, authorize, verify live, and mount tools automatically.'
                : 'To get 1-click browser OAuth redirects across all 25+ apps without creating 25 separate OAuth apps, add a single COMPOSIO_API_KEY in Secrets / .env — or configure per-provider *_CLIENT_ID / *_CLIENT_SECRET.'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 dark:text-zinc-400">Direct OAuth env apps:</span>
            <span className="font-mono tabular-nums font-medium">
              {oauthStatus?.directOAuthSlugs.length ?? 0}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-xs">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-slate-500 dark:text-zinc-400 shrink-0">OAuth Callback URL:</span>
            <code className="font-mono truncate text-slate-900 dark:text-zinc-100">
              {callbackUrlDisplay}
            </code>
          </div>
          <button
            type="button"
            onClick={handleCopyCallback}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0 cursor-pointer"
          >
            {copiedCallback ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copiedCallback ? 'Copied' : 'Copy URI'}</span>
          </button>
        </div>
      </section>

      {oauthNotice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{oauthNotice}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Connected Workspace */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Saved Workspace Connections</h2>
          <span className="text-xs text-slate-500 dark:text-zinc-400 font-mono tabular-nums">
            {connections.length} saved
          </span>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="h-28 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900" />
            <div className="h-28 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900" />
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/40 p-6 text-sm text-slate-600 dark:text-zinc-400">
            No verified connectors or MCP servers saved yet. Authorize any integration below via browser OAuth or token verification. Every connection is tested live before saving to MongoDB.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">{conn.name}</h3>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
                        <span>
                          {conn.kind === 'mcp_server'
                            ? 'MCP Server'
                            : conn.kind === 'composio_oauth'
                              ? 'OAuth Connected'
                              : conn.kind === 'custom_api'
                                ? 'Custom REST API'
                                : conn.category}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{conn.lastLatencyMs}ms</span>
                        {conn.secretHint && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{conn.secretHint}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs font-medium shrink-0">
                      {!conn.active ? (
                        <span className="inline-flex items-center gap-1 text-slate-500 dark:text-zinc-400">
                          <Pause className="h-3.5 w-3.5" />
                          Paused
                        </span>
                      ) : conn.status === 'connected' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Error
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 dark:text-zinc-400 truncate" title={conn.baseUrl}>
                    {conn.baseUrl}
                  </p>
                  {conn.lastTestMessage && (
                    <p className="text-xs text-slate-500 dark:text-zinc-400">{conn.lastTestMessage}</p>
                  )}

                  {(conn.kind === 'mcp_server' || conn.kind === 'composio_oauth') &&
                    conn.discoveredTools.length > 0 && (
                      <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-1.5">
                        <div className="text-xs font-medium text-slate-700 dark:text-zinc-300">
                          Exposed Agent Tools ({conn.discoveredTools.length})
                        </div>
                        <div className="divide-y divide-slate-100 dark:divide-zinc-800 rounded-lg border border-slate-200 dark:border-zinc-800">
                          {conn.discoveredTools.slice(0, 5).map((tool) => (
                            <div
                              key={tool.name}
                              className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                            >
                              <div className="min-w-0 truncate">
                                <span className="font-mono font-medium text-slate-900 dark:text-zinc-100">
                                  {tool.name}
                                </span>
                                {tool.description && (
                                  <span className="ml-2 text-slate-500 dark:text-zinc-400">
                                    {tool.description}
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                disabled={!conn.active}
                                onClick={() => openRunner(conn, tool.name)}
                                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
                              >
                                Run tool
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRetestSaved(conn.id)}
                      disabled={retestingId === conn.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${retestingId === conn.id ? 'animate-spin' : ''}`} />
                      <span>{retestingId === conn.id ? 'Testing...' : 'Re-Test'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={!conn.active}
                      onClick={() => openRunner(conn)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      <span>
                        {conn.kind === 'mcp_server' || conn.kind === 'composio_oauth'
                          ? 'Call Tool'
                          : 'Test Request'}
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(conn)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer whitespace-nowrap"
                    >
                      {conn.active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      <span>{conn.active ? 'Pause' : 'Resume'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(conn.id)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer whitespace-nowrap"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Built-in Catalog */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedCategory === cat
                    ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 border border-slate-200 dark:border-zinc-700'
                    : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search GitHub, Calendar, Notion..."
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 pl-9 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredCatalog.map((item) => {
            const isConnected = connectedSlugs.has(item.slug);
            const oauthInfo = oauthStatus?.providers[item.slug];
            const isOAuthReady =
              oauthInfo?.readyMode === 'composio' || oauthInfo?.readyMode === 'direct_env';

            return (
              <div
                key={item.slug}
                className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">{item.name}</h3>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                        {item.category} ·{' '}
                        {isOAuthReady ? 'OAuth Ready' : oauthInfo?.oauthSupported ? 'OAuth / Token' : 'API Key'}
                      </div>
                    </div>
                    {isConnected && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 shrink-0">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Connected
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                    {item.description}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-zinc-800">
                  {isOAuthReady ? (
                    <>
                      <button
                        type="button"
                        onClick={() => openCatalogModal(item, 'token')}
                        className="text-xs text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200 cursor-pointer whitespace-nowrap"
                      >
                        Use API Token
                      </button>
                      <button
                        type="button"
                        disabled={startingOAuthSlug === item.slug}
                        onClick={() => launchOAuthPopup({ slug: item.slug, name: item.name })}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-zinc-100 px-3 py-1.5 text-xs font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>
                          {startingOAuthSlug === item.slug
                            ? 'Opening...'
                            : `Connect ${item.name}`}
                        </span>
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-slate-500 dark:text-zinc-500 truncate">
                        {item.docsHint}
                      </span>
                      <button
                        type="button"
                        onClick={() => openCatalogModal(item, oauthInfo?.oauthSupported ? 'oauth' : 'token')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Plug className="h-3.5 w-3.5" />
                        <span>{isConnected ? 'Add Instance' : 'Connect'}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Connect / Add Custom / Add MCP Modal */}
      {modal.type !== 'closed' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-4">
              <div>
                <h2 className="text-base font-semibold">
                  {modal.type === 'catalog'
                    ? `Connect ${modal.item.name}`
                    : modal.type === 'mcp_server'
                      ? 'Add Model Context Protocol (MCP) Server'
                      : 'Add Custom REST Connector'}
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                  Live verification must pass before credentials are encrypted and stored in MongoDB.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModal({ type: 'closed' })}
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {modal.type === 'catalog' && oauthStatus?.providers[modal.item.slug]?.oauthSupported && (
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-zinc-950 rounded-lg border border-slate-200 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setModal({ ...modal, tab: 'oauth' })}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    modal.tab === 'oauth'
                      ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 border border-slate-200 dark:border-zinc-700'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>OAuth Browser Redirect</span>
                </button>
                <button
                  type="button"
                  onClick={() => setModal({ ...modal, tab: 'token' })}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    modal.tab === 'token'
                      ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 border border-slate-200 dark:border-zinc-700'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>API Token / Secret</span>
                </button>
              </div>
            )}

            {modal.type === 'catalog' && modal.tab === 'oauth' ? (
              <div className="space-y-4">
                {oauthStatus?.providers[modal.item.slug]?.readyMode !== 'needs_setup' ? (
                  <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 p-4 text-xs text-emerald-800 dark:text-emerald-200 space-y-2">
                    <p className="font-medium">
                      Ready for 1-click OAuth redirect via{' '}
                      {oauthStatus?.providers[modal.item.slug]?.readyMode === 'direct_env'
                        ? 'configured server OAuth app'
                        : 'Composio Unified Broker'}
                      .
                    </p>
                    <p>
                      Clicking Authorize opens {modal.item.name} in a popup window so you can grant permissions without manually copying tokens.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-4 text-xs space-y-2.5 text-slate-600 dark:text-zinc-300">
                    <p className="font-medium text-slate-900 dark:text-zinc-100">
                      Choose either option to enable browser redirect OAuth:
                    </p>
                    <p>
                      1. <strong>Unified 1-Key Setup (All 25+ Connectors):</strong> Add{' '}
                      <code className="font-mono text-slate-900 dark:text-zinc-100">COMPOSIO_API_KEY</code> to{' '}
                      <code className="font-mono">.env</code> / Secrets.
                    </p>
                    <p>
                      2. <strong>Direct {modal.item.name} OAuth App:</strong> Enter your{' '}
                      <code className="font-mono">{oauthStatus?.providers[modal.item.slug]?.envKeyHint}</code>{' '}
                      below (or in <code className="font-mono">.env</code>) with Redirect URI:
                    </p>
                    <div className="flex items-center justify-between gap-2 rounded border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2.5 py-1.5">
                      <code className="font-mono truncate">{callbackUrlDisplay}</code>
                      <button
                        type="button"
                        onClick={handleCopyCallback}
                        className="text-blue-600 dark:text-blue-400 hover:underline shrink-0 cursor-pointer"
                      >
                        {copiedCallback ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                {oauthStatus?.providers[modal.item.slug]?.readyMode === 'needs_setup' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        OAuth Client ID
                      </label>
                      <input
                        type="text"
                        value={oauthClientId}
                        onChange={(e) => setOAuthClientId(e.target.value)}
                        placeholder="Paste Client ID to authorize now"
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        OAuth Client Secret
                      </label>
                      <input
                        type="password"
                        value={oauthClientSecret}
                        onChange={(e) => setOAuthClientSecret(e.target.value)}
                        placeholder="Paste Client Secret"
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono outline-none"
                      />
                    </div>
                  </div>
                )}

                {modalError && (
                  <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                    {modalError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'closed' })}
                    className="rounded-lg border border-slate-200 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      startingOAuthSlug === modal.item.slug ||
                      (oauthStatus?.providers[modal.item.slug]?.readyMode === 'needs_setup' &&
                        (!oauthClientId.trim() || !oauthClientSecret.trim()))
                    }
                    onClick={() =>
                      launchOAuthPopup({
                        slug: modal.item.slug,
                        name: draftName.trim() || modal.item.name,
                        clientId: oauthClientId.trim() || undefined,
                        clientSecret: oauthClientSecret.trim() || undefined,
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-40"
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span>
                      {startingOAuthSlug === modal.item.slug
                        ? 'Opening Authorization...'
                        : `Authorize with ${modal.item.name}`}
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRunDraftTest} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    value={draftName}
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      clearTestProof();
                    }}
                    placeholder={
                      modal.type === 'catalog'
                        ? modal.item.name
                        : modal.type === 'mcp_server'
                          ? 'e.g. Notion MCP Server'
                          : 'e.g. Billing Internal API'
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  />
                </div>

                {(modal.type === 'custom_api' || modal.type === 'mcp_server') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        {modal.type === 'mcp_server'
                          ? 'MCP Server Endpoint URL (HTTP / SSE)'
                          : 'Base URL'}
                      </label>
                      <input
                        type="url"
                        required
                        value={draftBaseUrl}
                        onChange={(e) => {
                          setDraftBaseUrl(e.target.value);
                          clearTestProof();
                        }}
                        placeholder={
                          modal.type === 'mcp_server'
                            ? 'https://mcp.notion.com/mcp'
                            : 'https://api.example.com'
                        }
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                    </div>

                    {modal.type === 'custom_api' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          Verification Health Path (GET)
                        </label>
                        <input
                          type="text"
                          value={draftHealthPath}
                          onChange={(e) => {
                            setDraftHealthPath(e.target.value);
                            clearTestProof();
                          }}
                          placeholder="/health or /v1/me"
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          Authentication
                        </label>
                        <select
                          value={draftAuthType}
                          onChange={(e) => {
                            setDraftAuthType(e.target.value as any);
                            clearTestProof();
                          }}
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
                        >
                          <option value="none">No Auth</option>
                          {modal.type === 'mcp_server' && (
                            <option value="mcp_oauth">MCP OAuth 2.1 (Browser Sign-In)</option>
                          )}
                          <option value="bearer">Bearer Token</option>
                          <option value="api_key_header">Custom Header Key</option>
                          {modal.type === 'custom_api' && <option value="basic">Basic Auth</option>}
                        </select>
                      </div>

                      {draftAuthType === 'api_key_header' && (
                        <div>
                          <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                            Header Name
                          </label>
                          <input
                            type="text"
                            value={draftAuthHeaderName}
                            onChange={(e) => {
                              setDraftAuthHeaderName(e.target.value);
                              clearTestProof();
                            }}
                            placeholder="X-API-Key"
                            className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                          />
                        </div>
                      )}
                    </div>

                    {draftAuthType === 'basic' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          Username / Email
                        </label>
                        <input
                          type="text"
                          value={draftSecondaryToken}
                          onChange={(e) => {
                            setDraftSecondaryToken(e.target.value);
                            clearTestProof();
                          }}
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
                        />
                      </div>
                    )}

                    {draftAuthType !== 'none' && draftAuthType !== 'mcp_oauth' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          Access Token / Secret Key
                        </label>
                        <input
                          type="password"
                          value={draftToken}
                          onChange={(e) => {
                            setDraftToken(e.target.value);
                            clearTestProof();
                          }}
                          placeholder="Paste token or API key"
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                        />
                      </div>
                    )}

                    {draftAuthType === 'mcp_oauth' && (
                      <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-3 text-xs text-slate-600 dark:text-zinc-300">
                        NEXUS will probe <code className="font-mono">.well-known/oauth-authorization-server</code> on this MCP server, perform Dynamic Client Registration, open the provider login popup, and run <code className="font-mono">tools/list</code> before saving.
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        Description (optional)
                      </label>
                      <input
                        type="text"
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        placeholder="Short note on what the agent can do with this server"
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
                      />
                    </div>

                    {draftAuthType !== 'mcp_oauth' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          Custom Headers JSON (optional)
                        </label>
                        <input
                          type="text"
                          value={draftHeadersJson}
                          onChange={(e) => {
                            setDraftHeadersJson(e.target.value);
                            clearTestProof();
                          }}
                          placeholder='{"X-Workspace-Id": "ws_123"}'
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono outline-none"
                        />
                      </div>
                    )}
                  </>
                )}

                {modal.type === 'catalog' && (
                  <>
                    {modal.item.domainFieldLabel && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          {modal.item.domainFieldLabel}
                        </label>
                        <input
                          type="text"
                          required
                          value={draftDomain}
                          onChange={(e) => {
                            setDraftDomain(e.target.value);
                            clearTestProof();
                          }}
                          placeholder={modal.item.domainFieldPlaceholder}
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                        />
                      </div>
                    )}

                    {modal.item.secondaryFieldLabel && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                          {modal.item.secondaryFieldLabel}
                        </label>
                        <input
                          type="text"
                          required
                          value={draftSecondaryToken}
                          onChange={(e) => {
                            setDraftSecondaryToken(e.target.value);
                            clearTestProof();
                          }}
                          placeholder={modal.item.secondaryFieldPlaceholder}
                          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none"
                        />
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        {modal.item.primaryFieldLabel}
                      </label>
                      <input
                        type="password"
                        required
                        value={draftToken}
                        onChange={(e) => {
                          setDraftToken(e.target.value);
                          clearTestProof();
                        }}
                        placeholder={modal.item.primaryFieldPlaceholder}
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                      />
                      <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                        {modal.item.docsHint}
                      </p>
                    </div>
                  </>
                )}

                {modalError && (
                  <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                    {modalError}
                  </div>
                )}

                {testResult && (
                  <div
                    className={`rounded-lg border px-4 py-3 text-xs space-y-2 ${
                      testResult.ok
                        ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
                        : 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {testResult.ok ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <AlertCircle className="h-4 w-4" />
                        )}
                        {testResult.ok
                          ? 'Live Verification Passed'
                          : 'Live Verification Failed — Not Saved'}
                      </span>
                      <span className="font-mono tabular-nums">{testResult.latencyMs}ms</span>
                    </div>
                    <p>{testResult.message}</p>

                    {testResult.ok && testResult.discoveredTools.length > 0 && (
                      <div className="pt-2 border-t border-emerald-200/70 dark:border-emerald-800/60 space-y-1">
                        <div className="font-medium">
                          Discovered Tools ({testResult.discoveredTools.length}):
                        </div>
                        <ul className="space-y-1 font-mono">
                          {testResult.discoveredTools.map((t) => (
                            <li key={t.name}>
                              {t.name}
                              {t.description ? ` — ${t.description}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'closed' })}
                    className="rounded-lg border border-slate-200 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Cancel
                  </button>

                  {draftAuthType === 'mcp_oauth' && modal.type === 'mcp_server' ? (
                    <button
                      type="submit"
                      disabled={startingOAuthSlug === 'mcp_oauth'}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-50"
                    >
                      <ExternalLink className="h-4 w-4" />
                      <span>
                        {startingOAuthSlug === 'mcp_oauth'
                          ? 'Discovering OAuth...'
                          : 'Authorize MCP Server'}
                      </span>
                    </button>
                  ) : (
                    <>
                      <button
                        type="submit"
                        disabled={testingDraft}
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-zinc-700 cursor-pointer disabled:opacity-50"
                      >
                        <Wrench className="h-4 w-4" />
                        <span>{testingDraft ? 'Testing Live...' : '1. Test Connection'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!testResult?.ok || !testResult.verificationProof || savingDraft}
                        onClick={handleSaveVerifiedConnector}
                        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-40"
                      >
                        <span>{savingDraft ? 'Saving...' : '2. Save to Database'}</span>
                      </button>
                    </>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Interactive Tool / API Runner Modal */}
      {runnerConnector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-zinc-800 pb-4">
              <div>
                <h2 className="text-base font-semibold">
                  {runnerConnector.kind === 'mcp_server' || runnerConnector.kind === 'composio_oauth'
                    ? `Invoke Tool · ${runnerConnector.name}`
                    : `Run API Request · ${runnerConnector.name}`}
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400 font-mono">
                  {runnerConnector.baseUrl}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRunnerConnector(null)}
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleInvokeConnector} className="space-y-4">
              {runnerConnector.kind === 'mcp_server' || runnerConnector.kind === 'composio_oauth' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                      Tool
                    </label>
                    <select
                      value={selectedToolName}
                      onChange={(e) => {
                        const nextName = e.target.value;
                        setSelectedToolName(nextName);
                        const found = runnerConnector.discoveredTools.find((t) => t.name === nextName);
                        setToolArgsText(buildDefaultArgsFromSchema(found?.inputSchema));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                    >
                      {runnerConnector.discoveredTools.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                      Arguments (JSON)
                    </label>
                    <textarea
                      rows={5}
                      value={toolArgsText}
                      onChange={(e) => setToolArgsText(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono outline-none"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        Method
                      </label>
                      <select
                        value={restMethod}
                        onChange={(e) => setRestMethod(e.target.value as any)}
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div className="col-span-3">
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        Endpoint Path
                      </label>
                      <input
                        type="text"
                        value={restPath}
                        onChange={(e) => setRestPath(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono outline-none"
                      />
                    </div>
                  </div>
                  {restMethod !== 'GET' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        Request Body (JSON, optional)
                      </label>
                      <textarea
                        rows={4}
                        value={restBodyText}
                        onChange={(e) => setRestBodyText(e.target.value)}
                        placeholder='{"key": "value"}'
                        className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono outline-none"
                      />
                    </div>
                  )}
                </>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="submit"
                  disabled={invoking}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 cursor-pointer disabled:opacity-50"
                >
                  <Terminal className="h-4 w-4" />
                  <span>{invoking ? 'Executing...' : 'Execute'}</span>
                </button>
              </div>
            </form>

            {invokeOutput && (
              <div className="space-y-2 border-t border-slate-200 dark:border-zinc-800 pt-4">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span
                    className={
                      invokeOutput.ok
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }
                  >
                    {invokeOutput.ok ? 'Success' : 'Error'}
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {invokeOutput.latencyMs}ms
                  </span>
                </div>
                <pre className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-3 text-xs font-mono">
                  {invokeOutput.error
                    ? invokeOutput.error
                    : JSON.stringify(invokeOutput.data, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
