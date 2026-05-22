# Project State

## Status: Phase 1 Complete (Blocked on Akamai 403)

## Last Session (2026-05-22)

Built the full Phase 1 stack. Core blocker discovered and documented.

### What's Built
- **Playwright scraper** (`src/scraper/`): Full Amtrak.com form automation
  - Selects From/To stations from Angular ng-bootstrap comboboxes
  - Opens ng-bootstrap calendar date picker and selects target date
  - Triggers Angular form submission (fixes pointer-events: none on FIND TRAINS button)
  - Confirmed: Angular makes POST to `/dotcom/journey-solution-option`
- **Direct API client** (`src/scraper/api.ts`): Calls the endpoint from browser context
- **SQLite data layer** (`src/db/`): schema, client, typed query helpers
- **Express API** (`src/index.ts`, `src/api/`): /search, /snapshots, /routes, /alerts (stub)
- **playwright-extra + stealth plugin** applied

### Confirmed Search API
```
POST https://www.amtrak.com/dotcom/journey-solution-option
Content-Type: application/json
x-amtrak-trace-id: <uuid><timestamp-ms>

{
  "journeyRequest": {
    "fare": { "pricingUnit": "DOLLARS" },
    "type": "OW",
    "journeyLegRequests": [{
      "origin": { "code": "NYP", "schedule": { "departureDateTime": "2026-07-15T00:00:00" } },
      "destination": { "code": "WAS" },
      "passengers": [{ "id": "P1", "type": "F", "initialType": "adult" }]
    }],
    "customer": { "tierStatus": "MEMBER" },
    "isPassRider": false,
    "isCorporateTraveller": false,
    "tripTags": true,
    "singleAdultFare": true,
    "cascadesWSDOTFilter": false,
    "xDelay": "60"
  },
  "initialJourneyLegOnly": false,
  "reservableAccomodationOptions": "ALL"
}
```

### Core Blocker
- **Akamai Bot Manager returns HTTP 403** for `/dotcom/journey-solution-option`
- Headless Chromium: classic "Access Denied" Akamai block
- Headed Chromium (on Mac): Amtrak backend 403 (possible missing session state or CSRF)
- `sec-ch-ua` header fix applied, playwright-extra stealth plugin applied — still blocked
- Known bypass approaches to try: residential proxy, curl-impersonate for TLS fingerprinting

## What's Next

### Immediate: Fix the 403 (options in priority order)
1. **Residential proxy**: Route Playwright through a residential IP/proxy service (e.g. BrightData, Oxylabs). Akamai trusts residential IPs.
2. **curl-impersonate / fetch-h2**: Replicate Chrome's TLS fingerprint (JA3/JA4) from Node.js — bypasses Akamai at the protocol level.
3. **Puppeteer with real Chrome**: Use the user's actual Chrome binary (not Playwright's Chromium) in headed mode; the exact TLS/browser fingerprint matches what Akamai expects.
4. **CSRF token investigation**: Explore if `/libs/granite/csrf/token.json` returns a token when properly authenticated.

### After 403 fixed
- **Phase 2**: Filtering/sorting in API + minimal web UI (Vite+React or plain HTML)
- **Phase 3**: node-cron scheduler polling saved routes, saving snapshots
- **Phase 4**: Price alert logic (compare snapshot vs. threshold, notify via console/email)

## Key File Map
- `src/scraper/amtrak.ts` — Playwright form automation (Angular booking widget)
- `src/scraper/api.ts` — Direct API client (POST /dotcom/journey-solution-option)
- `src/scraper/browser.ts` — Chromium browser context with stealth settings
- `src/db/` — SQLite schema, client, typed queries
- `src/api/` — Express REST API
- `src/index.ts` — Server entrypoint (PORT=3000)
- `scripts/test-api.ts` — Quick API test (run with `npm run test:api`)
- `scripts/test-scraper.ts` — Full scraper test (run with `npm run test:scraper`)

## Running Locally
```bash
npm run dev          # start server on :3000
npm run test:api     # test direct API call
npm run test:scraper # test full form automation scraper
DEBUG_XHR=true npm run test:scraper  # with verbose XHR logging
```
