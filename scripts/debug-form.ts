/**
 * Loads the Amtrak homepage, dumps form HTML, then fills+submits the search
 * to discover the current search URL and XHR endpoints.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';

const SKIP = ['demdex', 'omtrdc', 'pinterest', 'linkedin', 'doubleclick', 'google-analytics',
  'googletagmanager', 'facebook', 'twitter', 'segment', 'hotjar', 'newrelic', 'adobedtm', 'nr-data',
  'flashtalking', 'cognitivlabs', 'smetrics', 'nuance', 'akam'];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
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
  const xhrLog: string[] = [];

  page.on('response', async (res) => {
    const url = res.url();
    if (SKIP.some((s) => url.includes(s))) return;
    const ct = res.headers()['content-type'] ?? '';
    let preview = '';
    if (ct.includes('json') || ct.includes('xml')) {
      try { preview = (await res.text()).slice(0, 600); } catch {}
    }
    xhrLog.push(`[${res.status()}] ${url}${preview ? '\n  BODY: ' + preview : ''}`);
  });

  console.log('Loading homepage...');
  await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Screenshot of homepage
  fs.writeFileSync('/tmp/amtrak-home.png', await page.screenshot({ fullPage: true }));

  // Dump input fields and buttons visible on homepage
  const inputs = await page.evaluate(() => {
    const els = document.querySelectorAll('input, select, button, [role="combobox"], [role="textbox"]');
    return Array.from(els).map((el) => ({
      tag: el.tagName,
      type: (el as HTMLInputElement).type ?? '',
      id: el.id,
      name: (el as HTMLInputElement).name ?? '',
      placeholder: (el as HTMLInputElement).placeholder ?? '',
      ariaLabel: el.getAttribute('aria-label') ?? '',
      classes: el.className.slice(0, 100),
      text: (el as HTMLElement).innerText?.slice(0, 50) ?? '',
    }));
  });
  console.log('\n=== Form elements on homepage ===');
  inputs.forEach((el) => {
    if (el.id || el.placeholder || el.ariaLabel || el.name || el.text) {
      console.log(JSON.stringify(el));
    }
  });

  // Try to dismiss cookie banner if present
  try {
    const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("OK"), #onetrust-accept-btn-handler');
    if (await cookieBtn.first().isVisible({ timeout: 2000 })) {
      await cookieBtn.first().click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Dump the inner HTML around likely booking widget areas
  const formHtml = await page.evaluate(() => {
    const booking = document.querySelector('[class*="booking"], [class*="search"], [class*="travel"], [id*="booking"], form');
    return booking ? booking.outerHTML.slice(0, 3000) : 'No form found';
  });
  console.log('\n=== Booking widget HTML (first 3000 chars) ===\n', formHtml);

  // Try to fill the origin field
  console.log('\n\nAttempting form fill...');
  try {
    // Common selectors for Amtrak's booking widget
    const originSelectors = [
      'input[id*="origin"]', 'input[name*="origin"]', 'input[placeholder*="From"]',
      'input[placeholder*="from"]', 'input[aria-label*="From"]', 'input[aria-label*="Origin"]',
      '[id*="fromStation"]', '[id*="from-station"]',
    ];

    let filled = false;
    for (const sel of originSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click();
        await el.fill('New York');
        console.log('Filled origin with selector:', sel);
        await page.waitForTimeout(2000);

        // Screenshot after typing
        fs.writeFileSync('/tmp/amtrak-origin-typed.png', await page.screenshot());
        filled = true;
        break;
      }
    }
    if (!filled) console.log('Could not find origin input with known selectors');
  } catch (err) {
    console.log('Form fill error:', err);
  }

  console.log('\n=== Non-analytics XHR so far ===');
  xhrLog.forEach((r) => console.log(r));

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
