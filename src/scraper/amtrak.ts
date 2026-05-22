import { Page, Response } from 'playwright';
import { getBrowserContext } from './browser';
import { FareOption, SearchParams, SearchResult, Train } from '../types';

const DEBUG_XHR = process.env.DEBUG_XHR === 'true';

const SKIP_DOMAINS = [
  'demdex.net', 'omtrdc.net', 'pinterest.com', 'linkedin.com', 'doubleclick.net',
  'google-analytics.com', 'googletagmanager.com', 'facebook.com', 'twitter.com',
  'segment.io', 'segment.com', 'hotjar.com', 'newrelic.com', 'nr-data.net',
  'adobedtm.com', 'smetrics.amtrak.com', 'flashtalking.com', 'cognitivlabs.com',
  'nuance.com', 't.co',
];

// Known static service endpoints to EXCLUDE (not search results)
const STATIC_SERVICE_EXCLUDE = [
  'data.stations.json', 'data.popularstations.json', 'stationsinfo.json',
  'routes-list.json', 'staticmappingjson', 'globalerrorjson',
  'wsdot-stations-api', 'terms-and-conditions', 'emergency-alerts',
  'TrainCodesResource',
];

// Patterns that likely correspond to Amtrak's search/pricing API
// Discovered through XHR inspection — add to this list as endpoints are found
// Confirmed Amtrak search API endpoint (discovered by capturing Angular's POST request):
//   POST https://www.amtrak.com/dotcom/journey-solution-option
const SEARCH_PATTERNS = [
  '/dotcom/journey-solution-option',  // ← confirmed search API
  '/travel-service/', '/amtrak/trips', '/booking/search',
  'faredata', 'train-results', 'trip-results', 'fare-results',
];

function isAnalytics(url: string): boolean {
  return SKIP_DOMAINS.some((d) => url.includes(d));
}

function isStaticService(url: string): boolean {
  return STATIC_SERVICE_EXCLUDE.some((ex) => url.includes(ex));
}

function looksLikeSearch(url: string, body: unknown): boolean {
  if (isAnalytics(url) || isStaticService(url)) return false;
  const lower = url.toLowerCase();
  if (SEARCH_PATTERNS.some((p) => lower.includes(p))) return true;
  // Capture non-static amtrak.com JSON that has train/trip-related top-level keys
  if (lower.includes('amtrak.com') && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const keys = Object.keys(body as Record<string, unknown>);
    return keys.some((k) =>
      ['train', 'trip', 'fare', 'departure', 'schedule', 'segment', 'result'].some((kw) =>
        k.toLowerCase().includes(kw)
      )
    );
  }
  return false;
}

// Format YYYY-MM-DD date for Amtrak's calendar picker
function parseDate(dateStr: string): { month: number; day: number; year: number } {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

async function dismissCookieBanner(page: Page): Promise<void> {
  // Cookie consent is pre-suppressed via cookies set in browser.ts.
  // If the banner still appears (e.g., cookie not recognized), remove it via JS.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#onetrust-consent-sdk')?.remove();
    document.querySelector<HTMLElement>('.onetrust-pc-dark-filter')?.remove();
    document.querySelector<HTMLElement>('#onetrust-banner-sdk')?.remove();
  });
  await page.waitForTimeout(300);
}

