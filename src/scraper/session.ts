import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

const SESSION_FILE = path.join(os.homedir(), '.amtracked', 'session.json');
// Conservative TTL — real expiry is ~10 min based on observations, use 8 min to be safe
const SESSION_TTL_MS = 8 * 60 * 1000;

interface StoredSession {
  cookies: string;
  capturedAt: number;
}

let memCache: StoredSession | null = null;

/**
 * Parse a full cURL command (as copied from Chrome DevTools "Copy as cURL") and
 * extract the cookie string. Handles both single and double quotes, multi-line
 * commands with backslash continuations, and both -b / --cookie flags.
 *
 * Returns null if no cookie flag is found.
 */
/**
 * Inspect the _abck cookie to determine the Akamai budget state.
 *
 * _abck format: {hash}~{budget}~{sensor_data}~{flags}
 *   budget = -1  → cookie was refreshed by Akamai's JS after human interaction.
 *                  High request allowance (effectively unlimited in practice).
 *   budget =  0  → initial cookie issued on first page load, no interaction proof.
 *                  Only ~4-5 API calls before Akamai starts blocking.
 *
 * Returns 'refreshed' | 'initial' | 'unknown'.
 */
export function abckBudgetState(cookieHeader: string): 'refreshed' | 'initial' | 'unknown' {
  const match = cookieHeader.match(/_abck=([^;]+)/);
  if (!match) return 'unknown';
  const parts = decodeURIComponent(match[1]).split('~');
  if (parts.length < 2) return 'unknown';
  return parts[1] === '-1' ? 'refreshed' : parts[1] === '0' ? 'initial' : 'unknown';
}

export function parseCurlCommand(curl: string): string | null {
  // Join continuation lines so we can match across line breaks
  const flat = curl.replace(/\\\s*\n\s*/g, ' ');
  // Match -b 'value' or --cookie 'value' (single or double quotes)
  const match =
    flat.match(/(?:-b|--cookie)\s+'((?:[^'\\]|\\.)*)'/) ??
    flat.match(/(?:-b|--cookie)\s+"((?:[^"\\]|\\.)*)"/);
  return match ? match[1] : null;
}

// Dedicated file for pasting a full cURL command — no escaping needed, just paste and save.
// Checked relative to cwd (project root) so it's always easy to find.
const CURL_FILE = path.join(process.cwd(), '.amtrak-curl');

export function getSession(): string | null {
  // 1. .amtrak-curl file in project root — paste the raw DevTools cURL command here,
  //    multiline and unmodified. Easiest option for humans.
  try {
    if (existsSync(CURL_FILE)) {
      const content = readFileSync(CURL_FILE, 'utf-8').trim();
      if (content) {
        const cookies = parseCurlCommand(content);
        if (cookies) return cookies;
        console.warn('[session] .amtrak-curl exists but no -b cookie flag found — check the file contents');
      }
    }
  } catch {}

  // 2. AMTRAK_CURL env var (single-line cURL command)
  const envCurl = process.env.AMTRAK_CURL?.trim();
  if (envCurl) {
    const cookies = parseCurlCommand(envCurl);
    if (cookies) return cookies;
    console.warn('[session] AMTRAK_CURL set but no -b cookie flag found in it');
  }

  // 3. AMTRAK_COOKIES env var (just the cookie string, no parsing needed)
  const envCookies = process.env.AMTRAK_COOKIES?.trim();
  if (envCookies) return envCookies;

  // 2. In-memory cache
  if (memCache && Date.now() - memCache.capturedAt < SESSION_TTL_MS) {
    return memCache.cookies;
  }
  memCache = null;

  // 3. File cache (survives process restarts)
  try {
    if (existsSync(SESSION_FILE)) {
      const stored: StoredSession = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() - stored.capturedAt < SESSION_TTL_MS) {
        memCache = stored;
        return stored.cookies;
      }
    }
  } catch {}

  return null;
}

export function setSession(cookies: string): void {
  const session: StoredSession = { cookies, capturedAt: Date.now() };
  memCache = session;
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(session));
  } catch {}
  const budget = abckBudgetState(cookies);
  if (budget === 'initial') {
    console.log('[session] Stored session cookies — _abck budget=0 (initial). Expect ~4-5 requests before Akamai blocks.');
    console.log('[session] For more requests: do a full search on amtrak.com (form submit), then re-copy the cURL.');
  } else if (budget === 'refreshed') {
    console.log('[session] Stored session cookies — _abck budget=-1 (refreshed). High request allowance.');
  } else {
    console.log('[session] Stored session cookies (budget state unknown).');
  }
}

export function clearSession(): void {
  memCache = null;
  try {
    if (existsSync(SESSION_FILE)) writeFileSync(SESSION_FILE, '{}');
  } catch {}
}

export function sessionAge(): number | null {
  const cookies = getSession();
  if (!cookies) return null;
  const source = memCache ?? (() => {
    try { return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as StoredSession; } catch { return null; }
  })();
  return source ? Math.round((Date.now() - source.capturedAt) / 1000) : null;
}
