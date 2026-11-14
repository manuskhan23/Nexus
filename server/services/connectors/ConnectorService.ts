import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { ConnectorModel } from '../../models';
import { decryptSecret, encryptSecret } from '../auth/crypto';
import { AgentToolDefinition } from '../ai/AIProvider';
import { CONNECTOR_CATALOG, getCatalogConnector } from './catalog';
import {
  McpToolSchema,
  buildMcpAuthHeaders,
  callMcpTool,
  isAllowedConnectorUrl,
  testMcpServer,
} from './McpClient';
import {
  createComposioConnectLink,
  executeComposioTool,
  executeGithubBatchPush,
  executeGithubBranchAction,
  executeGithubPullRequestAction,
  isComposioConfigured,
  listComposioToolsForToolkit,
  mapSlugToComposioToolkit,
  searchComposioTools,
  verifyComposioConnectedAccount,
} from './ComposioBroker';
import {
  OAUTH_PROVIDERS,
  discoverMcpOAuthAndRegister,
  exchangeOAuthCode,
  generatePkcePair,
  getConfiguredDirectOAuthSlugs,
  getEnvOAuthClient,
  resolveCallbackUrl,
  signOAuthState,
  verifyOAuthState,
} from './OAuthRegistry';

export interface ConnectorDraftInput {
  kind: 'catalog' | 'custom_api' | 'mcp_server';
  slug?: string;
  name?: string;
  description?: string;
  baseUrl?: string;
  healthPath?: string;
  authType?: 'bearer' | 'api_key_header' | 'basic' | 'webhook' | 'none';
  authHeaderName?: string;
  token?: string;
  secondaryToken?: string;
  domain?: string;
  customHeaders?: Record<string, string>;
}

export interface ConnectorTestOutput {
  ok: boolean;
  latencyMs: number;
  message: string;
  identity?: string;
  discoveredTools: McpToolSchema[];
  verificationProof?: string;
}

