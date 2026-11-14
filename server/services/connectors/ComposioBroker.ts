import { env } from '../../config/env';
import { McpToolSchema } from './McpClient';

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3';

const SLUG_MAP: Record<string, string> = {
  google_calendar: 'googlecalendar',
  google_drive: 'googledrive',
  google_sheets: 'googlesheets',
  microsoft_teams: 'microsoftteams',
};

const GITHUB_TOOL_ALIASES: Record<string, string> = {
  GITHUB_CREATE_OR_UPDATE_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_CREATE_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_UPDATE_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_PUSH_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_UPLOAD_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_COMMIT_FILE: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  GITHUB_DELETE_FILE: 'GITHUB_DELETE_A_FILE',
  GITHUB_REMOVE_FILE: 'GITHUB_DELETE_A_FILE',
  GITHUB_GET_FILE: 'GITHUB_GET_REPOSITORY_CONTENT',
  GITHUB_GET_FILE_CONTENTS: 'GITHUB_GET_REPOSITORY_CONTENT',
  GITHUB_GET_CONTENTS: 'GITHUB_GET_REPOSITORY_CONTENT',
  GITHUB_CREATE_BRANCH: 'GITHUB_CREATE_A_REFERENCE',
  GITHUB_DELETE_BRANCH: 'GITHUB_DELETE_A_REFERENCE',
  GITHUB_GET_REF: 'GITHUB_GET_A_REFERENCE',
  GITHUB_GET_REFERENCE: 'GITHUB_GET_A_REFERENCE',
  GITHUB_UPDATE_REF: 'GITHUB_UPDATE_A_REFERENCE',
  GITHUB_UPDATE_REFERENCE: 'GITHUB_UPDATE_A_REFERENCE',
  GITHUB_CREATE_REF: 'GITHUB_CREATE_A_REFERENCE',
  GITHUB_CREATE_REFERENCE: 'GITHUB_CREATE_A_REFERENCE',
  GITHUB_DELETE_REF: 'GITHUB_DELETE_A_REFERENCE',
  GITHUB_DELETE_REFERENCE: 'GITHUB_DELETE_A_REFERENCE',
  GITHUB_CREATE_PR: 'GITHUB_CREATE_A_PULL_REQUEST',
  GITHUB_CREATE_PULL_REQUEST: 'GITHUB_CREATE_A_PULL_REQUEST',
  GITHUB_RAISE_PR: 'GITHUB_CREATE_A_PULL_REQUEST',
  GITHUB_MERGE_PR: 'GITHUB_MERGE_A_PULL_REQUEST',
  GITHUB_MERGE_PULL_REQUEST: 'GITHUB_MERGE_A_PULL_REQUEST',
  GITHUB_UPDATE_PR: 'GITHUB_UPDATE_A_PULL_REQUEST',
  GITHUB_UPDATE_PULL_REQUEST: 'GITHUB_UPDATE_A_PULL_REQUEST',
  GITHUB_LIST_PRS: 'GITHUB_LIST_PULL_REQUESTS',
  GITHUB_MERGE_BRANCH: 'GITHUB_MERGE_A_BRANCH',
  GITHUB_CREATE_REPO: 'GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER',
  GITHUB_CREATE_REPOSITORY: 'GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER',
  GITHUB_GET_REPO: 'GITHUB_GET_A_REPOSITORY',
  GITHUB_GET_REPOSITORY: 'GITHUB_GET_A_REPOSITORY',
  GITHUB_CREATE_TREE: 'GITHUB_CREATE_A_TREE',
  GITHUB_CREATE_COMMIT: 'GITHUB_CREATE_A_COMMIT',
  GITHUB_GET_COMMIT: 'GITHUB_GET_A_COMMIT',
};

export function isComposioConfigured(): boolean {
  return Boolean(env.COMPOSIO_API_KEY);
}

export function mapSlugToComposioToolkit(slug: string): string {
  return SLUG_MAP[slug] || slug.toLowerCase();
}