// Booking widget selectors:
//   From: input[aria-label="From"]  (NOT the Train Status "departure station" input)
//   To:   input[aria-label="To"]
//   Autocomplete options are pre-loaded in DOM as div[role="option"] inside the listbox.
//   The listbox is hidden by "ads-hidden" class and shown on focus/click by Angular.
async function fillStation(page: Page, fieldLabel: 'From' | 'To', stationCode: string): Promise<void> {
  const inputLocator = page.locator(`input[aria-label="${fieldLabel}"]`).first();
  await inputLocator.waitFor({ state: 'visible', timeout: 15000 });

  // Click/focus the input
  await inputLocator.focus();
  await page.waitForTimeout(300);
  await inputLocator.click({ timeout: 5000 }).catch(() =>
    inputLocator.click({ force: true, timeout: 3000 }).catch(() => {})
  );
  await page.waitForTimeout(800);

  // Force-show the listbox BEFORE typing — pre-loaded options are visible at this point
  await page.evaluate((label) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    const container = input?.closest<HTMLElement>('am-form-field-new');
    const listbox = container?.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) {
      listbox.classList.remove('ads-hidden');
      listbox.style.display = 'block';
    }
    container?.setAttribute('aria-expanded', 'true');
    input?.setAttribute('aria-expanded', 'true');
  }, fieldLabel);

  await page.waitForTimeout(300);

  // Try to click the matching pre-loaded option BEFORE typing
  // Scope selector to this field's container to avoid clicking the other field's dropdown
  const containerSelector = `am-form-field-new:has(input[aria-label="${fieldLabel}"])`;
  const codeRegex = new RegExp(`\\(${stationCode}\\)`);
  const preloadedMatch = page.locator(`${containerSelector} div[role="option"]`).filter({ hasText: codeRegex }).first();

  if (await preloadedMatch.isVisible({ timeout: 1500 }).catch(() => false)) {
    const txt = await preloadedMatch.textContent().catch(() => '');
    await preloadedMatch.click({ timeout: 5000 });
    console.log(`[scraper] Selected pre-loaded: "${txt?.trim().slice(0, 70)}"`);
    await page.keyboard.press('Tab'); // Tab closes dropdown and moves to next field
    await page.waitForTimeout(600);
    return;
  }

  // Pre-loaded option not found.
  // Strategy: press ArrowDown (opens dropdown with Angular's internal state set to expanded),
  // then use JS to click the matching option (Playwright visibility check often fails for
  // absolutely-positioned dropdowns but JS click works when Angular state is correct).
  console.log(`[scraper] Pre-loaded "${stationCode}" not in list; using ArrowDown+JS-click...`);

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(2000); // let Angular render the open dropdown

  if (DEBUG_XHR) {
    const { writeFileSync } = await import('fs');
    writeFileSync(`/tmp/amtrak-dropdown-${fieldLabel}.png`, await page.screenshot());
  }

  // Use JS to find and click the matching option, scoped to THIS field's container
  const jsClicked = await page.evaluate(
    ({ label, code }) => {
      const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      const container = input?.closest<HTMLElement>('am-form-field-new');
      if (!container) return null;

      const options = Array.from(container.querySelectorAll<HTMLElement>('div[role="option"]'));
      const match = options.find((o) => o.textContent?.includes(`(${code})`));
      if (match) {
        match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        match.click();
        return match.textContent?.trim().slice(0, 70) ?? null;
      }
      const first = options[0];
      if (first) {
        first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        first.click();
        return `FIRST: ${first.textContent?.trim().slice(0, 70)}`;
      }
      return null;
    },
    { label: fieldLabel, code: stationCode }
  );

  if (jsClicked) {
    console.log(`[scraper] JS-clicked: "${jsClicked}"`);
  } else {
    console.warn(`[scraper] No options found via JS for ${stationCode}, pressing Enter`);
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(400);

  // Close the dropdown: Tab moves focus out and closes Angular dropdown
  await page.keyboard.press('Tab');
  await page.waitForTimeout(600);
}