function maskSecret(secret?: string): string {
  if (!secret || secret.length < 6) return secret ? '••••' : '';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

function buildHeadersAndUrl(input: ConnectorDraftInput): {
  url: string;
  baseUrl: string;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  body?: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  authType: 'bearer' | 'api_key_header' | 'basic' | 'webhook' | 'none';
  authHeaderName: string;
  healthPath: string;
} {
  if (input.kind === 'catalog') {
    const def = getCatalogConnector(input.slug || '');
    if (!def) {
      throw new Error(`Unknown catalog connector: ${input.slug}`);
    }
    let resolvedBase = def.baseUrl;
    if (resolvedBase.includes('{domain}')) {
      const cleanDomain = (input.domain || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
      if (!cleanDomain) {
        throw new Error(`${def.domainFieldLabel || 'Domain'} is required for ${def.name}.`);
      }
      resolvedBase = resolvedBase.replace('{domain}', cleanDomain);
    }

    const token = (input.token || '').trim();
    const secondary = (input.secondaryToken || '').trim();
    if (!token) {
      throw new Error(`${def.primaryFieldLabel} is required.`);
    }

    const headers: Record<string, string> = {
      'User-Agent': 'NEXUS-Agent/1.0',
      Accept: 'application/json',
    };
    if (def.slug === 'notion') {
      headers['Notion-Version'] = '2022-06-28';
    }

    let testUrl = def.defaultTestPath.startsWith('http')
      ? def.defaultTestPath
      : `${resolvedBase}${def.defaultTestPath}`;

    if (def.slug === 'trello') {
      if (!secondary) throw new Error('Trello API Key is required.');
      testUrl = `${resolvedBase}/members/me?key=${encodeURIComponent(secondary)}&token=${encodeURIComponent(token)}`;
    } else if (def.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (def.authType === 'api_key_header') {
      const hName = def.authHeaderName || 'X-API-Key';
      headers[hName] = token;
      if (def.slug === 'supabase') {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } else if (def.authType === 'basic') {
      if (!secondary) {
        throw new Error(`${def.secondaryFieldLabel || 'Username/Email'} is required.`);
      }
      headers['Authorization'] = `Basic ${Buffer.from(`${secondary}:${token}`).toString('base64')}`;
    } else if (def.authType === 'webhook') {
      resolvedBase = token;
      testUrl = token;
    }

    if (def.testMethod === 'POST' && def.testBody) {
      headers['Content-Type'] = 'application/json';
    }

    return {
      url: testUrl,
      baseUrl: resolvedBase,
      headers,
      method: def.testMethod || 'GET',
      body: def.testBody,
      name: input.name?.trim() || def.name,
      slug: def.slug,
      category: def.category,
      description: def.description,
      authType: def.authType,
      authHeaderName: def.authHeaderName || '',
      healthPath: def.defaultTestPath,
    };
  }

  if (input.kind === 'mcp_server') {
    const baseUrl = (input.baseUrl || '').trim();
    if (!baseUrl) throw new Error('MCP Server URL is required.');
    const name = (input.name || '').trim();
    if (!name) throw new Error('MCP Server name is required.');
    const slug = `mcp_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32)}`;
    const authType = input.authType || (input.token ? 'bearer' : 'none');
    const headers = buildMcpAuthHeaders({
      authType,
      token: input.token,
      authHeaderName: input.authHeaderName,
      customHeaders: input.customHeaders,
    });
    return {
      url: baseUrl,
      baseUrl,
      headers,
      method: 'POST',
      name,
      slug,
      category: 'MCP Server',
      description: input.description?.trim() || `Custom MCP Server (${baseUrl})`,
      authType,
      authHeaderName: input.authHeaderName || '',
      healthPath: '',
    };
  }

  // custom_api
  const name = (input.name || '').trim();
  const baseUrl = (input.baseUrl || '').trim().replace(/\/+$/, '');
  const healthPath = (input.healthPath || '/').trim();
  if (!name || !baseUrl) {
    throw new Error('Connector name and Base URL are required.');
  }
  const slug = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32)}`;
  const authType = input.authType || (input.token ? 'bearer' : 'none');
  const headers: Record<string, string> = {
    'User-Agent': 'NEXUS-Agent/1.0',
    Accept: 'application/json',
    ...(input.customHeaders || {}),
  };
  const token = (input.token || '').trim();
  if (token) {
    if (authType === 'bearer') headers['Authorization'] = `Bearer ${token}`;
    else if (authType === 'api_key_header') {
      headers[input.authHeaderName?.trim() || 'X-API-Key'] = token;
    } else if (authType === 'basic') {
      headers['Authorization'] = `Basic ${Buffer.from(`${input.secondaryToken || ''}:${token}`).toString('base64')}`;
    }
  }

  const normalizedPath = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  return {
    url: healthPath.startsWith('http') ? healthPath : `${baseUrl}${normalizedPath}`,
    baseUrl,
    headers,
    method: 'GET',
    name,
    slug,
    category: 'Custom API',
    description: input.description?.trim() || `Custom REST connector (${baseUrl})`,
    authType,
    authHeaderName: input.authHeaderName || '',
    healthPath: normalizedPath,
  };
}

function signVerificationProof(userId: string, fingerprintSource: string, tools: McpToolSchema[]): string {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = JSON.stringify({
    userId,
    fp: crypto.createHash('sha256').update(fingerprintSource).digest('hex'),
    tools,
    exp: expiresAt,
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyProof(
  proof: string | undefined,
  userId: string,
  fingerprintSource: string
): McpToolSchema[] | null {
  if (!proof || !proof.includes('.')) return null;
  const [encoded, sig] = proof.split('.');
  const expectedSig = crypto.createHmac('sha256', env.JWT_SECRET).update(encoded).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (parsed.userId !== userId || Date.now() > Number(parsed.exp)) return null;
    const expectedFp = crypto.createHash('sha256').update(fingerprintSource).digest('hex');
    if (parsed.fp !== expectedFp) return null;
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return null;
  }
}

function fingerprintForDraft(input: ConnectorDraftInput): string {
  return JSON.stringify({
    kind: input.kind,
    slug: input.slug || '',
    baseUrl: input.baseUrl || '',
    healthPath: input.healthPath || '',
    authType: input.authType || '',
    authHeaderName: input.authHeaderName || '',
    token: input.token || '',
    secondaryToken: input.secondaryToken || '',
    domain: input.domain || '',
  });
}

export async function testConnectorDraft(
  userId: string,
  input: ConnectorDraftInput
): Promise<ConnectorTestOutput> {
  const start = Date.now();
  let resolved;
  try {
    resolved = buildHeadersAndUrl(input);
  } catch (err) {
    return {
      ok: false,
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Invalid connector configuration',
      discoveredTools: [],
    };
  }

  if (input.kind === 'mcp_server') {
    const mcpResult = await testMcpServer({ url: resolved.url, headers: resolved.headers });
    return {
      ok: mcpResult.ok,
      latencyMs: mcpResult.latencyMs,
      message: mcpResult.message,
      identity: mcpResult.serverInfo?.name,
      discoveredTools: mcpResult.tools,
      ...(mcpResult.ok
        ? { verificationProof: signVerificationProof(userId, fingerprintForDraft(input), mcpResult.tools) }
        : {}),
    };
  }

  const urlCheck = isAllowedConnectorUrl(resolved.url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      latencyMs: 0,
      message: urlCheck.reason || 'Invalid connector URL',
      discoveredTools: [],
    };
  }

  try {
    const res = await fetch(resolved.url, {
      method: resolved.authType === 'webhook' ? 'HEAD' : resolved.method,
      headers: resolved.headers,
      ...(resolved.method === 'POST' && resolved.body ? { body: resolved.body } : {}),
      signal: AbortSignal.timeout(9_000),
    });

    const latencyMs = Date.now() - start;

    // Webhooks often return 405 on HEAD/GET when reachable; 2xx/3xx/405 proves reachable endpoint
    if (resolved.authType === 'webhook') {
      if (res.status < 500 && res.status !== 404) {
        return {
          ok: true,
          latencyMs,
          message: `Webhook endpoint reachable (HTTP ${res.status}).`,
          discoveredTools: [],
          verificationProof: signVerificationProof(userId, fingerprintForDraft(input), []),
        };
      }
      return {
        ok: false,
        latencyMs,
        message: `Webhook check failed with HTTP ${res.status}.`,
        discoveredTools: [],
      };
    }

    const text = await res.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const detail = parsed?.message || parsed?.error || res.statusText;
      return {
        ok: false,
        latencyMs,
        message: `Authentication/endpoint check failed (HTTP ${res.status}): ${String(detail).slice(0, 180)}`,
        discoveredTools: [],
      };
    }

    // Slack returns 200 OK even when { ok: false, error: 'invalid_auth' }
    if (resolved.slug === 'slack' && parsed && parsed.ok === false) {
      return {
        ok: false,
        latencyMs,
        message: `Slack auth failed: ${parsed.error || 'invalid_auth'}`,
        discoveredTools: [],
      };
    }

    // Linear GraphQL returns 200 with errors array on bad key
    if (resolved.slug === 'linear' && Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      return {
        ok: false,
        latencyMs,
        message: `Linear API error: ${parsed.errors[0]?.message || 'Unauthorized'}`,
        discoveredTools: [],
      };
    }

    const identity =
      parsed?.login ||
      parsed?.email ||
      parsed?.emailAddress ||
      parsed?.name ||
      parsed?.user?.email ||
      parsed?.user?.name ||
      parsed?.data?.viewer?.name ||
      parsed?.team ||
      parsed?.shop?.name ||
      resolved.name;

    return {
      ok: true,
      latencyMs,
      identity: String(identity),
      message: `Verified ${resolved.name} (${identity}) in ${latencyMs}ms.`,
      discoveredTools: [],
      verificationProof: signVerificationProof(userId, fingerprintForDraft(input), []),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : 'Connection test failed',
      discoveredTools: [],
    };
  }
}

export function sanitizeConnectorDoc(doc: any) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const { _id, encryptedSecret, ...rest } = obj;
  return { id: _id, ...rest };
}

export async function saveVerifiedConnector(
  userId: string,
  input: ConnectorDraftInput & { verificationProof?: string }
) {
  const resolved = buildHeadersAndUrl(input);
  const fp = fingerprintForDraft(input);
  let verifiedTools = verifyProof(input.verificationProof, userId, fp);
  let testLatencyMs = 0;
  let testMessage = 'Verified connection';

  // Enforce test-before-DB-store! If no valid proof was supplied, run the live test right now and fail if unsuccessful.
  if (verifiedTools === null) {
    const testResult = await testConnectorDraft(userId, input);
    if (!testResult.ok) {
      throw new Error(`Connection test failed before saving: ${testResult.message}`);
    }
    verifiedTools = testResult.discoveredTools;
    testLatencyMs = testResult.latencyMs;
    testMessage = testResult.message;
  }

  const secretPayload = JSON.stringify({
    token: (input.token || '').trim(),
    secondaryToken: (input.secondaryToken || '').trim(),
    customHeaders: input.customHeaders || {},
  });
  const encryptedSecret = encryptSecret(secretPayload);

  const created = await ConnectorModel.create({
    _id: crypto.randomUUID(),
    userId,
    kind: input.kind,
    slug: resolved.slug,
    name: resolved.name,
    category: resolved.category,
    description: resolved.description,
    baseUrl: resolved.baseUrl,
    healthPath: resolved.healthPath,
    authType: resolved.authType,
    authHeaderName: resolved.authHeaderName,
    extraConfig: {
      domain: input.domain?.trim() || '',
    },
    encryptedSecret,
    secretHint: maskSecret(input.token),
    status: 'connected',
    lastTestedAt: new Date(),
    lastLatencyMs: testLatencyMs,
    lastTestMessage: testMessage,
    discoveredTools: verifiedTools,
    active: true,
  });

  return sanitizeConnectorDoc(created);
}

export async function retestSavedConnector(userId: string, connectorId: string) {
  const doc = await ConnectorModel.findOne({ _id: connectorId, userId });
  if (!doc) return null;

  let secret: {
    token?: string;
    secondaryToken?: string;
    customHeaders?: Record<string, string>;
    composioAccountId?: string;
  } = {};
  if (doc.encryptedSecret) {
    secret = JSON.parse(decryptSecret(doc.encryptedSecret));
  }

  if (doc.kind === 'composio_oauth') {
    const start = Date.now();
    const accountId = secret.composioAccountId || doc.extraConfig?.composioAccountId;
    if (!accountId) {
      return {
        connector: sanitizeConnectorDoc(doc),
        testResult: {
          ok: false,
          latencyMs: 0,
          message: 'Missing Composio connected account ID.',
          discoveredTools: doc.discoveredTools || [],
        },
      };
    }
    try {
      const check = await verifyComposioConnectedAccount(accountId);
      const toolkitSlug = check.toolkitSlug || doc.extraConfig?.toolkitSlug || mapSlugToComposioToolkit(doc.slug);
      const tools = check.ok ? await listComposioToolsForToolkit(toolkitSlug) : doc.discoveredTools || [];
      const latencyMs = Date.now() - start;
      doc.status = check.ok ? 'connected' : 'error';
      doc.lastTestedAt = new Date();
      doc.lastLatencyMs = latencyMs;
      doc.lastTestMessage = check.message;
      if (check.ok && tools.length > 0) {
        doc.discoveredTools = tools;
      }
      await doc.save();
      return {
        connector: sanitizeConnectorDoc(doc),
        testResult: {
          ok: check.ok,
          latencyMs,
          message: check.message,
          discoveredTools: doc.discoveredTools || [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Composio retest failed';
      doc.status = 'error';
      doc.lastTestedAt = new Date();
      doc.lastTestMessage = msg;
      await doc.save();
      return {
        connector: sanitizeConnectorDoc(doc),
        testResult: {
          ok: false,
          latencyMs: Date.now() - start,
          message: msg,
          discoveredTools: doc.discoveredTools || [],
        },
      };
    }
  }

  const draft: ConnectorDraftInput = {
    kind: doc.kind as 'catalog' | 'custom_api' | 'mcp_server',
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    baseUrl: doc.baseUrl,
    healthPath: doc.healthPath,
    authType: doc.authType as any,
    authHeaderName: doc.authHeaderName,
    token: secret.token,
    secondaryToken: secret.secondaryToken,
    domain: doc.extraConfig?.domain,
    customHeaders: secret.customHeaders,
  };

  const result = await testConnectorDraft(userId, draft);
  doc.status = result.ok ? 'connected' : 'error';
  doc.lastTestedAt = new Date();
  doc.lastLatencyMs = result.latencyMs;
  doc.lastTestMessage = result.message;
  if (doc.kind === 'mcp_server' && result.ok) {
    doc.discoveredTools = result.discoveredTools;
  }
  await doc.save();

  return { connector: sanitizeConnectorDoc(doc), testResult: result };
}

export async function invokeSavedConnector(
  userId: string,
  connectorId: string,
  params: {
    // For MCP servers:
    toolName?: string;
    args?: Record<string, unknown>;
    // For REST API / catalog connectors:
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path?: string;
    body?: unknown;
  }
): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const doc = await ConnectorModel.findOne({ _id: connectorId, userId });
  if (!doc) return { ok: false, error: 'Connector not found', latencyMs: 0 };
  if (!doc.active) return { ok: false, error: 'Connector is paused', latencyMs: 0 };

  let secret: {
    token?: string;
    secondaryToken?: string;
    customHeaders?: Record<string, string>;
    composioAccountId?: string;
  } = {};
  if (doc.encryptedSecret) {
    secret = JSON.parse(decryptSecret(doc.encryptedSecret));
  }

  if (doc.kind === 'composio_oauth') {
    if (!params.toolName) {
      return { ok: false, error: 'toolName is required for Composio OAuth tool calls', latencyMs: 0 };
    }
    const accountId = secret.composioAccountId || doc.extraConfig?.composioAccountId;
    if (!accountId) {
      return { ok: false, error: 'Connected account ID missing', latencyMs: 0 };
    }
    return executeComposioTool({
      connectedAccountId: accountId,
      userId: doc.extraConfig?.composioUserId || userId,
      toolkitSlug: doc.extraConfig?.toolkitSlug || mapSlugToComposioToolkit(doc.slug),
      toolSlug: params.toolName,
      args: params.args || {},
    });
  }

  if (doc.kind === 'mcp_server') {
    if (!params.toolName) return { ok: false, error: 'toolName is required for MCP calls', latencyMs: 0 };
    const headers = buildMcpAuthHeaders({
      authType: doc.authType,
      token: secret.token,
      authHeaderName: doc.authHeaderName,
      customHeaders: secret.customHeaders,
    });
    return callMcpTool({
      url: doc.baseUrl,
      headers,
      toolName: params.toolName,
      args: params.args || {},
    });
  }

  const start = Date.now();
  const resolved = buildHeadersAndUrl({
    kind: doc.kind as 'catalog' | 'custom_api' | 'mcp_server',
    slug: doc.slug,
    name: doc.name,
    baseUrl: doc.baseUrl,
    healthPath: doc.healthPath,
    authType: doc.authType as any,
    authHeaderName: doc.authHeaderName,
    token: secret.token,
    secondaryToken: secret.secondaryToken,
    domain: doc.extraConfig?.domain,
    customHeaders: secret.customHeaders,
  });

  const targetPath = params.path?.trim() || resolved.healthPath || '/';
  const targetUrl = targetPath.startsWith('http')
    ? targetPath
    : `${resolved.baseUrl}${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`;

  const check = isAllowedConnectorUrl(targetUrl);
  if (!check.ok) return { ok: false, error: check.reason, latencyMs: 0 };

  try {
    const method = params.method || 'GET';
    const headers = { ...resolved.headers };
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(targetUrl, {
      method,
      headers,
      ...(params.body !== undefined && method !== 'GET'
        ? { body: typeof params.body === 'string' ? params.body : JSON.stringify(params.body) }
        : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text().catch(() => '');
    let parsed: any = raw;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      // Keep text
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status}: ${typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`,
        latencyMs: Date.now() - start,
      };
    }
    return { ok: true, data: parsed, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Connector request failed',
      latencyMs: Date.now() - start,
    };
  }
}