export function ensureBase64Content(raw: string): string {
  const strayQuoteMatch = raw.match(/^([A-Za-z0-9+/]+={1,2})"$/);
  const candidate = strayQuoteMatch ? strayQuoteMatch[1] : raw;
  const noWs = candidate.replace(/\s+/g, '');

  if (
    noWs.length >= 8 &&
    noWs.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(noWs) &&
    candidate === noWs
  ) {
    try {
      const decoded = Buffer.from(noWs, 'base64');
      if (decoded.toString('base64') === noWs) {
        const hasBase64Signature =
          noWs.endsWith('=') ||
          (/[+/]/.test(noWs) && /[A-Z]/.test(noWs) && /[a-z]/.test(noWs) && /[0-9]/.test(noWs));
        if (hasBase64Signature) {
          return noWs;
        }
      }
    } catch {
      // Not valid base64, encode as UTF-8 below
    }
  }

  return Buffer.from(candidate, 'utf8').toString('base64');
}

async function composioFetch(path: string, init: RequestInit = {}): Promise<any> {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error('COMPOSIO_API_KEY is not configured.');
  }

  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': env.COMPOSIO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => '');
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      json?.detail ||
      `Composio HTTP ${res.status}: ${text.slice(0, 180)}`;
    throw new Error(String(msg));
  }

  return json;
}

