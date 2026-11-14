import crypto from 'crypto';
import { env } from '../../config/env';

export interface OAuthProviderSpec {
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator?: string;
  usePkce?: boolean;
  basicAuthTokenExchange?: boolean;
  extraAuthorizeParams?: Record<string, string>;
  envKeyHint: string;
  setupDocsUrl: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  github: {
    slug: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'user:email', 'repo'],
    scopeSeparator: ' ',
    envKeyHint: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET',
    setupDocsUrl: 'https://github.com/settings/developers',
  },
  google_calendar: {
    slug: 'google_calendar',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    envKeyHint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    setupDocsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  gmail: {
    slug: 'gmail',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    envKeyHint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    setupDocsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  google_drive: {
    slug: 'google_drive',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    envKeyHint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    setupDocsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  google_sheets: {
    slug: 'google_sheets',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    envKeyHint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    setupDocsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  notion: {
    slug: 'notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    basicAuthTokenExchange: true,
    extraAuthorizeParams: { owner: 'user' },
    envKeyHint: 'NOTION_CLIENT_ID / NOTION_CLIENT_SECRET',
    setupDocsUrl: 'https://www.notion.so/profile/integrations',
  },
  slack: {
    slug: 'slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write', 'users:read'],
    scopeSeparator: ',',
    envKeyHint: 'SLACK_CLIENT_ID / SLACK_CLIENT_SECRET',
    setupDocsUrl: 'https://api.slack.com/apps',
  },
  linear: {
    slug: 'linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    scopeSeparator: ',',
    envKeyHint: 'LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET',
    setupDocsUrl: 'https://linear.app/settings/api',
  },
  jira: {
    slug: 'jira',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-user', 'read:jira-work', 'write:jira-work', 'offline_access'],
    extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    envKeyHint: 'ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET',
    setupDocsUrl: 'https://developer.atlassian.com/console/myapps/',
  },
  discord: {
    slug: 'discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scopes: ['identify', 'guilds'],
    envKeyHint: 'DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET',
    setupDocsUrl: 'https://discord.com/developers/applications',
  },
  asana: {
    slug: 'asana',
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scopes: ['default'],
    envKeyHint: 'ASANA_CLIENT_ID / ASANA_CLIENT_SECRET',
    setupDocsUrl: 'https://app.asana.com/0/my-apps',
  },
  airtable: {
    slug: 'airtable',
    authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
    tokenUrl: 'https://airtable.com/oauth2/v1/token',
    scopes: ['data.records:read', 'schema.bases:read'],
    usePkce: true,
    basicAuthTokenExchange: true,
    envKeyHint: 'AIRTABLE_CLIENT_ID / AIRTABLE_CLIENT_SECRET',
    setupDocsUrl: 'https://airtable.com/create/oauth',
  },
  figma: {
    slug: 'figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    scopes: ['file_read'],
    envKeyHint: 'FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET',
    setupDocsUrl: 'https://www.figma.com/developers/apps',
  },
  hubspot: {
    slug: 'hubspot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'],
    envKeyHint: 'HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET',
    setupDocsUrl: 'https://developers.hubspot.com/',
  },
  gitlab: {
    slug: 'gitlab',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    scopes: ['api', 'read_user'],
    envKeyHint: 'GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET',
    setupDocsUrl: 'https://gitlab.com/-/user_settings/applications',
  },
  bitbucket: {
    slug: 'bitbucket',
    authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
    tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
    scopes: ['account', 'repository'],
    envKeyHint: 'BITBUCKET_CLIENT_ID / BITBUCKET_CLIENT_SECRET',
    setupDocsUrl: 'https://bitbucket.org/',
  },
  dropbox: {
    slug: 'dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: [],
    extraAuthorizeParams: { token_access_type: 'offline' },
    envKeyHint: 'DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET',
    setupDocsUrl: 'https://www.dropbox.com/developers/apps',
  },
};

export function getEnvOAuthClient(slug: string): { clientId: string; clientSecret: string } | null {
  let entry: { clientId: string; clientSecret: string } | undefined;
  if (['google_calendar', 'gmail', 'google_drive', 'google_sheets'].includes(slug)) {
    entry = env.OAUTH_CLIENTS.google;
  } else {
    entry = (env.OAUTH_CLIENTS as Record<string, { clientId: string; clientSecret: string }>)[slug];
  }
  if (entry?.clientId && entry?.clientSecret) {
    return entry;
  }
  return null;
}

export function getConfiguredDirectOAuthSlugs(): string[] {
  return Object.keys(OAUTH_PROVIDERS).filter((slug) => Boolean(getEnvOAuthClient(slug)));
}

export function resolveCallbackUrl(clientOrigin?: string): string {
  if (env.APP_URL) {
    return `${env.APP_URL}/api/connectors/oauth/callback`;
  }
  if (clientOrigin && /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(clientOrigin)) {
    return `${clientOrigin}/api/connectors/oauth/callback`;
  }
  return `${env.CLIENT_URL.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
}

export interface SignedOAuthState {
  userId: string;
  mode: 'composio' | 'direct_oauth' | 'mcp_oauth';
  slug: string;
  name?: string;
  redirectUri: string;
  codeVerifier?: string;
  domain?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  basicAuth?: boolean;
  mcpUrl?: string;
  exp: number;
}

export function signOAuthState(payload: Omit<SignedOAuthState, 'exp'>): string {
  const full: SignedOAuthState = {
    ...payload,
    exp: Date.now() + 15 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyOAuthState(stateToken: string): SignedOAuthState {
  if (!stateToken || !stateToken.includes('.')) {
    throw new Error('Invalid OAuth state parameter.');
  }
  const [encoded, sig] = stateToken.split('.');
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(encoded).digest('base64url');
  if (sig !== expected) {
    throw new Error('OAuth state signature mismatch.');
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedOAuthState;
  if (!parsed.userId || !parsed.exp || Date.now() > parsed.exp) {
    throw new Error('OAuth session expired. Please try connecting again.');
  }
  return parsed;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function exchangeOAuthCode(params: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  basicAuth?: boolean;
}): Promise<{ accessToken: string; refreshToken?: string; raw: any }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  if (params.codeVerifier) {
    form.set('code_verifier', params.codeVerifier);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (params.basicAuth && params.clientSecret !== undefined) {
    headers['Authorization'] = `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64')}`;
  } else {
    form.set('client_id', params.clientId);
    if (params.clientSecret) {
      form.set('client_secret', params.clientSecret);
    }
  }

  const res = await fetch(params.tokenUrl, {
    method: 'POST',
    headers,
    body: form.toString(),
    signal: AbortSignal.timeout(12_000),
  });

  const text = await res.text().catch(() => '');
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }

  if (!res.ok || data?.error) {
    throw new Error(
      `OAuth token exchange failed: ${data?.error_description || data?.error || res.statusText}`
    );
  }

  const accessToken =
    data?.access_token ||
    data?.authed_user?.access_token ||
    '';

  if (!accessToken) {
    throw new Error('OAuth provider did not return an access_token.');
  }

  return {
    accessToken: String(accessToken),
    refreshToken: data?.refresh_token ? String(data.refresh_token) : undefined,
    raw: data,
  };
}