export interface DynamicRuntimeTool {
  definition: AgentToolDefinition;
  riskLevel: 'low' | 'moderate';
  execute: (args: Record<string, unknown>) => Promise<{ success: boolean; data?: any; error?: string }>;
}

function makeSafeToolName(prefix: string, slug: string, rawName: string): string {
  const cleanSlug = slug.replace(/^mcp_/, '').replace(/[^a-zA-Z0-9_]/g, '_');
  const cleanAction = rawName.replace(/[^a-zA-Z0-9_]/g, '_');
  const full = `${prefix}__${cleanSlug}__${cleanAction}`;
  if (full.length <= 64) return full;

  const compactPrefix = prefix === 'composio' ? 'c' : 'm';
  const compact = `${compactPrefix}__${cleanSlug}__${cleanAction}`;
  if (compact.length <= 64) return compact;

  const hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 6);
  return `${compact.slice(0, 57)}_${hash}`;
}

function inferToolRisk(actionName: string): 'low' | 'moderate' {
  return /create|update|delete|write|send|post|remove|execute|modify|add|edit|fork|merge|star|follow|close|invite|trigger/i.test(
    actionName
  )
    ? 'moderate'
    : 'low';
}

export async function getDynamicConnectorToolsForUser(userId: string): Promise<Map<string, DynamicRuntimeTool>> {
  const connectors = await ConnectorModel.find({ userId, active: true }).lean();
  const map = new Map<string, DynamicRuntimeTool>();

  for (const conn of connectors as any[]) {
    if (conn.kind === 'mcp_server' || conn.kind === 'composio_oauth') {
      const prefix = conn.kind === 'composio_oauth' ? 'composio' : 'mcp';
      const cleanSlug = String(conn.slug || '').replace(/^mcp_/, '').replace(/[^a-zA-Z0-9_]/g, '_');
      const tools: McpToolSchema[] = Array.isArray(conn.discoveredTools) ? conn.discoveredTools : [];

      for (const t of tools) {
        const safeTool = makeSafeToolName(prefix, cleanSlug, t.name);
        const props: Record<string, any> = {};
        const rawProps = t.inputSchema?.properties || {};
        for (const [k, v] of Object.entries<any>(rawProps)) {
          const pType = ['string', 'number', 'boolean', 'array', 'object'].includes(v?.type)
            ? v.type
            : 'string';
          props[k] = {
            type: pType,
            description: v?.description || `Parameter ${k}`,
            ...(Array.isArray(v?.enum) ? { enum: v.enum } : {}),
          };
        }

        map.set(safeTool, {
          definition: {
            name: safeTool,
            description: `[${conn.kind === 'composio_oauth' ? 'OAuth' : 'MCP'}: ${conn.name}] ${t.description || t.name}`,
            parameters: {
              properties: props,
              required: Array.isArray(t.inputSchema?.required) ? t.inputSchema!.required : [],
            },
          },
          riskLevel: inferToolRisk(t.name),
          execute: async (args) => {
            const res = await invokeSavedConnector(userId, conn._id, {
              toolName: t.name,
              args,
            });
            return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
          },
        });
      }

      if (conn.kind === 'composio_oauth') {
        const toolkitSlug = String(conn.extraConfig?.toolkitSlug || mapSlugToComposioToolkit(conn.slug));
        const searchToolName = makeSafeToolName('composio', cleanSlug, 'search_tools');
        map.set(searchToolName, {
          definition: {
            name: searchToolName,
            description: `[OAuth: ${conn.name}] Search all available ${conn.name} actions (e.g. create repo, list issues, create event) to discover exact toolSlug names and parameters.`,
            parameters: {
              properties: {
                query: {
                  type: 'string',
                  description: `Action keyword to search in ${conn.name}, e.g. "create repository" or "list issues"`,
                },
              },
              required: ['query'],
            },
          },
          riskLevel: 'low',
          execute: async (args) => {
            const q = String(args?.query || '').trim();
            const found = await searchComposioTools(toolkitSlug, q, 15);
            return {
              success: true,
              data: {
                toolkit: toolkitSlug,
                connectorName: conn.name,
                executeWith: makeSafeToolName('composio', cleanSlug, 'execute_action'),
                tools: found.map((item) => {
                  const compactProps: Record<string, { type: string; description?: string; enum?: string[] }> = {};
                  for (const [pk, pv] of Object.entries<any>(item.inputSchema?.properties || {})) {
                    compactProps[pk] = {
                      type: pv?.type || 'string',
                      ...(pv?.description ? { description: String(pv.description).slice(0, 140) } : {}),
                      ...(Array.isArray(pv?.enum) ? { enum: pv.enum } : {}),
                    };
                  }
                  return {
                    toolSlug: item.name,
                    description: (item.description || '').slice(0, 200),
                    required: item.inputSchema?.required || [],
                    properties: compactProps,
                  };
                }),
              },
            };
          },
        });

        const execToolName = makeSafeToolName('composio', cleanSlug, 'execute_action');
        map.set(execToolName, {
          definition: {
            name: execToolName,
            description: `[OAuth: ${conn.name}] Execute any ${conn.name} Composio action by exact toolSlug (use ${searchToolName} first if unsure of parameters).`,
            parameters: {
              properties: {
                toolSlug: {
                  type: 'string',
                  description: `Exact Composio tool slug for ${conn.name}, e.g. GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER`,
                },
                argsJson: {
                  type: 'string',
                  description: 'JSON object string of arguments required by the action, e.g. {"name":"my-repo"}',
                },
              },
              required: ['toolSlug'],
            },
          },
          riskLevel: 'moderate',
          execute: async (args) => {
            const toolSlug = String(args?.toolSlug || '').trim();
            if (!toolSlug) {
              return { success: false, error: 'toolSlug is required.' };
            }
            let actionArgs: Record<string, unknown> = {};
            if (typeof args?.argsJson === 'string' && args.argsJson.trim()) {
              try {
                actionArgs = JSON.parse(args.argsJson);
              } catch {
                return { success: false, error: 'argsJson must be valid JSON.' };
              }
            } else if (args?.argsJson && typeof args.argsJson === 'object') {
              actionArgs = args.argsJson as Record<string, unknown>;
            } else if (args?.args && typeof args.args === 'object') {
              actionArgs = args.args as Record<string, unknown>;
            } else {
              const { toolSlug: _skip1, argsJson: _skip2, ...rest } = args || {};
              actionArgs = rest;
            }
            const res = await invokeSavedConnector(userId, conn._id, {
              toolName: toolSlug,
              args: actionArgs,
            });
            return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
          },
        });

        if (toolkitSlug === 'github') {
          let composioAccountId = String(conn.extraConfig?.composioAccountId || '');
          if (!composioAccountId && conn.encryptedSecret) {
            try {
              const dec = JSON.parse(decryptSecret(conn.encryptedSecret));
              composioAccountId = String(dec?.composioAccountId || '');
            } catch {
              composioAccountId = '';
            }
          }
          const composioUserId = String(conn.extraConfig?.composioUserId || userId);

          if (composioAccountId) {
            const pushToolName = makeSafeToolName('composio', cleanSlug, 'push_files');
            map.set(pushToolName, {
              definition: {
                name: pushToolName,
                description:
                  '[OAuth: GitHub] Push multiple files at once (e.g. an entire React/Vite boilerplate) and optional file deletions to a GitHub branch in one commit batch. Automatically creates the branch if missing and accepts plain UTF-8 source code.',
                parameters: {
                  properties: {
                    owner: { type: 'string', description: 'GitHub username or organization' },
                    repo: { type: 'string', description: 'Repository name' },
                    branch: {
                      type: 'string',
                      description: 'Target branch name (auto-created from baseBranch/default if missing)',
                    },
                    baseBranch: {
                      type: 'string',
                      description: 'Optional source branch if creating a new branch (defaults to repo default)',
                    },
                    message: { type: 'string', description: 'Git commit message' },
                    files: {
                      type: 'array',
                      description: 'List of files with relative path and plain UTF-8 source content',
                      items: {
                        type: 'object',
                        description: 'File entry',
                        properties: {
                          path: { type: 'string', description: 'File path, e.g. src/App.jsx' },
                          content: { type: 'string', description: 'Plain UTF-8 file content' },
                        },
                        required: ['path', 'content'],
                      },
                    },
                    deletePaths: {
                      type: 'array',
                      description: 'Optional list of file paths to delete in the same commit',
                      items: { type: 'string', description: 'File path to delete' },
                    },
                  },
                  required: ['owner', 'repo', 'branch', 'message', 'files'],
                },
              },
              riskLevel: 'moderate',
              execute: async (args) => {
                let rawFiles: any = args?.files ?? args?.filesJson;
                if (typeof rawFiles === 'string') {
                  try {
                    rawFiles = JSON.parse(rawFiles);
                  } catch {
                    return { success: false, error: 'files must be an array of { path, content } objects.' };
                  }
                }
                if (!Array.isArray(rawFiles)) {
                  return { success: false, error: 'files array is required.' };
                }
                let rawDeletes: any = args?.deletePaths;
                if (typeof rawDeletes === 'string') {
                  try {
                    rawDeletes = JSON.parse(rawDeletes);
                  } catch {
                    rawDeletes = [];
                  }
                }
                const res = await executeGithubBatchPush({
                  connectedAccountId: composioAccountId,
                  userId: composioUserId,
                  owner: String(args?.owner || ''),
                  repo: String(args?.repo || ''),
                  branch: String(args?.branch || 'main'),
                  baseBranch: typeof args?.baseBranch === 'string' ? args.baseBranch : undefined,
                  message: String(args?.message || 'Push files via NEXUS'),
                  files: rawFiles,
                  deletePaths: Array.isArray(rawDeletes) ? rawDeletes : [],
                });
                return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
              },
            });

            const deleteFilesToolName = makeSafeToolName('composio', cleanSlug, 'delete_files');
            map.set(deleteFilesToolName, {
              definition: {
                name: deleteFilesToolName,
                description:
                  '[OAuth: GitHub] Delete one or more files from a GitHub repository branch in one operation.',
                parameters: {
                  properties: {
                    owner: { type: 'string', description: 'GitHub username or organization' },
                    repo: { type: 'string', description: 'Repository name' },
                    branch: { type: 'string', description: 'Target branch name' },
                    message: { type: 'string', description: 'Commit message for deletion' },
                    paths: {
                      type: 'array',
                      description: 'Array of file paths to delete',
                      items: { type: 'string', description: 'File path' },
                    },
                  },
                  required: ['owner', 'repo', 'branch', 'message', 'paths'],
                },
              },
              riskLevel: 'moderate',
              execute: async (args) => {
                let paths: any = args?.paths;
                if (typeof paths === 'string') {
                  try {
                    paths = JSON.parse(paths);
                  } catch {
                    paths = [paths];
                  }
                }
                const res = await executeGithubBatchPush({
                  connectedAccountId: composioAccountId,
                  userId: composioUserId,
                  owner: String(args?.owner || ''),
                  repo: String(args?.repo || ''),
                  branch: String(args?.branch || 'main'),
                  message: String(args?.message || 'Delete files via NEXUS'),
                  files: [],
                  deletePaths: Array.isArray(paths) ? paths : [],
                });
                return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
              },
            });

            const branchToolName = makeSafeToolName('composio', cleanSlug, 'branch_manager');
            map.set(branchToolName, {
              definition: {
                name: branchToolName,
                description:
                  '[OAuth: GitHub] Create, delete, merge, or list branches in a GitHub repository.',
                parameters: {
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Branch operation to perform',
                      enum: ['list', 'create', 'delete', 'merge'],
                    },
                    owner: { type: 'string', description: 'GitHub username or organization' },
                    repo: { type: 'string', description: 'Repository name' },
                    branch: { type: 'string', description: 'Branch name for create or delete' },
                    fromBranch: {
                      type: 'string',
                      description: 'Source branch when creating a new branch (defaults to repo default)',
                    },
                    head: { type: 'string', description: 'Source branch to merge from (for merge)' },
                    base: {
                      type: 'string',
                      description: 'Destination branch to merge into (for merge, defaults to repo default)',
                    },
                    commitMessage: { type: 'string', description: 'Optional merge commit message' },
                  },
                  required: ['action', 'owner', 'repo'],
                },
              },
              riskLevel: 'moderate',
              execute: async (args) => {
                const action = String(args?.action || 'list') as 'list' | 'create' | 'delete' | 'merge';
                const res = await executeGithubBranchAction({
                  connectedAccountId: composioAccountId,
                  userId: composioUserId,
                  action,
                  owner: String(args?.owner || ''),
                  repo: String(args?.repo || ''),
                  branch: typeof args?.branch === 'string' ? args.branch : undefined,
                  fromBranch: typeof args?.fromBranch === 'string' ? args.fromBranch : undefined,
                  head: typeof args?.head === 'string' ? args.head : undefined,
                  base: typeof args?.base === 'string' ? args.base : undefined,
                  commitMessage: typeof args?.commitMessage === 'string' ? args.commitMessage : undefined,
                });
                return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
              },
            });

            const prToolName = makeSafeToolName('composio', cleanSlug, 'pull_request_manager');
            map.set(prToolName, {
              definition: {
                name: prToolName,
                description:
                  '[OAuth: GitHub] Create (raise), merge, close, or list Pull Requests in a GitHub repository.',
                parameters: {
                  properties: {
                    action: {
                      type: 'string',
                      description: 'Pull Request operation',
                      enum: ['list', 'create', 'merge', 'close'],
                    },
                    owner: { type: 'string', description: 'GitHub username or organization' },
                    repo: { type: 'string', description: 'Repository name' },
                    title: { type: 'string', description: 'Pull Request title (for create)' },
                    body: { type: 'string', description: 'Pull Request description (for create)' },
                    head: { type: 'string', description: 'Source branch (for create, e.g. React)' },
                    base: { type: 'string', description: 'Target branch (for create, e.g. main)' },
                    pullNumber: { type: 'number', description: 'Pull Request number (for merge/close)' },
                    mergeMethod: {
                      type: 'string',
                      description: 'Merge strategy (for merge)',
                      enum: ['merge', 'squash', 'rebase'],
                    },
                  },
                  required: ['action', 'owner', 'repo'],
                },
              },
              riskLevel: 'moderate',
              execute: async (args) => {
                const action = String(args?.action || 'list') as 'list' | 'create' | 'merge' | 'close';
                const res = await executeGithubPullRequestAction({
                  connectedAccountId: composioAccountId,
                  userId: composioUserId,
                  action,
                  owner: String(args?.owner || ''),
                  repo: String(args?.repo || ''),
                  title: typeof args?.title === 'string' ? args.title : undefined,
                  body: typeof args?.body === 'string' ? args.body : undefined,
                  head: typeof args?.head === 'string' ? args.head : undefined,
                  base: typeof args?.base === 'string' ? args.base : undefined,
                  pullNumber: typeof args?.pullNumber === 'number' ? args.pullNumber : Number(args?.pullNumber) || undefined,
                  mergeMethod:
                    args?.mergeMethod === 'squash' || args?.mergeMethod === 'rebase'
                      ? args.mergeMethod
                      : 'merge',
                });
                return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
              },
            });
          }
        }
      }
    } else {
      const toolName = `connector_${conn.slug}_request`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
      map.set(toolName, {
        definition: {
          name: toolName,
          description: `[Connected ${conn.name}] Make an authenticated ${conn.name} API request (${conn.baseUrl}).`,
          parameters: {
            properties: {
              method: {
                type: 'string',
                description: 'HTTP method',
                enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              },
              path: {
                type: 'string',
                description: `API path relative to ${conn.baseUrl}, e.g. "${conn.healthPath || '/'}"`,
              },
              bodyJson: {
                type: 'string',
                description: 'Optional JSON string request body for POST/PUT/PATCH',
              },
            },
            required: ['method', 'path'],
          },
        },
        riskLevel: 'moderate',
        execute: async (args) => {
          const parsedSchema = z.object({
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
            path: z.string().min(1),
            bodyJson: z.string().optional(),
          }).safeParse(args);

          if (!parsedSchema.success) {
            return { success: false, error: 'Invalid connector request arguments.' };
          }
          let body: any = undefined;
          if (parsedSchema.data.bodyJson) {
            try {
              body = JSON.parse(parsedSchema.data.bodyJson);
            } catch {
              body = parsedSchema.data.bodyJson;
            }
          }
          const res = await invokeSavedConnector(userId, conn._id, {
            method: parsedSchema.data.method,
            path: parsedSchema.data.path,
            body,
          });
          return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
        },
      });
    }
  }

  return map;
}