export async function findOrCreateAuthConfig(toolkitSlug: string): Promise<string> {
  const listed = await composioFetch(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=20`
  );
  const items: any[] = Array.isArray(listed?.items) ? listed.items : [];
  const managed = items.find((item) => item?.is_composio_managed) || items[0];
  if (managed?.id) {
    return String(managed.id);
  }

  const created = await composioFetch('/auth_configs', {
    method: 'POST',
    body: JSON.stringify({
      toolkit: { slug: toolkitSlug },
    }),
  });

  const id = created?.id || created?.auth_config?.id;
  if (!id) {
    throw new Error(`Composio did not return an auth_config_id for toolkit "${toolkitSlug}".`);
  }
  return String(id);
}

export async function createComposioConnectLink(params: {
  userId: string;
  toolkitSlug: string;
  callbackUrl: string;
}): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
  const authConfigId = await findOrCreateAuthConfig(params.toolkitSlug);
  const data = await composioFetch('/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      user_id: params.userId,
      auth_config_id: authConfigId,
      callback_url: params.callbackUrl,
    }),
  });

  const redirectUrl = data?.redirect_url || data?.redirectUrl;
  if (!redirectUrl) {
    throw new Error('Composio did not return an OAuth redirect URL.');
  }

  return {
    redirectUrl: String(redirectUrl),
    connectedAccountId: data?.connected_account_id ? String(data.connected_account_id) : undefined,
  };
}

export async function verifyComposioConnectedAccount(connectedAccountId: string): Promise<{
  ok: boolean;
  status: string;
  message: string;
  toolkitSlug?: string;
  composioUserId?: string;
}> {
  const account = await composioFetch(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
  const status = String(account?.status || 'UNKNOWN').toUpperCase();
  const toolkitSlug = account?.toolkit?.slug ? String(account.toolkit.slug) : undefined;
  const composioUserId = account?.user_id ? String(account.user_id) : undefined;
  const ok = status === 'ACTIVE' || status === 'CONNECTED';
  return {
    ok,
    status,
    toolkitSlug,
    composioUserId,
    message: ok
      ? `Verified active OAuth connection (${connectedAccountId}).`
      : `Composio connection status is ${status}, not ACTIVE.`,
  };
}

export async function searchComposioTools(
  toolkitSlug: string,
  query?: string,
  limit = 15
): Promise<McpToolSchema[]> {
  try {
    const fetchLimit = Math.max(limit * 4, 60);
    const qs = new URLSearchParams({
      toolkit_slug: toolkitSlug,
      limit: String(fetchLimit),
    });
    if (query && query.trim()) {
      qs.set('search', query.trim());
    }
    const res = await composioFetch(`/tools?${qs.toString()}`);
    const items: any[] = Array.isArray(res?.items) ? res.items : [];

    const tokens = (query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2);

    const scored = items.map((t) => {
      const slug = String(t.slug || t.name || '');
      const desc = String(t.description || t.name || '');
      const slugLower = slug.toLowerCase();
      const descLower = desc.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (slugLower.includes(tok)) score += 5;
        if (descLower.includes(tok)) score += 2;
      }
      if (tokens.length > 0 && tokens.every((tok) => slugLower.includes(tok))) {
        score += 10;
      }
      if (/^deprecated:/i.test(desc)) score -= 6;
      return { t, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ t }) => ({
      name: String(t.slug || t.name),
      description: String(t.description || t.name || ''),
      inputSchema: {
        type: 'object',
        properties: t.input_parameters?.properties || {},
        required: Array.isArray(t.input_parameters?.required) ? t.input_parameters.required : [],
      },
    }));
  } catch {
    return [];
  }
}

export async function listComposioToolsForToolkit(
  toolkitSlug: string,
  limit = 25
): Promise<McpToolSchema[]> {
  try {
    const queries: Promise<McpToolSchema[]>[] = [];
    if (toolkitSlug === 'github') {
      for (const kw of ['repository', 'file contents', 'pull request', 'branch']) {
        queries.push(searchComposioTools('github', kw, 6));
      }
    }

    const [importantRes, generalRes, ...targeted] = await Promise.all([
      composioFetch(`/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&important=true&limit=${limit}`).catch(
        () => ({ items: [] })
      ),
      composioFetch(`/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=${limit}`).catch(
        () => ({ items: [] })
      ),
      ...queries,
    ]);

    const seen = new Set<string>();
    const combined: McpToolSchema[] = [];

    for (const group of targeted) {
      for (const item of group) {
        if (!item.name || seen.has(item.name)) continue;
        seen.add(item.name);
        combined.push(item);
        if (combined.length >= limit) return combined;
      }
    }

    for (const item of [...(importantRes?.items || []), ...(generalRes?.items || [])]) {
      const key = String(item?.slug || item?.name || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      combined.push({
        name: key,
        description: String(item.description || item.name || ''),
        inputSchema: {
          type: 'object',
          properties: item.input_parameters?.properties || {},
          required: Array.isArray(item.input_parameters?.required) ? item.input_parameters.required : [],
        },
      });
      if (combined.length >= limit) break;
    }

    return combined;
  } catch {
    return [];
  }
}

async function rawExecuteComposioSlug(params: {
  connectedAccountId: string;
  userId?: string;
  toolSlug: string;
  args: Record<string, unknown>;
}): Promise<{ ok: boolean; data?: any; error?: string }> {
  const result = await composioFetch(`/tools/execute/${encodeURIComponent(params.toolSlug)}`, {
    method: 'POST',
    body: JSON.stringify({
      connected_account_id: params.connectedAccountId,
      ...(params.userId ? { user_id: params.userId } : {}),
      arguments: params.args,
    }),
  });

  if (result?.successful === false) {
    return {
      ok: false,
      error: String(result?.error || 'Composio tool execution returned unsuccessful'),
    };
  }

  return {
    ok: true,
    data: result?.data ?? result,
  };
}

async function resolveFallbackSlug(
  requestedSlug: string,
  toolkitSlug?: string
): Promise<string | null> {
  const inferredToolkit =
    toolkitSlug || requestedSlug.split('_')[0]?.toLowerCase() || '';
  if (!inferredToolkit) return null;

  const query = requestedSlug
    .replace(new RegExp(`^${inferredToolkit}_`, 'i'), '')
    .replace(/_/g, ' ')
    .trim();
  if (!query) return null;

  const matches = await searchComposioTools(inferredToolkit, query, 8);
  if (matches.length === 0) return null;

  const reqTokens = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
  let bestSlug: string | null = null;
  let bestScore = 0;
  for (const m of matches) {
    const candidateTokens = m.name.toLowerCase().split('_');
    let overlap = 0;
    for (const tok of reqTokens) {
      if (candidateTokens.includes(tok) || m.name.toLowerCase().includes(tok)) {
        overlap += 1;
      }
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestSlug = m.name;
    }
  }

  return bestScore >= Math.max(2, Math.ceil(reqTokens.size * 0.6)) ? bestSlug : null;
}

async function lookupGithubRepoDefaultBranch(
  connectedAccountId: string,
  userId: string | undefined,
  owner: string,
  repo: string
): Promise<string> {
  try {
    const res = await rawExecuteComposioSlug({
      connectedAccountId,
      userId,
      toolSlug: 'GITHUB_GET_A_REPOSITORY',
      args: { owner, repo },
    });
    if (res.ok && res.data?.default_branch) {
      return String(res.data.default_branch);
    }
  } catch {
    // Fallback below
  }
  return 'main';
}

async function lookupGithubBranchSha(
  connectedAccountId: string,
  userId: string | undefined,
  owner: string,
  repo: string,
  branch: string
): Promise<string | null> {
  const cleanBranch = branch.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  try {
    const refRes = await rawExecuteComposioSlug({
      connectedAccountId,
      userId,
      toolSlug: 'GITHUB_GET_A_REFERENCE',
      args: { owner, repo, ref: `heads/${cleanBranch}` },
    });
    if (refRes.ok && refRes.data?.object?.sha) {
      return String(refRes.data.object.sha);
    }
  } catch {
    // Fallback to GITHUB_GET_A_BRANCH
  }

  try {
    const brRes = await rawExecuteComposioSlug({
      connectedAccountId,
      userId,
      toolSlug: 'GITHUB_GET_A_BRANCH',
      args: { owner, repo, branch: cleanBranch },
    });
    if (brRes.ok && brRes.data?.commit?.sha) {
      return String(brRes.data.commit.sha);
    }
  } catch {
    // Branch does not exist
  }

  return null;
}

async function lookupGithubFileSha(
  connectedAccountId: string,
  userId: string | undefined,
  owner: string,
  repo: string,
  path: string,
  branch?: string
): Promise<string | null> {
  try {
    const res = await rawExecuteComposioSlug({
      connectedAccountId,
      userId,
      toolSlug: 'GITHUB_GET_REPOSITORY_CONTENT',
      args: {
        owner,
        repo,
        path: path.replace(/^\/+/, ''),
        ...(branch ? { ref: branch } : {}),
      },
    });
    if (res.ok && res.data && !Array.isArray(res.data) && res.data.sha) {
      return String(res.data.sha);
    }
  } catch {
    // File does not exist on branch
  }
  return null;
}

async function ensureGithubBranchExists(params: {
  connectedAccountId: string;
  userId?: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch?: string;
}): Promise<{ exists: boolean; created: boolean; headSha: string | null; defaultBranch: string }> {
  const cleanBranch = params.branch.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  const existingSha = await lookupGithubBranchSha(
    params.connectedAccountId,
    params.userId,
    params.owner,
    params.repo,
    cleanBranch
  );
  const defaultBranch = await lookupGithubRepoDefaultBranch(
    params.connectedAccountId,
    params.userId,
    params.owner,
    params.repo
  );

  if (existingSha) {
    return { exists: true, created: false, headSha: existingSha, defaultBranch };
  }

  const sourceBranch = params.baseBranch || defaultBranch;
  const sourceSha = await lookupGithubBranchSha(
    params.connectedAccountId,
    params.userId,
    params.owner,
    params.repo,
    sourceBranch
  );

  if (!sourceSha) {
    return { exists: false, created: false, headSha: null, defaultBranch };
  }

  const createdRef = await rawExecuteComposioSlug({
    connectedAccountId: params.connectedAccountId,
    userId: params.userId,
    toolSlug: 'GITHUB_CREATE_A_REFERENCE',
    args: {
      owner: params.owner,
      repo: params.repo,
      ref: `refs/heads/${cleanBranch}`,
      sha: sourceSha,
    },
  });

  if (!createdRef.ok) {
    throw new Error(createdRef.error || `Failed to create branch "${cleanBranch}"`);
  }

  return {
    exists: true,
    created: true,
    headSha: String(createdRef.data?.object?.sha || sourceSha),
    defaultBranch,
  };
}

export async function executeComposioTool(params: {
  connectedAccountId: string;
  userId?: string;
  toolkitSlug?: string;
  toolSlug: string;
  args: Record<string, unknown>;
  skipAutoPrepare?: boolean;
}): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    let resolvedUserId = params.userId?.trim();
    if (!resolvedUserId) {
      const check = await verifyComposioConnectedAccount(params.connectedAccountId).catch(() => null);
      resolvedUserId = check?.composioUserId;
    }

    const rawSlug = params.toolSlug.trim().toUpperCase();
    const normalizedSlug = GITHUB_TOOL_ALIASES[rawSlug] || rawSlug;
    const cleanedArgs: Record<string, unknown> = { ...(params.args || {}) };

    if (!params.skipAutoPrepare) {
      if (normalizedSlug === 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS') {
        if (typeof cleanedArgs.path === 'string') {
          cleanedArgs.path = cleanedArgs.path.replace(/^\/+/, '');
        }
        if (typeof cleanedArgs.content === 'string') {
          cleanedArgs.content = ensureBase64Content(cleanedArgs.content);
        }
        if (
          typeof cleanedArgs.owner === 'string' &&
          typeof cleanedArgs.repo === 'string' &&
          typeof cleanedArgs.path === 'string'
        ) {
          const branch = typeof cleanedArgs.branch === 'string' ? cleanedArgs.branch : undefined;
          if (branch) {
            await ensureGithubBranchExists({
              connectedAccountId: params.connectedAccountId,
              userId: resolvedUserId,
              owner: cleanedArgs.owner,
              repo: cleanedArgs.repo,
              branch,
            }).catch(() => undefined);
          }
          const existingSha = await lookupGithubFileSha(
            params.connectedAccountId,
            resolvedUserId,
            cleanedArgs.owner,
            cleanedArgs.repo,
            cleanedArgs.path,
            branch
          );
          if (existingSha) {
            cleanedArgs.sha = existingSha;
          } else {
            delete cleanedArgs.sha;
          }
        }
      } else if (normalizedSlug === 'GITHUB_DELETE_A_FILE') {
        if (typeof cleanedArgs.path === 'string') {
          cleanedArgs.path = cleanedArgs.path.replace(/^\/+/, '');
        }
        if (
          !cleanedArgs.sha &&
          typeof cleanedArgs.owner === 'string' &&
          typeof cleanedArgs.repo === 'string' &&
          typeof cleanedArgs.path === 'string'
        ) {
          const sha = await lookupGithubFileSha(
            params.connectedAccountId,
            resolvedUserId,
            cleanedArgs.owner,
            cleanedArgs.repo,
            cleanedArgs.path,
            typeof cleanedArgs.branch === 'string' ? cleanedArgs.branch : undefined
          );
          if (sha) cleanedArgs.sha = sha;
        }
      } else if (normalizedSlug === 'GITHUB_CREATE_A_REFERENCE') {
        if (!cleanedArgs.ref && typeof cleanedArgs.branch === 'string') {
          cleanedArgs.ref = `refs/heads/${cleanedArgs.branch.replace(/^refs\/heads\//, '')}`;
          delete cleanedArgs.branch;
        } else if (typeof cleanedArgs.ref === 'string' && !cleanedArgs.ref.startsWith('refs/')) {
          cleanedArgs.ref = `refs/heads/${cleanedArgs.ref.replace(/^heads\//, '')}`;
        }
        if (
          !cleanedArgs.sha &&
          typeof cleanedArgs.owner === 'string' &&
          typeof cleanedArgs.repo === 'string'
        ) {
          const base =
            typeof cleanedArgs.from_branch === 'string'
              ? cleanedArgs.from_branch
              : typeof cleanedArgs.base_branch === 'string'
                ? cleanedArgs.base_branch
                : await lookupGithubRepoDefaultBranch(
                    params.connectedAccountId,
                    resolvedUserId,
                    cleanedArgs.owner,
                    cleanedArgs.repo
                  );
          delete cleanedArgs.from_branch;
          delete cleanedArgs.base_branch;
          const headSha = await lookupGithubBranchSha(
            params.connectedAccountId,
            resolvedUserId,
            cleanedArgs.owner,
            cleanedArgs.repo,
            base
          );
          if (headSha) cleanedArgs.sha = headSha;
        }
      } else if (
        normalizedSlug === 'GITHUB_GET_A_REFERENCE' ||
        normalizedSlug === 'GITHUB_UPDATE_A_REFERENCE' ||
        normalizedSlug === 'GITHUB_DELETE_A_REFERENCE'
      ) {
        if (!cleanedArgs.ref && typeof cleanedArgs.branch === 'string') {
          cleanedArgs.ref = `heads/${cleanedArgs.branch.replace(/^refs\/heads\//, '')}`;
          delete cleanedArgs.branch;
        } else if (typeof cleanedArgs.ref === 'string' && cleanedArgs.ref.startsWith('refs/')) {
          cleanedArgs.ref = cleanedArgs.ref.replace(/^refs\//, '');
        }
      }
    }

    try {
      const execOut = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: normalizedSlug,
        args: cleanedArgs,
      });

      if (!execOut.ok) {
        return {
          ok: false,
          error: execOut.error,
          latencyMs: Date.now() - start,
        };
      }

      return {
        ok: true,
        data: execOut.data,
        latencyMs: Date.now() - start,
      };
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (/not found|unknown tool|404/i.test(msg)) {
        const discoveredSlug = await resolveFallbackSlug(normalizedSlug, params.toolkitSlug);
        if (discoveredSlug && discoveredSlug !== normalizedSlug) {
          const retryOut = await rawExecuteComposioSlug({
            connectedAccountId: params.connectedAccountId,
            userId: resolvedUserId,
            toolSlug: discoveredSlug,
            args: cleanedArgs,
          });
          if (retryOut.ok) {
            return {
              ok: true,
              data: retryOut.data,
              latencyMs: Date.now() - start,
            };
          }
          return {
            ok: false,
            error: retryOut.error,
            latencyMs: Date.now() - start,
          };
        }
      }
      throw firstErr;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Composio execution failed',
      latencyMs: Date.now() - start,
    };
  }
}

