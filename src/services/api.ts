import { getStoredRefreshToken, useAuthStore } from '../stores/authStore';

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    const refreshToken = getStoredRefreshToken();
    refreshInFlight = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        useAuthStore.getState().setSession(data.user, data.accessToken, data.refreshToken);
        return data.accessToken as string;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any
  ) {
    super(message);
  }
}

export async function apiRequest<T = any>(
  path: string,
  options: RequestInit = {},
  retryOnAuth = true
): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && retryOnAuth && !path.startsWith('/api/auth/')) {
    const nextToken = await refreshAccessToken();
    if (nextToken) {
      return apiRequest<T>(path, options, false);
    }
    useAuthStore.getState().clearSession();
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(json.error || `Request failed (${res.status})`, res.status, json);
  }

  return json as T;
}

export interface StreamHandlers {
  onEvent: (event: string, data: any) => void;
}

async function readSseStream(res: Response, handlers: StreamHandlers) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const lines = block.split('\n');
      let eventName = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr += line.slice(6);
      }
      if (dataStr) {
        try {
          handlers.onEvent(eventName, JSON.parse(dataStr));
        } catch {
          // Ignore malformed partial frame
        }
      }
    }
  }
}

export async function streamConversationTurn(
  conversationId: string,
  payload: { content: string; providerMode?: string; executionMode?: 'chat' | 'task' },
  signal: AbortSignal,
  handlers: StreamHandlers
): Promise<void> {
  let token = useAuthStore.getState().accessToken;
  const makeRequest = (authToken: string | null) =>
    fetch(`/api/conversations/${conversationId}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      credentials: 'include',
      signal,
      body: JSON.stringify(payload),
    });

  let res = await makeRequest(token);
  if (res.status === 401) {
    token = await refreshAccessToken();
    if (token) res = await makeRequest(token);
  }

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(errText || `Stream failed (${res.status})`);
  }

  await readSseStream(res, handlers);
}

export async function subscribeTaskStream(
  taskId: string,
  signal: AbortSignal,
  handlers: StreamHandlers
): Promise<void> {
  let token = useAuthStore.getState().accessToken;
  const makeRequest = (authToken: string | null) =>
    fetch(`/api/tasks/${taskId}/stream`, {
      method: 'GET',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      credentials: 'include',
      signal,
    });

  let res = await makeRequest(token);
  if (res.status === 401) {
    token = await refreshAccessToken();
    if (token) res = await makeRequest(token);
  }

  if (!res.ok || !res.body) return;
  await readSseStream(res, handlers);
}