export async function resolveDynamicToolForUser(
  userId: string,
  requestedName: string,
  dynamicTools: Map<string, DynamicRuntimeTool>
): Promise<DynamicRuntimeTool | undefined> {
  const exact = dynamicTools.get(requestedName);
  if (exact) return exact;

  // Fallback for full-length or dynamic Composio tool names (e.g. >64 chars or un-cached action slugs)
  const composioMatch = requestedName.match(/^(?:composio|c)__([a-zA-Z0-9_]+?)__([A-Za-z0-9_.-]+)$/);
  if (!composioMatch) return undefined;

  const targetSlug = composioMatch[1].toLowerCase();
  const actionName = composioMatch[2];
  const connectors = await ConnectorModel.find({
    userId,
    active: true,
    kind: 'composio_oauth',
  }).lean();

  const conn = (connectors as any[]).find(
    (c) => String(c.slug || '').toLowerCase().replace(/[^a-z0-9_]/g, '_') === targetSlug
  );
  if (!conn) return undefined;

  return {
    definition: {
      name: requestedName,
      description: `[OAuth: ${conn.name}] ${actionName}`,
      parameters: { properties: {}, required: [] },
    },
    riskLevel: inferToolRisk(actionName),
    execute: async (args) => {
      const res = await invokeSavedConnector(userId, conn._id, {
        toolName: actionName,
        args,
      });
      return res.ok ? { success: true, data: res.data } : { success: false, error: res.error };
    },
  };
}

