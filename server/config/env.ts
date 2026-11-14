import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

function cleanEnv(value: string | undefined, fallback = ''): string {
  if (!value) return fallback;
  let cleaned = value.trim();
  while (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned || fallback;
}

function cleanAppUrl(value: string | undefined): string {
  const cleaned = cleanEnv(value);
  if (!cleaned || cleaned === 'MY_APP_URL') return '';
  return cleaned.replace(/\/+$/, '');
}

const fallbackJwtSecret = crypto.createHash('sha256').update(process.cwd() + ':nexus-jwt').digest('hex');
const fallbackRefreshSecret = crypto
  .createHash('sha256')
  .update(process.cwd() + ':nexus-refresh')
  .digest('hex');
const fallbackEncKey = crypto
  .createHash('sha256')
  .update(process.cwd() + ':nexus-token-enc')
  .digest('hex');

export const env = {
  NODE_ENV: (cleanEnv(process.env.NODE_ENV, 'development')) as 'development' | 'test' | 'production',
  // AI Studio reverse-proxy requires port 3000
  PORT: 3000,
  APP_URL: cleanAppUrl(process.env.APP_URL),
  CLIENT_URL: cleanEnv(process.env.CLIENT_URL, 'http://localhost:3000'),
  MONGODB_URI: cleanEnv(process.env.MONGODB_URI),
  MONGODB_VECTOR_INDEX: cleanEnv(process.env.MONGODB_VECTOR_INDEX, 'vector_index'),
  REDIS_URL: cleanEnv(process.env.REDIS_URL),
  JWT_SECRET:
    process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16
      ? process.env.JWT_SECRET
      : fallbackJwtSecret,
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.length >= 16
      ? process.env.JWT_REFRESH_SECRET
      : fallbackRefreshSecret,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '6h',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  TOKEN_ENCRYPTION_KEY:
    process.env.TOKEN_ENCRYPTION_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY)
      ? process.env.TOKEN_ENCRYPTION_KEY
      : fallbackEncKey,
  SMTP_HOST: cleanEnv(process.env.SMTP_HOST),
  SMTP_PORT: Number(cleanEnv(process.env.SMTP_PORT, '587')),
  SMTP_USER: cleanEnv(process.env.SMTP_USER),
  SMTP_PASS: cleanEnv(process.env.SMTP_PASS),
  SMTP_FROM: cleanEnv(process.env.SMTP_FROM, 'NEXUS Agent <noreply@nexus.local>'),
  GEMINI_API_KEY: cleanEnv(process.env.GEMINI_API_KEY),
  GROQ_API_KEY: cleanEnv(process.env.GROQ_API_KEY),
  DEFAULT_AI_PROVIDER: (cleanEnv(process.env.DEFAULT_AI_PROVIDER) === 'groq' ? 'groq' : 'gemini') as
    | 'gemini'
    | 'groq',
  AI_PROVIDER_MODE: (['automatic', 'gemini_only', 'groq_only'].includes(
    cleanEnv(process.env.AI_PROVIDER_MODE)
  )
    ? cleanEnv(process.env.AI_PROVIDER_MODE)
    : 'automatic') as 'automatic' | 'gemini_only' | 'groq_only',
  GEMINI_MODEL: cleanEnv(process.env.GEMINI_MODEL, 'gemini-4-hydrogen'),
  GROQ_MODEL: cleanEnv(process.env.GROQ_MODEL, 'qwen/qwen3.8-27b'),
  EMBEDDING_PROVIDER: cleanEnv(process.env.EMBEDDING_PROVIDER, 'gemini'),
  EMBEDDING_MODEL: cleanEnv(process.env.EMBEDDING_MODEL, 'gemini-embedding-2'),
  COMPOSIO_API_KEY: cleanEnv(process.env.COMPOSIO_API_KEY),
  OAUTH_CLIENTS: {
    github: { clientId: cleanEnv(process.env.GITHUB_CLIENT_ID), clientSecret: cleanEnv(process.env.GITHUB_CLIENT_SECRET) },
    google: { clientId: cleanEnv(process.env.GOOGLE_CLIENT_ID), clientSecret: cleanEnv(process.env.GOOGLE_CLIENT_SECRET) },
    notion: { clientId: cleanEnv(process.env.NOTION_CLIENT_ID), clientSecret: cleanEnv(process.env.NOTION_CLIENT_SECRET) },
    slack: { clientId: cleanEnv(process.env.SLACK_CLIENT_ID), clientSecret: cleanEnv(process.env.SLACK_CLIENT_SECRET) },
    linear: { clientId: cleanEnv(process.env.LINEAR_CLIENT_ID), clientSecret: cleanEnv(process.env.LINEAR_CLIENT_SECRET) },
    jira: { clientId: cleanEnv(process.env.ATLASSIAN_CLIENT_ID), clientSecret: cleanEnv(process.env.ATLASSIAN_CLIENT_SECRET) },
    discord: { clientId: cleanEnv(process.env.DISCORD_CLIENT_ID), clientSecret: cleanEnv(process.env.DISCORD_CLIENT_SECRET) },
    asana: { clientId: cleanEnv(process.env.ASANA_CLIENT_ID), clientSecret: cleanEnv(process.env.ASANA_CLIENT_SECRET) },
    airtable: { clientId: cleanEnv(process.env.AIRTABLE_CLIENT_ID), clientSecret: cleanEnv(process.env.AIRTABLE_CLIENT_SECRET) },
    figma: { clientId: cleanEnv(process.env.FIGMA_CLIENT_ID), clientSecret: cleanEnv(process.env.FIGMA_CLIENT_SECRET) },
    hubspot: { clientId: cleanEnv(process.env.HUBSPOT_CLIENT_ID), clientSecret: cleanEnv(process.env.HUBSPOT_CLIENT_SECRET) },
    gitlab: { clientId: cleanEnv(process.env.GITLAB_CLIENT_ID), clientSecret: cleanEnv(process.env.GITLAB_CLIENT_SECRET) },
    bitbucket: { clientId: cleanEnv(process.env.BITBUCKET_CLIENT_ID), clientSecret: cleanEnv(process.env.BITBUCKET_CLIENT_SECRET) },
    dropbox: { clientId: cleanEnv(process.env.DROPBOX_CLIENT_ID), clientSecret: cleanEnv(process.env.DROPBOX_CLIENT_SECRET) },
  },
};
