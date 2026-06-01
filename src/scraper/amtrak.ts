import { Page, Response } from 'playwright';
import { getBrowserContext } from './browser';
import { getSession, setSession } from './session';
import { searchWithSession } from './session-client';
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

// Fills a station field using Angular's natural dropdown flow:
// click to focus → wait for dropdown to open → click the matching option.
// NOT using force-show CSS tricks because those don't update Angular's reactive form model.
async function fillStation(page: Page, fieldLabel: 'From' | 'To', stationCode: string): Promise<void> {
  const inputLocator = page.locator(`input[aria-label="${fieldLabel}"]`).first();
  await inputLocator.waitFor({ state: 'visible', timeout: 15000 });

  const containerSelector = `am-form-field-new:has(input[aria-label="${fieldLabel}"])`;
  const codeRegex = new RegExp(`\\(${stationCode}\\)`);

  // Click the input — Angular should open the dropdown and show pre-loaded options
  await inputLocator.click({ timeout: 5000 });
  await page.waitForTimeout(600);

  // Wait for the dropdown to naturally open (Angular removes ads-hidden from listbox)
  const dropdownOpen = await page
    .locator(`${containerSelector} [role="listbox"]`)
    .first()
    .isVisible({ timeout: 2500 })
    .catch(() => false);

  if (!dropdownOpen) {
    // Dropdown didn't open from click — press ArrowDown to force Angular to open it
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(1000);
  }

  // Try to click the matching option while Angular thinks the dropdown is open
  const option = page.locator(`${containerSelector} div[role="option"]`).filter({ hasText: codeRegex }).first();
  const optionVisible = await option.isVisible({ timeout: 2000 }).catch(() => false);

  if (optionVisible) {
    const txt = await option.textContent().catch(() => '');
    await option.click({ timeout: 5000 });
    console.log(`[scraper] ${fieldLabel} → "${txt?.trim().slice(0, 70)}"`);
  } else {
    // Options not visible or no match — type the station code to trigger Angular's filter
    console.log(`[scraper] ${fieldLabel} option not visible, typing "${stationCode}" to filter`);
    await inputLocator.fill('');
    await page.waitForTimeout(200);
    await inputLocator.type(stationCode, { delay: 60 });
    await page.waitForTimeout(1200); // wait for Angular to filter

    const filtered = page.locator(`${containerSelector} div[role="option"]`).filter({ hasText: codeRegex }).first();
    if (await filtered.isVisible({ timeout: 2000 }).catch(() => false)) {
      const txt = await filtered.textContent().catch(() => '');
      await filtered.click({ timeout: 5000 });
      console.log(`[scraper] ${fieldLabel} typed → "${txt?.trim().slice(0, 70)}"`);
    } else {
      // Last resort: use first visible option
      const firstOption = page.locator(`${containerSelector} div[role="option"]`).first();
      if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
        await firstOption.click();
        console.log(`[scraper] ${fieldLabel} → first available option`);
      } else {
        console.warn(`[scraper] ${fieldLabel}: could not find option for ${stationCode}`);
        await page.keyboard.press('Enter');
      }
    }
  }

  await page.waitForTimeout(400);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  // Confirm the input has a value (Angular form control updated)
  const val = await inputLocator.inputValue().catch(() => '');
  console.log(`[scraper] ${fieldLabel} input value: "${val.slice(0, 60)}"`);
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

  // Use page.route() instead of page.on('response') for the search endpoint.
  // Angular posts to journey-solution-option then immediately navigates away; by the time
  // the async response handler runs, the browser context has been replaced and res.json()
  // silently fails. page.route() reads the body from Playwright's own network layer
  // (not the browser JS context) so it's always available regardless of navigation.
  await page.route('**/dotcom/journey-solution-option', async (route) => {
    const response = await route.fetch();
    const status = response.status();
    const ct = response.headers()['content-type'] ?? '';
    console.log(`[scraper] journey-solution-option HTTP ${status} (ct: ${ct})`);

    if (status === 200) {
      try {
        const body = await response.json();
        const keys = Object.keys(body as object);
        console.log(`[scraper] response keys: ${keys.join(', ')}`);
        console.log(`[scraper] body snippet: ${JSON.stringify(body).slice(0, 600)}`);
        captured.push({ url: route.request().url(), body });
      } catch {
        const text = await response.text().catch(() => '');
        console.log(`[scraper] journey-solution-option body (non-JSON): ${text.slice(0, 300)}`);
      }
    } else {
      const text = await response.text().catch(() => '');
      console.log(`[scraper] error body: ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    }

    await route.fulfill({ response });
  });

  return captured;
}

// Wait for Akamai's JS challenge to complete. Akamai POSTs sensor data to a hidden endpoint;
// 201 responses mean the session is being validated. We need ≥2 before touching the form.
async function waitForAkamaiChallenge(page: Page): Promise<void> {
  let completions = 0;
  const onResponse = (res: Response) => {
    if (res.url().includes('xSRxOGcc') && res.status() === 201) completions++;
  };
  page.on('response', onResponse);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && completions < 2) {
    await page.waitForTimeout(400);
  }
  page.off('response', onResponse);
  console.log(`[scraper] Akamai challenge completions: ${completions}`);
}

// Simulate realistic human behavior to build Akamai's behavioral trust score
async function simulateHumanPresence(page: Page): Promise<void> {
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  await page.mouse.move(rand(300, 700), rand(150, 350));
  await page.waitForTimeout(rand(300, 600));
  await page.evaluate(() => window.scrollBy({ top: 120, behavior: 'smooth' }));
  await page.waitForTimeout(rand(500, 900));
  await page.mouse.move(rand(400, 800), rand(250, 500));
  await page.waitForTimeout(rand(300, 500));
  await page.evaluate(() => window.scrollBy({ top: -120, behavior: 'smooth' }));
  await page.waitForTimeout(rand(400, 700));
}

// Wait for the FIND TRAINS button to become naturally valid (aria-disabled removed by Angular).
// Returns true if form became valid; false if it timed out (we'll force-click as fallback).
async function waitForFormValid(page: Page, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const valid = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="FIND TRAINS"]');
      return btn?.getAttribute('aria-disabled') !== 'true';
    });
    if (valid) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

export async function searchTrains(params: SearchParams): Promise<SearchResult> {
  // Fast path: use cached session cookies (from manual paste or previous Playwright run)
  const session = getSession();
  if (session) {
    console.log('[scraper] Using cached session cookies (no browser needed)');
    try {
      return await searchWithSession(session, params);
    } catch (err) {
      console.warn('[scraper] Session request failed, falling back to Playwright:', (err as Error).message);
    }
  }

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

  // Log the search POST for debugging (route handler also captures it, but this confirms the request was made)
  page.on('request', (req) => {
    if (req.url().includes('/dotcom/journey-solution-option')) {
      console.log(`[scraper] → POST journey-solution-option (referer: ${req.headers()['referer'] ?? 'none'})`);
    }
  });

  try {
    console.log('[scraper] Loading Amtrak homepage...');
    await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Wait for Akamai's JS challenge before touching the form
    await waitForAkamaiChallenge(page);

    // If Playwright got past Akamai, extract and cache cookies for direct HTTP reuse.
    // These cookies work the same as manually-captured ones — skip the browser next time.
    try {
      const cookies = await ctx.cookies(['https://www.amtrak.com']);
      if (cookies.length > 0) {
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        setSession(cookieHeader);
      }
    } catch {}

    await dismissCookieBanner(page);

    // Simulate human presence to build behavioral trust score
    await simulateHumanPresence(page);

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

    // Short pause before submitting
    await page.waitForTimeout(500);

    const urlBefore = page.url();

    const allFindTrainsBtns = page.locator('button[aria-label="FIND TRAINS"]');
    const btnCount = await allFindTrainsBtns.count();
    console.log(`[scraper] Found ${btnCount} FIND TRAINS button(s)`);

    // Hook into history API to capture Angular router navigation
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

    // Wait for Angular's form to become valid (station + date fields properly populated).
    // If the form is valid, FIND TRAINS loses aria-disabled and we can click it naturally.
    // This is critical: if we force-click while the form is invalid, Angular sends empty
    // station codes and the backend returns 403.
    const formValid = await waitForFormValid(page);
    console.log(`[scraper] Form valid: ${formValid}`);

    if (!formValid) {
      // Form didn't become valid — check what Angular thinks the field values are
      const formState = await page.evaluate(() => {
        const fromInput = document.querySelector<HTMLInputElement>('input[aria-label="From"]');
        const toInput = document.querySelector<HTMLInputElement>('input[aria-label="To"]');
        const dateInput = document.querySelector<HTMLInputElement>('input.departed-picker');
        const btn = document.querySelector<HTMLButtonElement>('button[aria-label="FIND TRAINS"]');
        return {
          from: fromInput?.value,
          to: toInput?.value,
          date: dateInput?.value,
          ariaDisabled: btn?.getAttribute('aria-disabled'),
        };
      });
      console.log('[scraper] Form state (invalid):', JSON.stringify(formState));

      // Force-enable the button as fallback — Angular will still send whatever it has
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="FIND TRAINS"]'));
        for (const btn of btns) {
          btn.style.setProperty('pointer-events', 'auto', 'important');
          btn.style.setProperty('opacity', '1', 'important');
          btn.removeAttribute('aria-disabled');
          btn.removeAttribute('disabled');
        }
      });
    }

    // Click FIND TRAINS
    for (let i = 0; i < btnCount; i++) {
      const btn = allFindTrainsBtns.nth(i);
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.width > 0) {
        console.log(`[scraper] Clicking FIND TRAINS #${i}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(2000);

        const newUrl = page.url();
        if (newUrl !== urlBefore || captured.length > 0) {
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
    const trains = best ? parseAmtrakResponse(best.body) : [];

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
// Confirmed structure from real API response (testing/curltestoutput.txt):
//   { success: true, data: { journeyLegs: [{ journeyLegOptions: [...] }] } }
//
// Exported so session-client.ts can reuse the same logic.

export function parseAmtrakResponse(raw: unknown): Train[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // Unwrap { success, data } envelope
  const data = (obj.success && obj.data ? obj.data : obj) as Record<string, unknown>;
  const legs = data.journeyLegs as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(legs) || legs.length === 0) {
    console.warn('[parse] journeyLegs not found. Top-level keys:', Object.keys(obj).join(', '));
    return [];
  }

  const options = legs[0]?.journeyLegOptions as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(options)) return [];

  return options.map(parseJourneyLegOption).filter((t): t is Train => t !== null);
}

function parseJourneyLegOption(opt: Record<string, unknown>): Train | null {
  const travelLegs = opt.travelLegs as Array<Record<string, unknown>> | undefined;
  const service = (travelLegs?.[0]?.travelService ?? {}) as Record<string, unknown>;

  const fares = parseAccommodations(opt);
  const cheapest = fares
    .filter((f) => f.available && f.price_cents !== null)
    .reduce<number | null>((min, f) => {
      if (f.price_cents === null) return min;
      return min === null ? f.price_cents : Math.min(min, f.price_cents);
    }, null);

  const origin = (opt.origin ?? {}) as Record<string, unknown>;
  const dest = (opt.destination ?? {}) as Record<string, unknown>;
  const originSched = (origin.schedule ?? {}) as Record<string, unknown>;
  const destSched = (dest.schedule ?? {}) as Record<string, unknown>;

  return {
    number: String(service.number ?? ''),
    name: String(service.name ?? ''),
    departs_at: String(originSched.departureDateTime ?? ''),
    arrives_at: String(destSched.arrivalDateTime ?? ''),
    duration_minutes: typeof opt.elapsedSeconds === 'number' ? Math.round(opt.elapsedSeconds / 60) : 0,
    fares,
    cheapest_cents: cheapest,
  };
}

function parseAccommodations(opt: Record<string, unknown>): FareOption[] {
  const accs = opt.reservableAccommodations as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(accs)) return [];

  return accs.map((acc) => {
    const fareAmt = ((acc.accommodationFare ?? {}) as Record<string, unknown>);
    const dollars = ((fareAmt.dollarsAmount ?? {}) as Record<string, unknown>);
    const totalStr = String(dollars.total ?? '0');
    const priceCents = Math.round(parseFloat(totalStr) * 100);

    const legAccs = acc.travelLegAccommodations as Array<Record<string, unknown>> | undefined;
    const product = (legAccs?.[0]?.reservableProduct ?? {}) as Record<string, unknown>;
    const inventory = typeof product.availableInventory === 'number' ? product.availableInventory : 1;

    return {
      fare_class: String(acc.travelClass ?? ''),
      fare_type: String(acc.fareFamily ?? 'Standard'),
      price_cents: priceCents > 0 ? priceCents : null,
      available: inventory > 0 && priceCents > 0,
    };
  });
}

function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'N/A' || raw === 0) return null;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (isNaN(num) || num <= 0) return null;
  return num < 10000 ? Math.round(num * 100) : Math.round(num);
}