async function setDate(page: Page, dateStr: string): Promise<void> {
  const { month, day, year } = parseDate(dateStr);
  // Amtrak's booking widget expects MM/DD/YYYY format
  const formatted = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;

  // Close any open dropdown first (bottom-left corner, far from all form elements)
  await page.mouse.click(10, 800);
  await page.waitForTimeout(500);

  // The Depart Date container is at ~(833-975, 165-221) in the booking form.
  // Use elementFromPoint to find the exact clickable element dynamically.
  const dateClickInfo = await page.evaluate(() => {
    // Probe coordinates in the depart date area (between To field and Return Date button)
    // Known layout: To ends at ~x=770, Depart container center ~x=904, y=193 (form center)
    for (const [x, y] of [[904, 193], [870, 189], [860, 185], [840, 193], [870, 193]]) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.classList.contains('departs-container')) {
        const rect = el.getBoundingClientRect();
        return { x, y, tag: el.tagName, cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
      }
      if (el?.classList.contains('departs-container')) {
        const rect = el.getBoundingClientRect();
        return { x, y, tag: el.tagName, cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
      }
    }
    return null;
  });

  // Use elementFromPoint to find the exact click target dynamically after stations are set
  const clickTarget = await page.evaluate(() => {
    // Scan the Depart Date area: x=830-975, y=165-225 (known from page layout)
    for (let x = 835; x <= 975; x += 20) {
      for (let y = 168; y <= 220; y += 8) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        const tag = el.tagName;
        const cls = el.className || '';
        if (cls.includes('departed-picker') || cls.includes('departs-container') || tag === 'LABEL') {
          const rect = el.getBoundingClientRect();
          // Click at the center of the departed-picker input if found
          if (cls.includes('departed-picker') && rect.width > 0) {
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), found: cls };
          }
          if (cls.includes('departs-container') && rect.width > 0) {
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), found: cls };
          }
        }
      }
    }
    return { x: 960, y: 193, found: 'fallback' };
  });

  console.log(`[scraper] Clicking date at (${clickTarget.x}, ${clickTarget.y}): ${clickTarget.found}`);
  await page.mouse.click(clickTarget.x, clickTarget.y);
  await page.waitForTimeout(800);

  // Amtrak uses ng-bootstrap datepicker (ngb-datepicker), NOT ngx-bootstrap
  // Check for the calendar container using ng-bootstrap selectors
  const calendarVisible = await page.locator('ngb-datepicker, [class*="ngb-dp"]').first().isVisible({ timeout: 5000 }).catch(() => false);

  const dateInput = page.locator('input.departed-picker, input[aria-label*="Departure Date"]').first();
  const preVal = await dateInput.inputValue().catch(() => '');
  console.log(`[scraper] Date input: "${preVal}", calendar (ngb): ${calendarVisible}`);

  if (calendarVisible) {
    console.log('[scraper] ng-bootstrap calendar open, navigating to target date...');
    const targetMonthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });

    // ng-bootstrap calendar navigation
    for (let i = 0; i < 24; i++) {
      // Month headers: div.ngb-dp-month-name or ngb-datepicker-month text
      const headers = await page.locator('ngb-datepicker .ngb-dp-month-name, ngb-datepicker-month .ngb-dp-month-name').allTextContents().catch(() => [] as string[]);
      const found = headers.some((h) => h.includes(targetMonthName) && h.includes(String(year)));
      if (found) { console.log(`[scraper] Found ${targetMonthName} ${year}`); break; }

      // Determine direction
      const firstHeader = (headers[0] ?? '').trim();
      const parts = firstHeader.split(' ');
      const fyNum = parseInt(parts[parts.length - 1] ?? '0');
      const fmNum = new Date(`${parts.slice(0, -1).join(' ')} 1 2000`).getMonth() + 1;

      const goBack = fyNum > year || (fyNum === year && fmNum > month);
      if (goBack) {
        await page.locator('ngb-datepicker button[aria-label*="Previous"], ngb-datepicker .ngb-dp-arrow:first-child button').first().click({ timeout: 2000 }).catch(() => {});
      } else {
        await page.locator('ngb-datepicker button[aria-label*="Next"], ngb-datepicker .ngb-dp-arrow:last-child button').first().click({ timeout: 2000 }).catch(() => {});
      }
      await page.waitForTimeout(350);
    }

    // Click the target day — ng-bootstrap uses div.ngb-dp-day[tabindex] > button or aria-label with full date
    const dayClicked = await page.evaluate(({ d, m, y }) => {
      // Try aria-label format: "Monday, July 15, 2026"
      const targetDate = new Date(y, m - 1, d);
      const ariaLabel = targetDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const byAria = document.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`);
      if (byAria) { byAria.click(); return `aria: ${ariaLabel}`; }

      // Fallback: find button with day number inside ngb-dp-day (not in other-month)
      const days = Array.from(document.querySelectorAll<HTMLElement>('ngb-datepicker .ngb-dp-day:not(.disabled) button'));
      const match = days.find((btn) => btn.textContent?.trim() === String(d));
      if (match) { match.click(); return `button text: ${d}`; }

      return null;
    }, { d: day, m: month, y: year });

    if (dayClicked) {
      console.log(`[scraper] Date selected: ${dayClicked}`);
      // Wait for calendar to auto-close after date selection
      await page.waitForTimeout(600);
      // If calendar is still open, close it by pressing Escape
      const stillOpen = await page.locator('ngb-datepicker, [class*="ngb-dp"]').first().isVisible({ timeout: 500 }).catch(() => false);
      if (stillOpen) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    } else {
      console.warn(`[scraper] Could not click day ${day} in calendar`);
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(300);
  } else {
    console.warn('[scraper] Calendar did not open');
  }

  // Verify the date input now has a value
  const finalVal = await dateInput.inputValue().catch(() => '');
  console.log(`[scraper] Final date value: "${finalVal}"`);
  await page.waitForTimeout(200);
}

async function captureXHRResponses(
  page: Page
): Promise<Array<{ url: string; body: unknown }>> {
  const captured: Array<{ url: string; body: unknown }> = [];

  page.on('response', async (res: Response) => {
    const url = res.url();
    if (isAnalytics(url)) return;
    const status = res.status();

    // Log blocked requests (403 = Akamai blocking our search API call)
    if (url.includes('amtrak.com') && !url.includes('xSRxOGcc') && (status === 403 || status >= 500)) {
      console.log(`[scraper] HTTP ${status}: ${url.slice(0, 120)}`);
    }

    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('application/json') && !ct.includes('text/json')) return;

    try {
      const body = await res.json();
      if (DEBUG_XHR) {
        console.log('[xhr]', url);
        console.log('     ', JSON.stringify(body).slice(0, 400));
      }
      if (looksLikeSearch(url, body)) {
        captured.push({ url, body });
      }
    } catch {}
  });

  return captured;
}

export async function searchTrains(params: SearchParams): Promise<SearchResult> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  const captured = await captureXHRResponses(page);

  // Log browser console messages (Angular errors/warnings)
  if (DEBUG_XHR) {
    page.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('Download the React') && !txt.includes('[Deprecation]')) {
        console.log(`[browser-${msg.type()}]`, txt.slice(0, 200));
      }
    });
  }

  // Capture request details for the search API endpoint
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/dotcom/') || url.includes('/journey-solution')) {
      console.log(`[search-req] ${req.method()} ${url}`);
      const body = req.postData();
      if (body) console.log(`[search-req-body] ${body.slice(0, 500)}`);
      const headers = req.headers();
      const relevantHeaders = Object.entries(headers).filter(([k]) => !['cookie', 'sec-fetch'].some(s => k.includes(s)));
      console.log(`[search-req-headers]`, JSON.stringify(Object.fromEntries(relevantHeaders)).slice(0, 400));
    }
  });

  try {
    console.log('[scraper] Loading Amtrak homepage...');
    await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);

    // Wait for the booking widget's From input to be visible (not the Train Status one)
    await page.waitForSelector('input[aria-label="From"]', {
      state: 'visible',
      timeout: 20000,
    });
    await page.waitForTimeout(500);

    console.log(`[scraper] Filling: ${params.origin} → ${params.destination} on ${params.travel_date}`);

    await fillStation(page, 'From', params.origin);
    if (DEBUG_XHR) {
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/amtrak-step1-origin.png', await page.screenshot());
      console.log('[scraper] Step 1 (after origin fill) screenshot saved');
    }

    await fillStation(page, 'To', params.destination);
    if (DEBUG_XHR) {
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/amtrak-step2-dest.png', await page.screenshot());
      console.log('[scraper] Step 2 (after dest fill) screenshot saved');
    }

    await setDate(page, params.travel_date);
    if (DEBUG_XHR) {
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/amtrak-step3-date.png', await page.screenshot());
      console.log('[scraper] Step 3 (after date set) screenshot saved');
    }

    // Wait a moment before clicking search
    await page.waitForTimeout(500);

    const urlBefore = page.url();

    // Check form validity before clicking FIND TRAINS
    const btnState = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="FIND TRAINS"]');
      return { ariaDisabled: btn?.getAttribute('aria-disabled'), classes: btn?.className.slice(0, 60) };
    });
    console.log('[scraper] FIND TRAINS button state:', JSON.stringify(btnState));

    // Multiple approaches to trigger search
    // 1. Playwright native click on all FIND TRAINS buttons (there may be 2)
    const allFindTrainsBtns = page.locator('button[aria-label="FIND TRAINS"]');
    const btnCount = await allFindTrainsBtns.count();
    console.log(`[scraper] Found ${btnCount} FIND TRAINS button(s)`);

    // Hook into history API AND hashchange to capture Angular router navigation
    await page.evaluate(() => {
      (window as any)._amtrakNavUrls = [];
      const orig = history.pushState.bind(history);
      history.pushState = (s: any, t: string, u: string) => {
        (window as any)._amtrakNavUrls.push('push:' + u);
        return orig(s, t, u);
      };
      const origR = history.replaceState.bind(history);
      history.replaceState = (s: any, t: string, u: string) => {
        (window as any)._amtrakNavUrls.push('replace:' + u);
        return origR(s, t, u);
      };
      window.addEventListener('hashchange', (e: HashChangeEvent) => {
        (window as any)._amtrakNavUrls.push('hash:' + e.newURL);
      });
    });

    // Root cause: FIND TRAINS has pointer-events:none when aria-disabled is set.
    // Fix: remove pointer-events restriction and aria-disabled, then click.
    const btnFixed = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="FIND TRAINS"]'));
      let fixed = 0;
      for (const btn of btns) {
        btn.style.setProperty('pointer-events', 'auto', 'important');
        btn.style.setProperty('opacity', '1', 'important');
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('disabled');
        fixed++;
      }
      return fixed;
    });
    console.log(`[scraper] Fixed pointer-events on ${btnFixed} FIND TRAINS button(s)`);

    // Verify the fix worked
    const afterFix = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="FIND TRAINS"]');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        pointerEventsNow: getComputedStyle(btn).pointerEvents,
        topElTag: top?.tagName,
        topElAria: top?.getAttribute('aria-label'),
        sameAsBtn: top === btn,
      };
    });
    console.log('[scraper] After fix:', JSON.stringify(afterFix));

    // Now click — pointer-events is restored so click reaches the button
    for (let i = 0; i < btnCount; i++) {
      const btn = allFindTrainsBtns.nth(i);
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.width > 0) {
        console.log(`[scraper] FIND TRAINS #${i} at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(2000);

        const newUrl = page.url();
        const anyNewXhr = captured.length > 0;
        if (newUrl !== urlBefore || anyNewXhr) {
          console.log('[scraper] Search triggered after button', i);
          break;
        }
      }
    }

    // Check what URL Angular navigated to (pushState + hashchange)
    const navUrls = await page.evaluate(() => (window as any)._amtrakNavUrls ?? []);
    console.log('[scraper] Angular nav history:', navUrls.length ? navUrls.join(' | ') : '(none)');

    // Log ALL amtrak.com requests made after clicking (if any missed in JSON filter)
    if (DEBUG_XHR) {
      const allRequests: string[] = [];
      page.on('request', (req) => {
        if (req.url().includes('amtrak.com') && !req.url().includes('xSRxOGcc')) {
          allRequests.push(req.method() + ' ' + req.url().slice(0, 100));
        }
      });
      await page.waitForTimeout(3000);
      if (allRequests.length > 0) console.log('[scraper] Requests after click:', allRequests.join('\n'));
    }

    if (captured.length === 0) {
      await page.keyboard.press('Enter');
      console.log('[scraper] Also pressed Enter as fallback');
    }

    console.log('[scraper] Search submitted, waiting for results...');

    // Wait for search results — try multiple signals:
    // 1. Full page navigation
    // 2. Angular SPA URL change
    // 3. Train-related content appearing in DOM
    // 4. Any JSON XHR response captured
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => null),
      page.waitForURL((url) => url.toString() !== urlBefore, { timeout: 30000 }).catch(() => null),
      page.waitForSelector(
        '[class*="train"], [class*="result"], [class*="fare"], [class*="departure"], [class*="itinerary"]',
        { timeout: 30000 }
      ).catch(() => null),
      page.waitForTimeout(30000),
    ]);
    console.log('[scraper] Current URL:', page.url());

    // Check page text for train-related content
    const resultText = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log('[scraper] Page text after search:', resultText.slice(0, 100));

    // Give the results page time to load XHR data
    await Promise.race([
      page.waitForTimeout(20000),
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (captured.length > 0) { clearInterval(check); resolve(); }
        }, 500);
      }),
    ]);

    if (DEBUG_XHR) {
      // Save screenshot to help diagnose what the page looks like after search
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/amtrak-after-search.png', await page.screenshot({ fullPage: true }));
      console.log('[scraper] Screenshot saved: /tmp/amtrak-after-search.png');
      console.log('[scraper] Page URL after search:', page.url());
    }

    if (captured.length === 0) {
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.warn('[scraper] No search API response captured. Page text:', text.slice(0, 300));
    }

    const best = captured.at(-1);
    const trains = best ? parseTrains(best.body) : [];

    return {
      origin: params.origin,
      destination: params.destination,
      travel_date: params.travel_date,
      scraped_at: new Date().toISOString(),
      trains,
    };
  } finally {
    await page.close();
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseTrains(raw: unknown): Train[] {
  if (!raw || typeof raw !== 'object') return [];

  const obj = raw as Record<string, unknown>;
  const candidates: unknown[] =
    (obj.trainData as unknown[]) ??
    (obj.trips as unknown[]) ??
    (obj.results as unknown[]) ??
    (obj.trains as unknown[]) ??
    (obj.segments as unknown[]) ??
    (Array.isArray(raw) ? (raw as unknown[]) : []);

  if (candidates.length === 0) {
    if (DEBUG_XHR) {
      console.warn('[parse] No train array found. Top-level keys:', Object.keys(obj));
    }
    return [];
  }

  return candidates.map((t) => parseTrain(t as Record<string, unknown>));
}

function parseTrain(t: Record<string, unknown>): Train {
  const fares = parseFares(t);
  const cheapest = fares
    .filter((f) => f.available && f.price_cents !== null)
    .reduce<number | null>((min, f) => {
      if (f.price_cents === null) return min;
      return min === null ? f.price_cents : Math.min(min, f.price_cents);
    }, null);

  return {
    number: String(t.trainNumber ?? t.number ?? t.train_number ?? ''),
    name: String(t.trainName ?? t.name ?? t.routeName ?? t.route ?? ''),
    departs_at: String(t.departureDateTime ?? t.departs ?? t.departTime ?? t.originDepartureTime ?? ''),
    arrives_at: String(t.arrivalDateTime ?? t.arrives ?? t.arrivalTime ?? t.destArrivalTime ?? ''),
    duration_minutes: parseDuration(t),
    fares,
    cheapest_cents: cheapest,
  };
}

function parseFares(t: Record<string, unknown>): FareOption[] {
  const rawFares =
    (t.fares as unknown[]) ??
    (t.fareOptions as unknown[]) ??
    (t.prices as unknown[]) ??
    (t.fareClasses as unknown[]) ??
    [];

  if (rawFares.length > 0) {
    return rawFares.map((f) => {
      const fare = f as Record<string, unknown>;
      const price = parsePrice(fare.price ?? fare.amount ?? fare.cost ?? fare.lowestFare);
      return {
        fare_class: String(fare.class ?? fare.fareClass ?? fare.type ?? fare.classCode ?? ''),
        fare_type: String(fare.fareType ?? fare.tier ?? fare.bucketCode ?? 'Standard'),
        price_cents: price,
        available: price !== null && (fare.available as boolean) !== false && (fare.soldOut as boolean) !== true,
      };
    });
  }

  // Flat top-level price fields
  const classMap: Record<string, string> = {
    coachPrice: 'Coach', businessPrice: 'Business', firstClassPrice: 'First Class',
    roomettePrice: 'Roomette', bedroomPrice: 'Bedroom', accomodationsPrice: 'Accommodation',
  };
  const fares: FareOption[] = [];
  for (const [key, label] of Object.entries(classMap)) {
    if (key in t) {
      const price = parsePrice(t[key]);
      fares.push({ fare_class: label, fare_type: 'Standard', price_cents: price, available: price !== null });
    }
  }
  return fares;
}

function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'N/A' || raw === 0) return null;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (isNaN(num) || num <= 0) return null;
  return num < 10000 ? Math.round(num * 100) : Math.round(num);
}

function parseDuration(t: Record<string, unknown>): number {
  const raw = t.travelTime ?? t.duration ?? t.durationMinutes ?? t.tripDuration;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const hm = raw.match(/(\d+)h\s*(\d+)?m?/);
    if (hm) return parseInt(hm[1]) * 60 + parseInt(hm[2] ?? '0');
    const colonMatch = raw.match(/^(\d+):(\d+)/);
    if (colonMatch) return parseInt(colonMatch[1]) * 60 + parseInt(colonMatch[2]);
    const mins = parseInt(raw);
    if (!isNaN(mins)) return mins;
  }
  return 0;
}