export async function executeGithubBatchPush(params: {
  connectedAccountId: string;
  userId?: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch?: string;
  message: string;
  files: Array<{ path: string; content: string }>;
  deletePaths?: string[];
}): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    let resolvedUserId = params.userId?.trim();
    if (!resolvedUserId) {
      const check = await verifyComposioConnectedAccount(params.connectedAccountId).catch(() => null);
      resolvedUserId = check?.composioUserId;
    }

    const owner = params.owner.trim();
    const repo = params.repo.trim();
    const branch = params.branch.trim().replace(/^refs\/heads\//, '').replace(/^heads\//, '');
    const message = params.message.trim() || `Update ${params.files.length} file(s)`;

    const normalizedFiles = params.files
      .filter((f) => f && typeof f.path === 'string' && f.path.trim())
      .map((f) => ({
        path: f.path.trim().replace(/^\/+/, ''),
        content: typeof f.content === 'string' ? f.content : String(f.content ?? ''),
      }));

    const deletePaths = (params.deletePaths || [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().replace(/^\/+/, ''));

    if (normalizedFiles.length === 0 && deletePaths.length === 0) {
      return {
        ok: false,
        error: 'Provide at least one file to push or one path to delete.',
        latencyMs: Date.now() - start,
      };
    }

    let branchState = await ensureGithubBranchExists({
      connectedAccountId: params.connectedAccountId,
      userId: resolvedUserId,
      owner,
      repo,
      branch,
      baseBranch: params.baseBranch,
    });

    // Empty repository initialization (0 commits anywhere yet): seed first file to create initial commit
    let seededFirstFile = false;
    if (!branchState.exists) {
      if (normalizedFiles.length === 0) {
        return {
          ok: false,
          error: `Branch "${branch}" does not exist and repository "${owner}/${repo}" has no commits yet.`,
          latencyMs: Date.now() - start,
        };
      }
      const first = normalizedFiles[0];
      const initBranch = params.baseBranch || branchState.defaultBranch || branch;
      const seedRes = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
        args: {
          owner,
          repo,
          path: first.path,
          message: `Initialize repository with ${first.path}`,
          content: ensureBase64Content(first.content),
          branch: initBranch,
        },
      });
      if (!seedRes.ok) {
        return {
          ok: false,
          error: seedRes.error || 'Failed to initialize empty repository.',
          latencyMs: Date.now() - start,
        };
      }
      seededFirstFile = true;
      branchState = await ensureGithubBranchExists({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        owner,
        repo,
        branch,
        baseBranch: initBranch,
      });
    }

    const remainingFiles = seededFirstFile ? normalizedFiles.slice(1) : normalizedFiles;
    if (remainingFiles.length === 0 && deletePaths.length === 0) {
      return {
        ok: true,
        data: {
          owner,
          repo,
          branch,
          branchCreated: branchState.created,
          commitMode: 'initial_commit',
          commitSha: branchState.headSha,
          filesPushed: normalizedFiles.map((f) => f.path),
          filesDeleted: [],
          url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`,
        },
        latencyMs: Date.now() - start,
      };
    }

    // Primary strategy: Atomic single-commit push via Git Trees API
    if (branchState.headSha) {
      try {
        const commitInfo = await rawExecuteComposioSlug({
          connectedAccountId: params.connectedAccountId,
          userId: resolvedUserId,
          toolSlug: 'GITHUB_GET_A_COMMIT',
          args: { owner, repo, commit_sha: branchState.headSha },
        });
        const baseTreeSha = commitInfo.data?.tree?.sha;

        if (baseTreeSha) {
          const treeEntries: Array<Record<string, unknown>> = [
            ...remainingFiles.map((f) => ({
              path: f.path,
              mode: '100644',
              type: 'blob',
              content: f.content,
            })),
            ...deletePaths.map((p) => ({
              path: p,
              mode: '100644',
              type: 'blob',
              sha: null,
            })),
          ];

          const treeRes = await rawExecuteComposioSlug({
            connectedAccountId: params.connectedAccountId,
            userId: resolvedUserId,
            toolSlug: 'GITHUB_CREATE_A_TREE',
            args: {
              owner,
              repo,
              base_tree: baseTreeSha,
              tree: treeEntries,
            },
          });

          const newTreeSha = treeRes.data?.sha;
          if (treeRes.ok && newTreeSha) {
            const newCommitRes = await rawExecuteComposioSlug({
              connectedAccountId: params.connectedAccountId,
              userId: resolvedUserId,
              toolSlug: 'GITHUB_CREATE_A_COMMIT',
              args: {
                owner,
                repo,
                message,
                tree: newTreeSha,
                parents: [branchState.headSha],
              },
            });

            const newCommitSha = newCommitRes.data?.sha;
            if (newCommitRes.ok && newCommitSha) {
              const updateRefRes = await rawExecuteComposioSlug({
                connectedAccountId: params.connectedAccountId,
                userId: resolvedUserId,
                toolSlug: 'GITHUB_UPDATE_A_REFERENCE',
                args: {
                  owner,
                  repo,
                  ref: `heads/${branch}`,
                  sha: newCommitSha,
                },
              });

              if (updateRefRes.ok) {
                return {
                  ok: true,
                  data: {
                    owner,
                    repo,
                    branch,
                    branchCreated: branchState.created,
                    commitMode: 'atomic_tree',
                    commitSha: newCommitSha,
                    filesPushed: normalizedFiles.map((f) => f.path),
                    filesDeleted: deletePaths,
                    url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`,
                    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
                  },
                  latencyMs: Date.now() - start,
                };
              }
            }
          }
        }
      } catch {
        // Fall through to sequential Contents API strategy below
      }
    }

    // Fallback strategy: Sequential Contents API per file & deletion (guaranteed universal)
    const pushedFiles: string[] = seededFirstFile ? [normalizedFiles[0].path] : [];
    const deletedFiles: string[] = [];
    let lastCommitSha = branchState.headSha;

    for (const file of remainingFiles) {
      const existingSha = await lookupGithubFileSha(
        params.connectedAccountId,
        resolvedUserId,
        owner,
        repo,
        file.path,
        branch
      );
      const putRes = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
        args: {
          owner,
          repo,
          path: file.path,
          message: `${message} (${file.path})`,
          content: ensureBase64Content(file.content),
          branch,
          ...(existingSha ? { sha: existingSha } : {}),
        },
      });
      if (!putRes.ok) {
        return {
          ok: false,
          error: `Failed pushing "${file.path}": ${putRes.error}`,
          latencyMs: Date.now() - start,
        };
      }
      pushedFiles.push(file.path);
      if (putRes.data?.commit?.sha) {
        lastCommitSha = String(putRes.data.commit.sha);
      }
    }

    for (const delPath of deletePaths) {
      const existingSha = await lookupGithubFileSha(
        params.connectedAccountId,
        resolvedUserId,
        owner,
        repo,
        delPath,
        branch
      );
      if (!existingSha) {
        continue;
      }
      const delRes = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_DELETE_A_FILE',
        args: {
          owner,
          repo,
          path: delPath,
          message: `${message} (delete ${delPath})`,
          sha: existingSha,
          branch,
        },
      });
      if (!delRes.ok) {
        return {
          ok: false,
          error: `Failed deleting "${delPath}": ${delRes.error}`,
          latencyMs: Date.now() - start,
        };
      }
      deletedFiles.push(delPath);
      if (delRes.data?.commit?.sha) {
        lastCommitSha = String(delRes.data.commit.sha);
      }
    }

    return {
      ok: true,
      data: {
        owner,
        repo,
        branch,
        branchCreated: branchState.created,
        commitMode: 'sequential_contents',
        commitSha: lastCommitSha,
        filesPushed: pushedFiles,
        filesDeleted: deletedFiles,
        url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`,
      },
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'GitHub batch push failed',
      latencyMs: Date.now() - start,
    };
  }
}

export async function executeGithubBranchAction(params: {
  connectedAccountId: string;
  userId?: string;
  action: 'list' | 'create' | 'delete' | 'merge';
  owner: string;
  repo: string;
  branch?: string;
  fromBranch?: string;
  head?: string;
  base?: string;
  commitMessage?: string;
}): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    let resolvedUserId = params.userId?.trim();
    if (!resolvedUserId) {
      const check = await verifyComposioConnectedAccount(params.connectedAccountId).catch(() => null);
      resolvedUserId = check?.composioUserId;
    }

    const owner = params.owner.trim();
    const repo = params.repo.trim();

    if (params.action === 'list') {
      const res = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_LIST_BRANCHES',
        args: { owner, repo },
      });
      return { ...res, latencyMs: Date.now() - start };
    }

    if (params.action === 'create') {
      if (!params.branch?.trim()) {
        return { ok: false, error: 'branch name is required for create', latencyMs: Date.now() - start };
      }
      const created = await ensureGithubBranchExists({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        owner,
        repo,
        branch: params.branch,
        baseBranch: params.fromBranch,
      });
      return {
        ok: created.exists,
        data: {
          owner,
          repo,
          branch: params.branch,
          created: created.created,
          sha: created.headSha,
          url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(params.branch)}`,
        },
        ...(created.exists ? {} : { error: 'Repository has no base commit to branch from.' }),
        latencyMs: Date.now() - start,
      };
    }

    if (params.action === 'delete') {
      if (!params.branch?.trim()) {
        return { ok: false, error: 'branch name is required for delete', latencyMs: Date.now() - start };
      }
      const cleanBranch = params.branch.trim().replace(/^refs\/heads\//, '').replace(/^heads\//, '');
      const res = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_DELETE_A_REFERENCE',
        args: { owner, repo, ref: `heads/${cleanBranch}` },
      });
      return {
        ok: res.ok,
        data: res.ok ? { deleted: true, branch: cleanBranch } : undefined,
        error: res.error,
        latencyMs: Date.now() - start,
      };
    }

    // merge
    const head = params.head?.trim() || params.branch?.trim();
    if (!head) {
      return { ok: false, error: 'head (source branch) is required for merge', latencyMs: Date.now() - start };
    }
    const base =
      params.base?.trim() ||
      (await lookupGithubRepoDefaultBranch(params.connectedAccountId, resolvedUserId, owner, repo));

    const res = await rawExecuteComposioSlug({
      connectedAccountId: params.connectedAccountId,
      userId: resolvedUserId,
      toolSlug: 'GITHUB_MERGE_A_BRANCH',
      args: {
        owner,
        repo,
        base,
        head,
        ...(params.commitMessage ? { commit_message: params.commitMessage } : {}),
      },
    });
    return { ...res, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'GitHub branch action failed',
      latencyMs: Date.now() - start,
    };
  }
}

