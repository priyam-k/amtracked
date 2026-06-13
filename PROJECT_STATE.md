# Project State

## Status: Core Infrastructure Complete — Building Search UI

## Last Session (2026-06-12)

### What's Built

**Akamai bypass — session cookie approach**
- Copy full DevTools cURL from `amtrak.com` → paste into `.amtrak-curl` in project root
- `parseCurlCommand()` extracts the `-b '...'` cookie string; no manual editing needed
- Cookies are query-agnostic (same token works for any origin/destination)
- Empirically valid for 24h+ (detected via 403, not by TTL); `~-1~` in `_abck` = high allowance
- `src/scraper/session.ts` — priority order: `.amtrak-curl` → `AMTRAK_CURL` env → `AMTRAK_COOKIES` env → memory cache → `~/.amtracked/session.json`

**Direct HTTP search client**
- `src/scraper/session-client.ts` — `searchWithSession(cookies, params)` → `SearchResult`
- POST to `https://www.amtrak.com/dotcom/journey-solution-option` with real Chrome headers
- `AbortController` 15s timeout; detects 403 / Access Denied / 502 body to surface session expiry
- `src/scraper/amtrak.ts` — `searchTrains()` tries session first, falls back to Playwright if no session

**Playwright fallback**
- `src/scraper/browser.ts` — real Chrome binary, `~/.amtracked/chrome-profile` persistent context
- `page.route()` intercepts `journey-solution-option` before Angular navigates away
- After successful navigation: extracts cookies from browser context and calls `setSession()`

**Parser**
- `parseAmtrakResponse()` in `src/scraper/amtrak.ts` — correct path:
  `data.journeySolutionOption.journeyLegs[0].journeyLegOptions[]`
- Exported and shared by both `amtrak.ts` and `session-client.ts`

**Data layer** (`src/db/`)
- SQLite via `better-sqlite3`; schema: `price_snapshots`, `routes`, `alerts`
- `saveSnapshot()`, `getSnapshots()`, `getLatestSnapshot()`
- `createAlert()`, `getAlerts()`, `getActiveAlerts()`, `deleteAlert()`

**REST API** (`src/api/`)
- `POST /search` — trigger single-route search, optionally save snapshot
- `GET /snapshots` — query snapshot history with filters (route, date, max price, sort)
- `GET/POST/DELETE /routes` — saved routes CRUD
- `GET/POST/DELETE /alerts` — price alert CRUD

**Scheduler** (`src/scheduler/index.ts`)
- `node-cron` polling every `POLL_INTERVAL_MINUTES` (default 60)
- Per-alert: searches, saves snapshot, checks price threshold
- macOS `osascript` notification when price drops below threshold
- Halts and clears session on 403

### What's Next

**Immediate (this session):**
1. Weekend round-trip search endpoint (`POST /weekend-roundtrip`) — check WAS↔TRE across
   multiple upcoming Fridays/Sundays with time-of-day filters
2. Light web UI (`public/index.html`) — served from Express, 3 tabs:
   - Weekend round-trip form + results
   - Single search
   - Snapshot history browser

**Later:**
- Natural language search ("cheapest WAS-TRE this month")
- Check if good WAS-TRE trains stop at NCR or PJC (better intermediate stops)
- Chrome extension to auto-refresh session from any amtrak.com browser search

## Key File Map

```
src/
  scraper/
    amtrak.ts          — searchTrains() with session-first + Playwright fallback
    session.ts         — cookie load/store (parseCurlCommand, getSession, setSession)
    session-client.ts  — searchWithSession() — direct HTTP, no Playwright
    browser.ts         — Playwright persistent Chrome context
    api.ts             — (legacy direct API client, superseded by session-client.ts)
  db/
    schema.ts          — SQLite DDL
    client.ts          — getDb() singleton
    queries.ts         — all typed query helpers
  api/
    index.ts           — createApp() — Express setup
    routes/
      search.ts        — POST /search
      snapshots.ts     — GET /snapshots
      routes.ts        — /routes CRUD
      alerts.ts        — /alerts CRUD
      weekend.ts       — POST /weekend-roundtrip  (TODO)
  scheduler/index.ts   — cron polling + threshold alerts
  types.ts             — shared TypeScript interfaces
  index.ts             — server entrypoint
scripts/
  test-session.ts      — fires 3 queries to validate session cookies
  test-scraper.ts      — full Playwright form test
  test-api.ts          — direct API test
public/
  index.html           — web UI (TODO)
```

## Running Locally

```bash
npm run dev                     # start server on :3000 (auto-restart via nodemon)
npm run test:session            # validate .amtrak-curl works, fires 3 searches
npm run test:scraper            # full Playwright automation test
DEBUG_XHR=true npm run test:scraper  # verbose XHR logging
```

## Session Refresh

When searches start returning 403:
1. Go to `amtrak.com` in Chrome
2. Do any search
3. DevTools → Network → `journey-solution-option` → right-click → Copy as cURL
4. Paste (replacing contents) into `.amtrak-curl` in project root
5. Done — next search picks it up automatically
