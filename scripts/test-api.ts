/**
 * Test the direct API approach — calls /dotcom/journey-solution-option from
 * within the Playwright browser context (using session cookies established by
 * loading the Amtrak homepage first).
 *
 * Usage: npm run test:api
 * Usage: npm run test:api NYP WAS 2026-07-15
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { searchViaApi } from '../src/scraper/api';

async function main() {
  const origin = process.argv[2] ?? 'NYP';
  const destination = process.argv[3] ?? 'WAS';
  const travel_date = process.argv[4] ?? '2026-07-15';

  console.log(`Searching via API: ${origin} → ${destination} on ${travel_date}\n`);

  // Try headed mode to bypass Akamai's headless detection
  const headless = process.env.HEADLESS !== 'false';
  console.log(`Running in ${headless ? 'headless' : 'headed'} mode`);
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });

  await ctx.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.amtrak.com', path: '/' },
    { name: 'OptanonConsent', value: 'isGpcEnabled=0&interactionCount=1&groups=C0001%3A1%2CC0004%3A1', domain: '.amtrak.com', path: '/' },
  ]);

  const page = await ctx.newPage();

  try {
    // Load the homepage to establish session cookies and pass Akamai challenge
    console.log('Loading Amtrak homepage to establish session...');
    await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });

    // Wait for Akamai challenge responses to complete (they fire asynchronously)
    // The challenge endpoint is xSRxOGcc_RGzYt1mXg - we need {"success":true} responses
    let akaCompletions = 0;
    page.on('response', (res) => {
      if (res.url().includes('xSRxOGcc_RGzYt1mXg') && res.status() === 201) {
        akaCompletions++;
      }
    });

    // Wait up to 15 seconds for at least 2 Akamai challenge completions
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      if (akaCompletions >= 2) break;
    }
    console.log(`Akamai challenge completions: ${akaCompletions}`);

    // Simulate some human-like page interaction
    await page.mouse.move(400, 300);
    await page.mouse.move(600, 400);
    await page.waitForTimeout(2000);

    // Now call the search API directly
    const result = await searchViaApi(page, { origin, destination, travel_date, passengers: 1 });

    if (result.trains.length === 0) {
      console.log('No trains found (API blocked or no results).');
    } else {
      console.log(`Found ${result.trains.length} train(s):\n`);
      for (const train of result.trains) {
        const price = train.cheapest_cents !== null
          ? `$${(train.cheapest_cents / 100).toFixed(2)}`
          : 'N/A';
        console.log(`  #${train.number} ${train.name}`);
        console.log(`    ${train.departs_at} → ${train.arrives_at} (${train.duration_minutes}min)`);
        console.log(`    Cheapest: ${price}`);
        for (const f of train.fares) {
          const p = f.price_cents !== null ? `$${(f.price_cents / 100).toFixed(2)}` : 'Sold out';
          console.log(`      ${f.fare_class} (${f.fare_type}): ${p}`);
        }
        console.log();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