export async function executeGithubPullRequestAction(params: {
  connectedAccountId: string;
  userId?: string;
  action: 'list' | 'create' | 'merge' | 'close';
  owner: string;
  repo: string;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  pullNumber?: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    let resolvedUserId = params.userId?.trim();
    if (!resolvedUserId) {
      const check = await verifyComposioConnectedAccount(params.connectedAccountId).catch(() => null);
      resolvedUserId = check?.composioUserId;
    }

    const owner = params.owner.trim();
    const repo = params.repo.trim();

    if (params.action === 'list') {
      const res = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_LIST_PULL_REQUESTS',
        args: { owner, repo },
      });
      return { ...res, latencyMs: Date.now() - start };
    }

    if (params.action === 'create') {
      if (!params.head?.trim()) {
        return { ok: false, error: 'head (source branch) is required to raise a PR', latencyMs: Date.now() - start };
      }
      const base =
        params.base?.trim() ||
        (await lookupGithubRepoDefaultBranch(params.connectedAccountId, resolvedUserId, owner, repo));
      const res = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_CREATE_A_PULL_REQUEST',
        args: {
          owner,
          repo,
          title: params.title?.trim() || `Merge ${params.head} into ${base}`,
          body: params.body || '',
          head: params.head.trim(),
          base,
        },
      });
      return { ...res, latencyMs: Date.now() - start };
    }

    if (!params.pullNumber) {
      return {
        ok: false,
        error: 'pullNumber is required for merge/close PR',
        latencyMs: Date.now() - start,
      };
    }

    if (params.action === 'merge') {
      const res = await rawExecuteComposioSlug({
        connectedAccountId: params.connectedAccountId,
        userId: resolvedUserId,
        toolSlug: 'GITHUB_MERGE_A_PULL_REQUEST',
        args: {
          owner,
          repo,
          pull_number: params.pullNumber,
          merge_method: params.mergeMethod || 'merge',
        },
      });
      return { ...res, latencyMs: Date.now() - start };
    }

    // close
    const res = await rawExecuteComposioSlug({
      connectedAccountId: params.connectedAccountId,
      userId: resolvedUserId,
      toolSlug: 'GITHUB_UPDATE_A_PULL_REQUEST',
      args: {
        owner,
        repo,
        pull_number: params.pullNumber,
        state: 'closed',
      },
    });
    return { ...res, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'GitHub PR action failed',
      latencyMs: Date.now() - start,
    };
  }
}
