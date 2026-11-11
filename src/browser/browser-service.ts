import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const MAX_TEXT_CHARS = 12_000;
const MAX_SELECTOR_CHARS = 2_000;
const MAX_FILL_CHARS = 2_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5_000;

export interface BrowserSnapshot {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

interface BrowserSession {
  id: string;
  projectId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  allowedLocalOrigin: string | null;
  createdAt: string;
}

const sessions = new Map<string, BrowserSession>();
const privateHostCache = new Map<string, boolean>();

function isPrivateIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") ||
      normalized.startsWith("feb") || normalized.startsWith("::ffff:127.");
  }
  return false;
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (privateHostCache.has(host)) return privateHostCache.get(host)!;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    privateHostCache.set(host, true);
    return true;
  }
  if (isIP(host)) {
    const result = isPrivateIp(host);
    privateHostCache.set(host, result);
    return result;
  }
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    const result = addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address));
    privateHostCache.set(host, result);
    return result;
  } catch {
    privateHostCache.set(host, true);
    return true;
  }
}

export function validateBrowserUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("Browser URL must be at most 4096 characters");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a complete http or https URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Only credential-free http and https URLs are supported");
  }
  return url;
}

function sessionFor(projectId: string, sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session || session.projectId !== projectId) throw new Error("Browser session not found");
  return session;
}

export async function startBrowserSession(projectId: string): Promise<{ sessionId: string }> {
  if (!projectId || projectId.length > 64) throw new Error("Invalid project identifier");
  const existing = Array.from(sessions.values()).find((item) => item.projectId === projectId);
  if (existing) return { sessionId: existing.id };
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Executable") || message.includes("browserType.launch")) {
      throw new Error("Playwright Chromium is not installed. Run npm run install:browsers and retry.");
    }
    throw error;
  }
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true
    });
    const session: BrowserSession = {
      id: randomUUID(),
      projectId,
      browser,
      context,
      page: await context.newPage(),
      allowedLocalOrigin: null,
      createdAt: new Date().toISOString()
    };
    session.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    session.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await context.route("**/*", async (route) => {
      try {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
          await route.abort("blockedbyclient");
          return;
        }
        if (await isPrivateHost(requestUrl.hostname) && requestUrl.origin !== session.allowedLocalOrigin) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });
    session.page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    session.page.on("download", (download) => { void download.cancel().catch(() => undefined); });
    sessions.set(session.id, session);
    return { sessionId: session.id };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

export async function navigateBrowser(projectId: string, sessionId: string, rawUrl: string): Promise<BrowserSnapshot> {
  const session = sessionFor(projectId, sessionId);
  const url = validateBrowserUrl(rawUrl);
  session.allowedLocalOrigin = await isPrivateHost(url.hostname) ? url.origin : null;
  await session.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  return readBrowserSnapshot(projectId, sessionId);
}

export async function readBrowserSnapshot(projectId: string, sessionId: string): Promise<BrowserSnapshot> {
  const session = sessionFor(projectId, sessionId);
  const snapshot = await session.page.evaluate((maxChars) => {
    const value = document.body?.innerText ?? "";
    return {
      url: location.href,
      title: document.title.slice(0, 500),
      text: value.slice(0, maxChars),
      truncated: value.length > maxChars
    };
  }, MAX_TEXT_CHARS);
  return { sessionId, ...snapshot };
}

export async function clickBrowserElement(
  projectId: string,
  sessionId: string,
  selector: string
): Promise<BrowserSnapshot> {
  if (!selector || selector.length > MAX_SELECTOR_CHARS) throw new Error("A selector of at most 2000 characters is required");
  const session = sessionFor(projectId, sessionId);
  const target = session.page.locator(selector).first();
  if (await target.count() === 0) throw new Error("No element matched the selector");
  await target.click({ timeout: ACTION_TIMEOUT_MS });
  return readBrowserSnapshot(projectId, sessionId);
}

export async function fillBrowserElement(
  projectId: string,
  sessionId: string,
  selector: string,
  value: string
): Promise<BrowserSnapshot> {
  if (!selector || selector.length > MAX_SELECTOR_CHARS) throw new Error("A selector of at most 2000 characters is required");
  if (typeof value !== "string" || value.length > MAX_FILL_CHARS) throw new Error("Browser text must be at most 2000 characters");
  const session = sessionFor(projectId, sessionId);
  const target = session.page.locator(selector).first();
  if (await target.count() === 0) throw new Error("No element matched the selector");
  await target.fill(value, { timeout: ACTION_TIMEOUT_MS });
  return readBrowserSnapshot(projectId, sessionId);
}

export async function closeBrowserSession(projectId: string, sessionId: string): Promise<boolean> {
  const session = sessionFor(projectId, sessionId);
  sessions.delete(sessionId);
  await session.context.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
  return true;
}
