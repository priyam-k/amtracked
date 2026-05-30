import { chromium as extraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { existsSync, mkdirSync } from 'fs';
import { BrowserContext } from 'playwright';
import path from 'path';
import os from 'os';

extraChromium.use(StealthPlugin());

// Dedicated Chrome profile that persists across runs, building up Akamai trust score
const PROFILE_DIR = path.join(os.homedir(), '.amtracked', 'chrome-profile');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
];

let context: BrowserContext | null = null;
let closeCallback: (() => Promise<void>) | null = null;

function findChrome(): string | undefined {
  return CHROME_PATHS.find(existsSync);
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (context) return context;

  // Default to headed — Akamai's JS challenge passes in headed mode;
  // headless mode is fingerprinted and blocked. Set HEADLESS=true to override.
  const headless = process.env.HEADLESS === 'true';
  const executablePath = findChrome();

  if (executablePath) {
    console.log(`[browser] Chrome: ${executablePath.split('/').at(-1)} (${headless ? 'headless' : 'headed'})`);
    mkdirSync(PROFILE_DIR, { recursive: true });

    // Persistent context: cookies/Akamai trust accumulate between runs
    context = await extraChromium.launchPersistentContext(PROFILE_DIR, {
      executablePath,
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    closeCallback = async () => context!.close();
  } else {
    console.log('[browser] Chrome not found — falling back to Playwright Chromium with stealth');
    const browser = await extraChromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="136", "Chromium";v="136", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    });
    closeCallback = async () => {
      await context!.close();
      await browser.close();
    };
  }

  // Remove webdriver flag — most critical anti-detection patch
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Pre-set OneTrust cookies so the banner/overlay never appears
  await context.addCookies([
    {
      name: 'OptanonAlertBoxClosed',
      value: new Date().toISOString(),
      domain: '.amtrak.com',
      path: '/',
    },
    {
      name: 'OptanonConsent',
      value:
        'isGpcEnabled=0&datestamp=' +
        encodeURIComponent(new Date().toUTCString()) +
        '&version=202410.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=amtracked&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1',
      domain: '.amtrak.com',
      path: '/',
    },
  ]);

  return context;
}

export async function closeBrowser(): Promise<void> {
  await closeCallback?.();
  context = null;
  closeCallback = null;
}