/**
 * MCP 2.1 OAuth Discovery (RFC 9728 + RFC 8414 + RFC 7591 Dynamic Client Registration)
 * Allows connecting OAuth-protected remote MCP servers (e.g. Notion MCP, Linear MCP) with zero static keys.
 */
export async function discoverMcpOAuthAndRegister(params: {
  mcpUrl: string;
  redirectUri: string;
}): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
}> {
  const parsed = new URL(params.mcpUrl);
  const origin = parsed.origin;

  let authServerUrl = origin;

  // Step 1: Probe MCP endpoint to see if it advertises resource_metadata in WWW-Authenticate
  const probe = await fetch(params.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'NEXUS', version: '1.0' } },
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (probe) {
    const wwwAuth = probe.headers.get('www-authenticate') || '';
    const match = wwwAuth.match(/resource_metadata="([^"]+)"/i);
    if (match?.[1]) {
      const rm = await fetch(match[1], { signal: AbortSignal.timeout(6_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (Array.isArray(rm?.authorization_servers) && rm.authorization_servers[0]) {
        authServerUrl = String(rm.authorization_servers[0]).replace(/\/+$/, '');
      }
    }
  }

  // Fallback check on /.well-known/oauth-protected-resource
  if (authServerUrl === origin) {
    const pr = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (Array.isArray(pr?.authorization_servers) && pr.authorization_servers[0]) {
      authServerUrl = String(pr.authorization_servers[0]).replace(/\/+$/, '');
    }
  }

  // Step 2: Fetch /.well-known/oauth-authorization-server
  const meta = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(6_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error(
      `This MCP server (${origin}) did not advertise MCP OAuth 2.1 discovery metadata (.well-known/oauth-authorization-server). Use Bearer/Header authentication or a Composio connector.`
    );
  }

  if (!meta.registration_endpoint) {
    throw new Error(
      `MCP OAuth server at ${authServerUrl} requires a pre-registered Client ID (Dynamic Client Registration not advertised). Enter Client ID & Secret manually.`
    );
  }

  // Step 3: Dynamic Client Registration (RFC 7591)
  const regRes = await fetch(String(meta.registration_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'NEXUS AI Agent',
      redirect_uris: [params.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  const regJson = await regRes.json().catch(() => null);
  if (!regRes.ok || !regJson?.client_id) {
    throw new Error(
      `Dynamic MCP client registration failed: ${regJson?.error_description || regJson?.error || regRes.status}`
    );
  }

  return {
    authorizationEndpoint: String(meta.authorization_endpoint),
    tokenEndpoint: String(meta.token_endpoint),
    clientId: String(regJson.client_id),
    clientSecret: regJson.client_secret ? String(regJson.client_secret) : undefined,
    scopes: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.slice(0, 8) : [],
  };
}
