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

export function getSession(): string | null {
  // 1. Env var (highest priority — user-pasted from DevTools cURL)
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
  console.log('[session] Stored Akamai session cookies (valid ~8 min)');
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
