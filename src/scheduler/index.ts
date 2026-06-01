import * as cron from 'node-cron';
import { getActiveAlerts, saveSnapshot } from '../db/queries';
import { getSession, clearSession } from '../scraper/session';
import { searchWithSession } from '../scraper/session-client';
import { AlertWithRoute, SearchResult } from '../types';

// Gap between individual route searches within one poll cycle.
// Keeps request frequency comfortably under Akamai's burst limit.
const REQUEST_GAP_MS = 10_000;

const POLL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES ?? '60', 10);

export function startScheduler(): void {
  if (isNaN(POLL_MINUTES) || POLL_MINUTES < 1) {
    console.warn('[scheduler] Invalid POLL_INTERVAL_MINUTES — scheduler disabled');
    return;
  }

  const schedule = `*/${POLL_MINUTES} * * * *`;
  cron.schedule(schedule, () => { void pollAlerts(); });
  console.log(`[scheduler] Polling active alerts every ${POLL_MINUTES} min`);
}

async function pollAlerts(): Promise<void> {
  const session = getSession();
  if (!session) {
    console.warn('[scheduler] No session cookies — skipping poll. Paste a fresh cURL into .amtrak-curl.');
    return;
  }

  const alerts = getActiveAlerts();
  if (alerts.length === 0) {
    console.log('[scheduler] No active alerts to poll.');
    return;
  }

  console.log(`[scheduler] Polling ${alerts.length} alert(s)...`);

  for (const [i, alert] of alerts.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);

    try {
      const result = await searchWithSession(session, {
        origin: alert.origin,
        destination: alert.destination,
        travel_date: alert.travel_date!,
      });

      saveSnapshot(result);
      checkThreshold(alert, result);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[scheduler] Alert ${alert.id} (${alert.origin}→${alert.destination} ${alert.travel_date}): ${msg}`);

      if (msg.includes('expired') || msg.includes('timed out')) {
        console.warn('[scheduler] Session exhausted — halting poll cycle. Update .amtrak-curl to resume.');
        clearSession();
        break;
      }
    }
  }

  console.log('[scheduler] Poll cycle complete.');
}

function checkThreshold(alert: AlertWithRoute, result: SearchResult): void {
  if (!alert.max_price_cents) return;

  const cheapest = result.trains
    .map((t) => t.cheapest_cents)
    .filter((p): p is number => p !== null)
    .reduce<number | null>((min, p) => (min === null ? p : Math.min(min, p)), null);

  if (cheapest === null) {
    console.log(`[scheduler] ${alert.origin}→${alert.destination} ${alert.travel_date}: no fares available`);
    return;
  }

  const threshold = alert.max_price_cents;
  const priceStr = `$${(cheapest / 100).toFixed(2)}`;
  const thresholdStr = `$${(threshold / 100).toFixed(2)}`;

  if (cheapest <= threshold) {
    notify(alert, cheapest, result);
  } else {
    console.log(`[scheduler] ${alert.origin}→${alert.destination} ${alert.travel_date}: ${priceStr} (above ${thresholdStr})`);
  }
}

function notify(alert: AlertWithRoute, priceCents: number, result: SearchResult): void {
  const priceStr = `$${(priceCents / 100).toFixed(2)}`;
  const thresholdStr = `$${(alert.max_price_cents! / 100).toFixed(2)}`;

  // Find the cheapest train(s) to show in the alert
  const hits = result.trains
    .filter((t) => t.cheapest_cents !== null && t.cheapest_cents <= alert.max_price_cents!)
    .slice(0, 3);

  console.log('\n' + '═'.repeat(60));
  console.log(`  PRICE ALERT: ${alert.origin} → ${alert.destination} on ${alert.travel_date}`);
  console.log(`  Cheapest available: ${priceStr}  (your threshold: ${thresholdStr})`);
  for (const t of hits) {
    const p = `$${(t.cheapest_cents! / 100).toFixed(2)}`;
    console.log(`  #${t.number} ${t.name}  ${t.departs_at.slice(11, 16)} → ${t.arrives_at.slice(11, 16)}  ${p}`);
  }
  console.log('═'.repeat(60) + '\n');

  // macOS system notification (no extra deps — uses built-in osascript)
  if (process.platform === 'darwin') {
    const msg = `${alert.origin}→${alert.destination} ${alert.travel_date}: ${priceStr}`;
    const script = `display notification "${msg}" with title "amtracked price alert"`;
    require('child_process').exec(`osascript -e '${script}'`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
