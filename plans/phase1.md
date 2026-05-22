# Plan: amtracked — Phase 1 (Data Access Layer)

## Context

Building a personal Amtrak fare tracker. The core value is **price data**: for a given route + date, get each available train along with its fare options (price per class, availability) so the user can decide when/whether to buy. Existing community tools (Amtraker, mgwalker, etc.) only cover real-time train tracking — none expose pricing. That gap is exactly what this project fills.

Amtrak has no public API for search/pricing. The only viable approach is browser automation via Playwright to intercept the internal XHR calls amtrak.com makes when performing a search — more robust than DOM parsing since internal API shapes change less often than UI layouts.

Phase 1 goal: reliably fetch a list of trains for a given origin → destination → date, **with all fare class prices and availability**, and store them queryably. Phases 2-4 (filtering UI, recurring jobs, price alerts) come after.

---

## Tech Stack

- **Runtime**: Node.js + TypeScript (unified stack for backend + future web UI)
- **Package manager**: npm
- **Scraping**: Playwright (intercept XHR network responses from amtrak.com)
- **DB**: SQLite via `better-sqlite3` (simple, local, no server)
- **API server**: Express + TypeScript
- **Scheduler** (stub for now): `node-cron`
- Real-time tracking APIs (Amtraker, GTFS-RT) are intentionally **out of scope** — they don't carry price data

---

## Architecture

```
src/
  scraper/
    browser.ts        # Playwright singleton, browser setup + stealth config
    amtrak.ts         # search() — navigates amtrak.com, intercepts XHR, returns structured results
  db/
    schema.ts         # SQLite table definitions (routes, price_snapshots, alerts)
    client.ts         # better-sqlite3 connection singleton
    queries.ts        # typed query helpers
  api/
    index.ts          # Express app setup
    routes/
      search.ts       # POST /search — trigger scrape, return results
      snapshots.ts    # GET /snapshots — historical prices for a route
      alerts.ts       # CRUD for tracked routes / price alerts (stub)
  scheduler/
    index.ts          # node-cron job stubs (not wired yet in Phase 1)
  types.ts            # shared TS types (Train, SearchParams, PriceSnapshot, etc.)
  index.ts            # entrypoint — starts Express
plans/
  phase1.md           # copy of this plan (persisted in repo)
```

---

## Core Types (TypeScript)

```typescript
// A single fare option on a train (Amtrak shows multiple per train)
interface FareOption {
  fare_class: string;      // "Coach", "Business", "First Class", "Roomette", "Bedroom"
  fare_type: string;       // "Saver", "Value", "Flexible" (Amtrak's price tiers)
  price_cents: number | null;  // null = sold out
  available: boolean;
}

// One train result from a search
interface Train {
  number: string;           // e.g. "175"
  name: string;             // e.g. "Northeast Regional"
  departs_at: string;       // ISO datetime
  arrives_at: string;       // ISO datetime
  duration_minutes: number;
  fares: FareOption[];
  cheapest_cents: number | null;  // min across available fares, for easy sorting/filtering
}

interface SearchResult {
  origin: string;           // station code e.g. "BOS"
  destination: string;
  travel_date: string;      // YYYY-MM-DD
  scraped_at: string;       // ISO datetime
  trains: Train[];
}
```

## Data Schema (SQLite)

```sql
-- saved routes the user wants to monitor
CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- each scrape for a route+date; trains column is JSON array of Train objects
-- min_price_cents denormalized for fast cheapest-fare queries without parsing JSON
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  travel_date TEXT NOT NULL,   -- YYYY-MM-DD
  scraped_at TEXT DEFAULT (datetime('now')),
  trains TEXT NOT NULL,        -- JSON: Train[]
  min_price_cents INTEGER      -- cheapest available fare across all trains in this snapshot
);

-- alert configurations (stubbed, wired in Phase 3)
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  route_id INTEGER REFERENCES routes(id),
  travel_date TEXT,            -- NULL = alert on any date
  max_price_cents INTEGER,
  notify_method TEXT DEFAULT 'console',
  active INTEGER DEFAULT 1
);
```

---

## Implementation Steps