export function getOAuthCapabilities(clientOrigin?: string) {
  const composioConfigured = isComposioConfigured();
  const directOAuthSlugs = getConfiguredDirectOAuthSlugs();
  const callbackUrl = resolveCallbackUrl(clientOrigin);

  const providers: Record<
    string,
    {
      oauthSupported: boolean;
      readyMode: 'composio' | 'direct_env' | 'needs_setup';
      envKeyHint?: string;
      setupDocsUrl?: string;
    }
  > = {};

  for (const item of CONNECTOR_CATALOG) {
    const spec = OAUTH_PROVIDERS[item.slug];
    const hasDirect = directOAuthSlugs.includes(item.slug);
    const oauthSupported = Boolean(spec) || composioConfigured;
    const readyMode = hasDirect ? 'direct_env' : composioConfigured ? 'composio' : 'needs_setup';
    providers[item.slug] = {
      oauthSupported,
      readyMode,
      envKeyHint: spec?.envKeyHint,
      setupDocsUrl: spec?.setupDocsUrl,
    };
  }

  return {
    composioConfigured,
    appUrl: env.APP_URL || clientOrigin || env.CLIENT_URL,
    callbackUrl,
    directOAuthSlugs,
    providers,
  };
}

export async function startConnectorOAuth(
  userId: string,
  params: {
    mode?: 'auto' | 'composio' | 'direct_oauth' | 'mcp_oauth';
    slug?: string;
    name?: string;
    mcpUrl?: string;
    origin?: string;
    clientId?: string;
    clientSecret?: string;
    domain?: string;
  }
): Promise<{
  authUrl: string;
  mode: 'composio' | 'direct_oauth' | 'mcp_oauth';
  callbackUrl: string;
}> {
  const callbackUrl = resolveCallbackUrl(params.origin);

  // 1) MCP 2.1 OAuth Discovery flow
  if (params.mode === 'mcp_oauth') {
    const mcpUrl = (params.mcpUrl || '').trim();
    if (!mcpUrl) throw new Error('MCP Server URL is required for MCP OAuth discovery.');
    const check = isAllowedConnectorUrl(mcpUrl);
    if (!check.ok) throw new Error(check.reason || 'Invalid MCP URL');

    const reg = await discoverMcpOAuthAndRegister({ mcpUrl, redirectUri: callbackUrl });
    const pkce = generatePkcePair();
    const state = signOAuthState({
      userId,
      mode: 'mcp_oauth',
      slug: `mcp_${(params.name || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28)}`,
      name: params.name?.trim() || new URL(mcpUrl).hostname,
      redirectUri: callbackUrl,
      codeVerifier: pkce.verifier,
      tokenUrl: reg.tokenEndpoint,
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      mcpUrl,
    });

    const authUrl = new URL(reg.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.clientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (reg.scopes.length > 0) {
      authUrl.searchParams.set('scope', reg.scopes.join(' '));
    }

    return { authUrl: authUrl.toString(), mode: 'mcp_oauth', callbackUrl };
  }

  const slug = (params.slug || '').trim();
  const def = getCatalogConnector(slug);
  if (!def) throw new Error(`Unknown connector: ${slug}`);

  // 2) Direct OAuth2 App credentials (provided inline or via server .env)
  const spec = OAUTH_PROVIDERS[slug];
  const envClient = getEnvOAuthClient(slug);
  const inlineClient =
    params.clientId?.trim() && params.clientSecret?.trim()
      ? { clientId: params.clientId.trim(), clientSecret: params.clientSecret.trim() }
      : null;
  const directCreds = inlineClient || (params.mode !== 'composio' ? envClient : null);

  if (spec && directCreds) {
    const pkce = spec.usePkce ? generatePkcePair() : null;
    const state = signOAuthState({
      userId,
      mode: 'direct_oauth',
      slug,
      name: params.name?.trim() || def.name,
      redirectUri: callbackUrl,
      domain: params.domain?.trim(),
      ...(pkce ? { codeVerifier: pkce.verifier } : {}),
      // Only include inline client credentials in signed state if supplied by user
      ...(inlineClient ? { clientId: inlineClient.clientId, clientSecret: inlineClient.clientSecret } : {}),
      basicAuth: spec.basicAuthTokenExchange,
    });

    const url = new URL(spec.authorizeUrl);
    url.searchParams.set('client_id', directCreds.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (spec.scopes.length > 0) {
      url.searchParams.set('scope', spec.scopes.join(spec.scopeSeparator || ' '));
    }
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (spec.extraAuthorizeParams) {
      for (const [k, v] of Object.entries(spec.extraAuthorizeParams)) {
        url.searchParams.set(k, v);
      }
    }

    return { authUrl: url.toString(), mode: 'direct_oauth', callbackUrl };
  }

  // 3) Unified Single-Key Composio OAuth Broker
  if (isComposioConfigured()) {
    const toolkitSlug = mapSlugToComposioToolkit(slug);
    const state = signOAuthState({
      userId,
      mode: 'composio',
      slug,
      name: params.name?.trim() || def.name,
      redirectUri: callbackUrl,
    });

    const callbackWithState = `${callbackUrl}?state=${encodeURIComponent(state)}`;
    const link = await createComposioConnectLink({
      userId,
      toolkitSlug,
      callbackUrl: callbackWithState,
    });

    return { authUrl: link.redirectUrl, mode: 'composio', callbackUrl };
  }

  const hint = spec
    ? `Add COMPOSIO_API_KEY (1 key for all 25+ connectors) OR add ${spec.envKeyHint} to .env / Secrets with callback URL ${callbackUrl}.`
    : `Add COMPOSIO_API_KEY to .env / Secrets to enable 1-click OAuth for ${def.name}, or connect using an API token.`;

  const err: any = new Error(hint);
  err.needsConfiguration = true;
  err.callbackUrl = callbackUrl;
  err.envKeyHint = spec?.envKeyHint || 'COMPOSIO_API_KEY';
  err.setupDocsUrl = spec?.setupDocsUrl || 'https://app.composio.dev';
  throw err;
}

export async function completeConnectorOAuth(rawQuery: Record<string, any>) {
  const query = { ...rawQuery };
  if (typeof query.state === 'string' && query.state.includes('?')) {
    const [cleanState, extraQs] = query.state.split('?', 2);
    query.state = cleanState;
    for (const [k, v] of new URLSearchParams(extraQs).entries()) {
      if (!query[k]) query[k] = v;
    }
  }

  if (query.error) {
    throw new Error(`Authorization denied: ${query.error_description || query.error}`);
  }

  const stateToken = String(query.state || '');
  const state = verifyOAuthState(stateToken);

  if (state.mode === 'composio') {
    const start = Date.now();
    const connectedAccountId = String(
      query.connectedAccountId || query.connected_account_id || ''
    ).trim();
    if (!connectedAccountId) {
      throw new Error('Composio callback did not include connectedAccountId.');
    }

    const check = await verifyComposioConnectedAccount(connectedAccountId);
    if (!check.ok) {
      throw new Error(check.message);
    }

    const def = getCatalogConnector(state.slug);
    const toolkitSlug = check.toolkitSlug || mapSlugToComposioToolkit(state.slug);
    const tools = await listComposioToolsForToolkit(toolkitSlug);
    const encryptedSecret = encryptSecret(JSON.stringify({ composioAccountId: connectedAccountId }));

    const created = await ConnectorModel.create({
      _id: crypto.randomUUID(),
      userId: state.userId,
      kind: 'composio_oauth',
      slug: state.slug,
      name: state.name || def?.name || state.slug,
      category: def?.category || 'Workspace',
      description: def?.description || `OAuth connection via Composio (${toolkitSlug})`,
      baseUrl: `composio://${toolkitSlug}`,
      healthPath: '',
      authType: 'oauth',
      authHeaderName: '',
      extraConfig: {
        composioAccountId: connectedAccountId,
        toolkitSlug,
        oauthProvider: 'composio',
      },
      encryptedSecret,
      secretHint: `oauth••••${connectedAccountId.slice(-4)}`,
      status: 'connected',
      lastTestedAt: new Date(),
      lastLatencyMs: Date.now() - start,
      lastTestMessage: `${check.message} · Discovered ${tools.length} tool(s).`,
      discoveredTools: tools,
      active: true,
    });

    return sanitizeConnectorDoc(created);
  }

  const code = String(query.code || '').trim();
  if (!code) {
    throw new Error('OAuth provider callback did not include an authorization code.');
  }

  if (state.mode === 'mcp_oauth') {
    if (!state.tokenUrl || !state.clientId || !state.mcpUrl) {
      throw new Error('Incomplete MCP OAuth state.');
    }
    const exchanged = await exchangeOAuthCode({
      tokenUrl: state.tokenUrl,
      code,
      redirectUri: state.redirectUri,
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      codeVerifier: state.codeVerifier,
    });

    const headers = buildMcpAuthHeaders({ authType: 'bearer', token: exchanged.accessToken });
    const mcpCheck = await testMcpServer({ url: state.mcpUrl, headers });
    if (!mcpCheck.ok) {
      throw new Error(`MCP OAuth connection check failed before saving: ${mcpCheck.message}`);
    }

    const encryptedSecret = encryptSecret(
      JSON.stringify({ token: exchanged.accessToken, refreshToken: exchanged.refreshToken || '' })
    );
    const created = await ConnectorModel.create({
      _id: crypto.randomUUID(),
      userId: state.userId,
      kind: 'mcp_server',
      slug: state.slug,
      name: state.name || 'MCP Server',
      category: 'MCP Server',
      description: `OAuth-verified MCP server (${state.mcpUrl})`,
      baseUrl: state.mcpUrl,
      healthPath: '',
      authType: 'bearer',
      authHeaderName: '',
      extraConfig: { oauthProvider: 'mcp_oauth' },
      encryptedSecret,
      secretHint: maskSecret(exchanged.accessToken),
      status: 'connected',
      lastTestedAt: new Date(),
      lastLatencyMs: mcpCheck.latencyMs,
      lastTestMessage: mcpCheck.message,
      discoveredTools: mcpCheck.tools,
      active: true,
    });

    return sanitizeConnectorDoc(created);
  }

  // direct_oauth
  const spec = OAUTH_PROVIDERS[state.slug];
  if (!spec) throw new Error(`Unsupported OAuth connector: ${state.slug}`);

  const envClient = getEnvOAuthClient(state.slug);
  const clientId = state.clientId || envClient?.clientId;
  const clientSecret = state.clientSecret || envClient?.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error(`Missing OAuth client credentials for ${state.slug}.`);
  }

  const exchanged = await exchangeOAuthCode({
    tokenUrl: spec.tokenUrl,
    code,
    redirectUri: state.redirectUri,
    clientId,
    clientSecret,
    codeVerifier: state.codeVerifier,
    basicAuth: spec.basicAuthTokenExchange,
  });

  // Special handling for Jira OAuth: resolve Atlassian cloudId if domain wasn't supplied
  let resolvedDomain = state.domain;
  if (state.slug === 'jira' && !resolvedDomain) {
    const sites = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${exchanged.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    if (Array.isArray(sites) && sites[0]?.id) {
      resolvedDomain = `api.atlassian.com/ex/jira/${sites[0].id}`;
    }
  }

  // Test live before saving to DB!
  const testRes = await testConnectorDraft(state.userId, {
    kind: 'catalog',
    slug: state.slug,
    name: state.name,
    token: exchanged.accessToken,
    domain: resolvedDomain,
  });
  if (!testRes.ok) {
    throw new Error(`OAuth token check failed before saving: ${testRes.message}`);
  }

  const def = getCatalogConnector(state.slug)!;
  const encryptedSecret = encryptSecret(
    JSON.stringify({ token: exchanged.accessToken, refreshToken: exchanged.refreshToken || '' })
  );

  const created = await ConnectorModel.create({
    _id: crypto.randomUUID(),
    userId: state.userId,
    kind: 'catalog',
    slug: def.slug,
    name: state.name || def.name,
    category: def.category,
    description: def.description,
    baseUrl: def.baseUrl.includes('{domain}') && resolvedDomain
      ? def.baseUrl.replace('{domain}', resolvedDomain)
      : def.baseUrl,
    healthPath: def.defaultTestPath,
    authType: 'bearer',
    authHeaderName: '',
    extraConfig: { domain: resolvedDomain || '', oauthProvider: 'direct_oauth' },
    encryptedSecret,
    secretHint: maskSecret(exchanged.accessToken),
    status: 'connected',
    lastTestedAt: new Date(),
    lastLatencyMs: testRes.latencyMs,
    lastTestMessage: testRes.message,
    discoveredTools: [],
    active: true,
  });

  return sanitizeConnectorDoc(created);
}

export { CONNECTOR_CATALOG };
