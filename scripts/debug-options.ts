import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await ctx.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.amtrak.com', path: '/' },
    { name: 'OptanonConsent', value: 'isGpcEnabled=0&interactionCount=1&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1', domain: '.amtrak.com', path: '/' },
  ]);

  const page = await ctx.newPage();
  await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[aria-label="From"]', { state: 'visible', timeout: 15000 });
  await page.evaluate(() => { document.querySelector('#onetrust-consent-sdk')?.remove(); });
  await page.waitForTimeout(1000);

  // Focus the From field
  await page.locator('input[aria-label="From"]').first().focus();
  await page.waitForTimeout(1500);

  // Force-show listbox
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="From"]');
    const container = input?.closest<HTMLElement>('am-form-field-new');
    const listbox = container?.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) {
      listbox.classList.remove('ads-hidden');
      (listbox as HTMLElement).style.setProperty('display', 'block', 'important');
    }
    container?.setAttribute('aria-expanded', 'true');
    input?.setAttribute('aria-expanded', 'true');
  });
  await page.waitForTimeout(500);

  // Snapshot options before typing
  const beforeTyping = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('div[role="option"]')).map((o) => ({
      text: o.textContent?.trim().slice(0, 80),
      visible: o.offsetParent !== null,
    }))
  );
  console.log('\n=== Options BEFORE typing (pre-loaded) ===');
  beforeTyping.forEach((o, i) => console.log(i, o.visible ? '[V]' : '[H]', o.text));
  fs.writeFileSync('/tmp/amtrak-before-typing.png', await page.screenshot());

  // Now type "NYP"
  await page.keyboard.type('N', { delay: 200 });
  await page.waitForTimeout(300);
  await page.keyboard.type('Y', { delay: 200 });
  await page.waitForTimeout(300);
  await page.keyboard.type('P', { delay: 200 });
  await page.waitForTimeout(2000);

  // Re-show listbox
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="From"]');
    const container = input?.closest<HTMLElement>('am-form-field-new');
    const listbox = container?.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) {
      listbox.classList.remove('ads-hidden');
      (listbox as HTMLElement).style.setProperty('display', 'block', 'important');
    }
  });
  await page.waitForTimeout(500);

  const afterTyping = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('div[role="option"]')).map((o) => ({
      text: o.textContent?.trim().slice(0, 80),
      visible: o.offsetParent !== null,
    }))
  );
  console.log('\n=== Options AFTER typing "NYP" ===');
  afterTyping.forEach((o, i) => console.log(i, o.visible ? '[V]' : '[H]', o.text));
  fs.writeFileSync('/tmp/amtrak-after-typing.png', await page.screenshot());

  // Check the input value and aria-expanded
  const state = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="From"]');
    const container = input?.closest<HTMLElement>('am-form-field-new');
    return {
      inputValue: input?.value,
      ariaExpanded: container?.getAttribute('aria-expanded'),
      listboxClasses: container?.querySelector('[role="listbox"]')?.className,
    };
  });
  console.log('\n=== Form state after typing ===');
  console.log(JSON.stringify(state, null, 2));

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
