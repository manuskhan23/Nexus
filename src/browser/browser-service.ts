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

export function isPrivateIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) ||
        (b === 88 && c === 99) || (b === 168 && c === 0))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (kind !== 6) return false;

  const normalized = address.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return true;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    .map((group) => Number.parseInt(group || "0", 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return true;

  const first = groups[0]!;
  const allZeroPrefix = groups.slice(0, 6).every((group) => group === 0);
  if (allZeroPrefix) {
    if (groups[6] === 0 && groups[7] <= 1) return true;
    if (groups[5] === 0xffff) {
      const mapped = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
      return isPrivateIpAddress(mapped);
    }
    return true;
  }
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && groups[1] === 0x0db8) ||
    (first === 0x2001 && groups[1] === 0x0010);
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host)) return isPrivateIpAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    // Block the name if any answer is private. Resolve on every request to narrow DNS rebinding windows.
    return addresses.length === 0 || addresses.some(({ address }) => isPrivateIpAddress(address));
  } catch {
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
