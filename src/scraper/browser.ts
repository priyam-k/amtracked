import { chromium as playwrightChromium, Browser, BrowserContext } from 'playwright';
import { chromium as extraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Apply stealth plugin to evade headless browser detection (Akamai, etc.)
extraChromium.use(StealthPlugin());

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function getBrowserContext(): Promise<BrowserContext> {
  if (context) return context;

  browser = await extraChromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Override client hints to hide headless mode (Akamai checks sec-ch-ua for "HeadlessChrome")
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  // Mask navigator.webdriver and spoof browser identity
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };

    // Override userAgentData to hide "HeadlessChrome"
    if ((navigator as any).userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Google Chrome', version: '124' },
            { brand: 'Chromium', version: '124' },
            { brand: 'Not-A.Brand', version: '99' },
          ],
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: async (hints: string[]) => ({
            architecture: 'arm',
            bitness: '64',
            brands: [{ brand: 'Google Chrome', version: '124' }],
            fullVersionList: [{ brand: 'Google Chrome', version: '124.0.0.0' }],
            mobile: false,
            model: '',
            platform: 'macOS',
            platformVersion: '14.0.0',
            uaFullVersion: '124.0.0.0',
          }),
        }),
      });
    }
  });

  // Pre-set OneTrust consent cookies so the banner/overlay never appears
  await context.addCookies([
    {
      name: 'OptanonAlertBoxClosed',
      value: new Date().toISOString(),
      domain: '.amtrak.com',
      path: '/',
    },
    {
      name: 'OptanonConsent',
      value: 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toUTCString()) + '&version=202410.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=amtracked&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1',
      domain: '.amtrak.com',
      path: '/',
    },
  ]);

  return context;
}

export async function closeBrowser(): Promise<void> {
  await context?.close();
  await browser?.close();
  context = null;
  browser = null;
}
