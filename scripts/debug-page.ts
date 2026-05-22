/**
 * Debug script: takes a screenshot of what Playwright sees on the Amtrak search results page
 * and logs all non-analytics network requests.
 * Usage: npx ts-node --project tsconfig.scripts.json scripts/debug-page.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    (window as any).chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const allRequests: string[] = [];

  const SKIP = ['demdex', 'omtrdc', 'pinterest', 'linkedin', 'doubleclick', 'google-analytics',
    'googletagmanager', 'facebook', 'segment', 'hotjar', 'newrelic', 'adobedtm', 'nr-data'];

  page.on('response', async (res) => {
    const url = res.url();
    if (SKIP.some((s) => url.includes(s))) return;
    const ct = res.headers()['content-type'] ?? '';
    let preview = '';
    if (ct.includes('json')) {
      try { preview = JSON.stringify(await res.json()).slice(0, 400); } catch {}
    }
    allRequests.push(`[${res.status()}] ${url}${preview ? '\n  ' + preview : ''}`);
  });

  // Step 1: visit homepage to get cookies/session
  console.log('Visiting homepage...');
  await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Step 2: navigate to search results
  const searchUrl = 'https://www.amtrak.com/reservations/results.html#/?type=oneway&origin=NYP&destination=WAS&departDate=07%2F15%2F2025&returnDate=&passengers=1-0-0-0-0&trains=undefined&requestType=O';
  console.log('Navigating to search results...');
  await page.goto(searchUrl, { waitUntil: 'load', timeout: 30000 });

  // Wait up to 20s for results to render
  await page.waitForTimeout(20000);

  // Screenshot
  const shot = await page.screenshot({ fullPage: true });
  fs.writeFileSync('/tmp/amtrak-debug.png', shot);
  console.log('Screenshot saved to /tmp/amtrak-debug.png');

  // Page title + URL
  console.log('Page title:', await page.title());
  console.log('Page URL:', page.url());

  // Any text visible on page indicating results or error
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('\n=== Page text (first 2000 chars) ===\n', bodyText);

  console.log('\n=== Non-analytics network requests ===');
  allRequests.forEach((r) => console.log(r));

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
