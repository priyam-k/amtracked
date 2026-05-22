/**
 * Find the booking widget's exact form structure by searching from the FIND TRAINS button.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto('https://www.amtrak.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Find the FIND TRAINS button and walk up to find its form container
  const bookingInfo = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    const findTrainsBtn = allBtns.find((b) =>
      b.getAttribute('aria-label') === 'FIND TRAINS' || b.textContent?.trim() === 'FIND TRAINS'
    );
    if (!findTrainsBtn) return { found: false, inputs: [], html: '' };

    // Walk up to find the booking widget container
    let container: Element = findTrainsBtn;
    for (let i = 0; i < 10; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      // Stop when we find a large enough container
      const inputs = container.querySelectorAll('input');
      if (inputs.length >= 2) break;
    }

    const inputs = Array.from(container.querySelectorAll('input'));
    return {
      found: true,
      html: container.outerHTML.slice(0, 5000),
      containerTag: container.tagName,
      containerClass: (container as HTMLElement).className.slice(0, 200),
      containerId: container.id,
      inputs: inputs.map((inp) => ({
        id: inp.id,
        ariaLabel: inp.getAttribute('aria-label'),
        name: inp.name,
        placeholder: inp.placeholder,
        type: inp.type,
        formControlName: inp.getAttribute('formcontrolname'),
        classes: inp.className.slice(0, 100),
      })),
    };
  });

  console.log('=== Booking Widget Info ===');
  console.log('Found FIND TRAINS:', bookingInfo.found);
  if (bookingInfo.found) {
    console.log('Container tag:', (bookingInfo as any).containerTag);
    console.log('Container class:', (bookingInfo as any).containerClass?.slice(0, 100));
    console.log('Container id:', (bookingInfo as any).containerId);
    console.log('\nInputs inside booking widget:');
    (bookingInfo as any).inputs?.forEach((inp: any) => console.log(JSON.stringify(inp)));

    console.log('\n=== Container HTML (first 3000 chars) ===');
    console.log((bookingInfo as any).html?.slice(0, 3000));
  }

  // Also find ALL inputs with aria-label "departure station" and log their context
  const allFromInputs = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="departure station"]'));
    return inputs.map((inp, i) => {
      const parent3 = inp.parentElement?.parentElement?.parentElement;
      const nearbyBtns = parent3
        ? Array.from(parent3.querySelectorAll('button')).map((b) => b.textContent?.trim().slice(0, 30))
        : [];
      return {
        index: i,
        id: inp.id,
        formControlName: inp.getAttribute('formcontrolname'),
        parentClass: inp.parentElement?.className.slice(0, 100),
        grandparentClass: inp.parentElement?.parentElement?.className.slice(0, 100),
        nearbyButtons: nearbyBtns.slice(0, 5),
      };
    });
  });

  console.log('\n=== All "departure station" inputs ===');
  allFromInputs.forEach((inp) => console.log(JSON.stringify(inp)));

  fs.writeFileSync('/tmp/amtrak-booking-widget.png', await page.screenshot({ fullPage: false }));
  console.log('\nScreenshot saved: /tmp/amtrak-booking-widget.png');

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
