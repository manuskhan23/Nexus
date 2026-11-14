export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface McpTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  tools: McpToolSchema[];
}

export function isAllowedConnectorUrl(rawUrl: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, reason: 'URL must start with https:// or http://' };
    }
    const host = parsed.hostname.toLowerCase();
    // Always block cloud metadata IP range
    if (host.startsWith('169.254.') || host === 'metadata.google.internal') {
      return { ok: false, reason: 'Metadata endpoints are not allowed.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Invalid URL format.' };
  }
}

async function parseJsonRpcResponse(res: Response): Promise<any> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();

  if (contentType.includes('text/event-stream') || raw.includes('\ndata:') || raw.startsWith('data:')) {
    const lines = raw.split(/\r?\n/);
    const candidates: any[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const jsonPart = line.slice(5).trim();
        if (!jsonPart || jsonPart === '[DONE]') continue;
        try {
          candidates.push(JSON.parse(jsonPart));
        } catch {
          // Ignore non-JSON SSE heartbeat frames
        }
      }
    }
    const withResult = candidates.find((c) => c && ('result' in c || 'error' in c));
    if (withResult) return withResult;
    if (candidates.length > 0) return candidates[candidates.length - 1];
    throw new Error('MCP SSE stream did not contain a valid JSON-RPC payload.');
  }

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Unexpected non-JSON MCP response (${res.status}): ${raw.slice(0, 180)}`);
  }
}

async function rpcRequest(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  sessionId?: string | null
): Promise<{ json: any; sessionId: string | null }> {
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...headers,
  };
  if (sessionId) {
    reqHeaders['mcp-session-id'] = sessionId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  const nextSessionId = res.headers.get('mcp-session-id') || sessionId || null;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }

  if (res.status === 202 || res.status === 204) {
    return { json: null, sessionId: nextSessionId };
  }

  const json = await parseJsonRpcResponse(res);
  if (json?.error) {
    throw new Error(`MCP RPC Error (${json.error.code ?? 'unknown'}): ${json.error.message || 'Unknown error'}`);
  }
  return { json, sessionId: nextSessionId };
}

export function buildMcpAuthHeaders(params: {
  authType?: string;
  token?: string;
  authHeaderName?: string;
  customHeaders?: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = { ...(params.customHeaders || {}) };
  const token = params.token?.trim();
  if (token) {
    if (params.authType === 'api_key_header' && params.authHeaderName) {
      out[params.authHeaderName] = token;
    } else {
      out['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
  }
  return out;
}

export async function testMcpServer(params: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpTestResult> {
  const start = Date.now();
  const check = isAllowedConnectorUrl(params.url);
  if (!check.ok) {
    return { ok: false, latencyMs: 0, message: check.reason || 'Invalid MCP URL', tools: [] };
  }

  try {
    const init = await rpcRequest(params.url, params.headers || {}, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'NEXUS', version: '1.0.0' },
      },
    });

    const serverInfo = init.json?.result?.serverInfo;
    const protocolVersion = init.json?.result?.protocolVersion;

    // Best-effort initialized notification
    await rpcRequest(
      params.url,
      params.headers || {},
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      init.sessionId
    ).catch(() => undefined);

    const listed = await rpcRequest(
      params.url,
      params.headers || {},
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId
    );

    const tools: McpToolSchema[] = Array.isArray(listed.json?.result?.tools)
      ? listed.json.result.tools.map((t: any) => ({
          name: String(t.name),
          description: t.description ? String(t.description) : '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
        }))
      : [];

    const namePart = serverInfo?.name ? `${serverInfo.name}${serverInfo.version ? ' v' + serverInfo.version : ''}` : 'MCP Server';
    return {
      ok: true,
      latencyMs: Date.now() - start,
      serverInfo,
      protocolVersion,
      tools,
      message: `Connected to ${namePart} · Discovered ${tools.length} tool(s).`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : 'MCP handshake failed',
      tools: [],
    };
  }
}

export async function callMcpTool(params: {
  url: string;
  headers?: Record<string, string>;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<{ ok: boolean; data?: any; error?: string; latencyMs: number }> {
  const start = Date.now();
  const check = isAllowedConnectorUrl(params.url);
  if (!check.ok) {
    return { ok: false, error: check.reason, latencyMs: 0 };
  }

  try {
    const init = await rpcRequest(params.url, params.headers || {}, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'NEXUS', version: '1.0.0' },
      },
    });

    await rpcRequest(
      params.url,
      params.headers || {},
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      init.sessionId
    ).catch(() => undefined);

    const callRes = await rpcRequest(
      params.url,
      params.headers || {},
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: params.toolName, arguments: params.args || {} },
      },
      init.sessionId
    );

    const result = callRes.json?.result;
    if (result?.isError) {
      const errText = Array.isArray(result.content)
        ? result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : JSON.stringify(result);
      return { ok: false, error: errText, latencyMs: Date.now() - start };
    }

    return { ok: true, data: result, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'MCP tool call failed',
      latencyMs: Date.now() - start,
    };
  }
}