### Commit 1 — Project scaffold
- `package.json`, `tsconfig.json`, `nodemon`/`ts-node` dev setup
- Directory structure as above
- `.env.example` with `PORT`, `DB_PATH`
- `.gitignore` additions: `node_modules/`, `*.db`, `.env`, `playwright-browsers/`
- Install deps: `playwright`, `express`, `better-sqlite3`, `node-cron`, `amtrak`, plus TS types

### Commit 2 — Playwright scraper (`src/scraper/`)
- `browser.ts`: launch Chromium with stealth headers (realistic user-agent, viewport, `navigator.webdriver` patch via `playwright-extra` + `puppeteer-extra-plugin-stealth` port, or manual header injection)
- `amtrak.ts`: 
  1. Navigate to `https://www.amtrak.com/`
  2. Register `page.on('response', ...)` listener to capture responses matching Amtrak's internal search XHR (identify exact URL pattern via DevTools inspection during development)
  3. Automate form: fill origin, destination, date, click search
  4. Await captured XHR response, parse JSON
  5. Return typed `Train[]` array (train number, departure, arrival, duration, fare classes + prices, seat availability flag)
- Standalone test script `scripts/test-scraper.ts` to run a single search and print results

### Commit 3 — SQLite data layer (`src/db/`)
- `client.ts`: open/create SQLite DB, run migrations on startup
- `schema.ts`: `CREATE TABLE IF NOT EXISTS` statements for all three tables
- `queries.ts`: `saveSnapshot()`, `getSnapshots(origin, dest, date?)`, `upsertRoute()`, `getRoutes()`

### Commit 4 — Express API (`src/api/`)
- `POST /search` body: `{ origin, destination, date, save?: boolean }` → triggers scraper, optionally saves snapshot, returns results
- `GET /snapshots?origin=BOS&destination=NYP&date=2025-06-01` → returns historical snapshots from DB
- `GET /routes` → list saved routes
- `POST /routes` + `DELETE /routes/:id` → manage saved routes
- Alerts CRUD endpoints stubbed (return 501)
- `GET /snapshots` also supports `?sort=price_asc` and `?max_price=5000` (cents) query params — price filtering is a first-class concern from day one
- `src/index.ts`: wire Express + DB init + startup log

### Commit 5 — Plans directory + state update
- Copy this plan to `plans/phase1.md` in the repo
- Update `PROJECT_STATE.md` with current status, what's built, what's next

---

## Amtrak XHR Endpoint Discovery (during Commit 2)

During scraper development, open Chrome DevTools → Network → XHR/Fetch while performing a search on amtrak.com. Look for a POST/GET request that returns train results. Common patterns seen in similar sites:
- Request to something like `/api/v1/train-search` or `/booking/trips`
- Headers will include cookies/session tokens set during page load — Playwright handles these automatically since we're running a real browser session

Intercept by matching on response URL containing a keyword (e.g. `"travel"`, `"trip"`, `"search"`) and content-type `application/json`. Log all XHR responses in a debug mode until the right one is identified, then narrow the filter.

The captured response must include fare pricing per train — verify this before declaring the scraper working. If the initial XHR response omits prices (some sites lazy-load them), a second request triggered by clicking into a train may be required; handle this in `amtrak.ts`.

---

## Verification

1. `npm run dev` starts the server on `$PORT` (default 3000)
2. `POST /search` with `{ "origin": "BOS", "destination": "NYP", "date": "2025-06-15" }` returns a JSON array of trains with prices
3. Second identical call with `save: true` persists a snapshot; `GET /snapshots` returns it
4. `scripts/test-scraper.ts` can be run directly: `npx ts-node scripts/test-scraper.ts`

---

## Future Phases (tracked in PROJECT_STATE.md)

- **Phase 2**: Filtering/sorting API params + a minimal web UI (plain HTML or Vite+React)
- **Phase 3**: `node-cron` scheduler polls saved routes on a configurable interval, saves snapshots
- **Phase 4**: Price alert logic — compare latest snapshot vs. threshold, send notification (macOS native notification / email via nodemailer as options)
- **Hosting upgrade**: Dockerfile + deploy to Hetzner/Fly.io when local is proven out
