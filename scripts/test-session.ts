/**
 * Test the session-cookie approach: takes Akamai-validated cookies from AMTRAK_COOKIES
 * env var and fires multiple requests to answer the key questions:
 *   1. Are cookies query-agnostic? (different routes/dates with same cookies)
 *   2. How long does a session last? (fires requests at intervals)
 *   3. How many requests can we make per session?
 *
 * Usage:
 *   1. Open amtrak.com in Chrome, do any search
 *   2. DevTools → Network → journey-solution-option → right-click → Copy as cURL
 *   3. Extract the cookie string from the -b '...' flag
 *   4. AMTRAK_COOKIES="PIM-SESSION-ID=...; _abck=...; ..." npm run test:session
 *
 * Or just run `npm run test:session` after running `npm run test:scraper` once
 * (the scraper saves cookies to ~/.amtracked/session.json automatically).
 */
import 'dotenv/config';
import { getSession, sessionAge, abckBudgetState } from '../src/scraper/session';
import { searchWithSession } from '../src/scraper/session-client';
import { SearchParams } from '../src/types';

const QUERIES: SearchParams[] = [
  { origin: 'NYP', destination: 'WAS', travel_date: '2026-07-15', passengers: 1 },
  { origin: 'NYP', destination: 'BOS', travel_date: '2026-07-15', passengers: 1 },
  { origin: 'WAS', destination: 'NYP', travel_date: '2026-07-20', passengers: 1 },
];

function printResult(params: SearchParams, trains: import('../src/types').Train[]): void {
  console.log(`\n${params.origin} → ${params.destination} on ${params.travel_date}: ${trains.length} train(s)`);
  for (const t of trains.slice(0, 3)) {
    const price = t.cheapest_cents !== null ? `$${(t.cheapest_cents / 100).toFixed(2)}` : 'N/A';
    console.log(`  #${t.number} ${t.name} | ${t.departs_at} → ${t.arrives_at} | cheapest: ${price}`);
    for (const f of t.fares) {
      const p = f.price_cents !== null ? `$${(f.price_cents / 100).toFixed(2)}` : 'sold out';
      const avail = f.available ? '✓' : '✗';
      console.log(`    ${avail} ${f.fare_class} (${f.fare_type}): ${p}`);
    }
  }
  if (trains.length > 3) console.log(`  ... and ${trains.length - 3} more`);
}

async function main(): Promise<void> {
  const cookies = getSession();
  if (!cookies) {
    console.error(
      'No session cookies found.\n' +
      '  Option 1: Set AMTRAK_COOKIES env var with the cookie string from a DevTools cURL copy.\n' +
      '  Option 2: Run `npm run test:scraper` once — it saves cookies automatically if Playwright succeeds.\n' +
      '\nThe cookie string is the value after -b in the cURL command:\n' +
      '  curl \'https://www.amtrak.com/dotcom/journey-solution-option\' \\\n' +
      '    -b \'PIM-SESSION-ID=...; _abck=...; ...\' \\\n' +
      '    ...'
    );
    process.exit(1);
  }

  const age = sessionAge();
  const budget = abckBudgetState(cookies);
  const budgetNote = budget === 'refreshed' ? ' | _abck refreshed ✓' : '';
  console.log(`Session cookies found${age !== null ? ` (${age}s old)` : ''}${budgetNote}`);
  console.log(`Running ${QUERIES.length} queries to test query-agnostic nature...\n`);

  let passed = 0;
  let failed = 0;

  for (const [i, query] of QUERIES.entries()) {
    const start = Date.now();
    try {
      const result = await searchWithSession(cookies, query);
      const elapsed = Date.now() - start;
      printResult(query, result.trains);
      console.log(`  ✓ ${elapsed}ms`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`  ✗ Query ${i + 1} failed: ${(err as Error).message}`);
      if ((err as Error).message.includes('expired')) {
        console.error('  Session expired — re-authenticate and retry.');
        break;
      }
    }
    // Small delay between requests
    if (i < QUERIES.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\n--- ${passed}/${QUERIES.length} queries succeeded ---`);
  if (passed === QUERIES.length) {
    console.log('✓ Cookies are query-agnostic (different routes/dates worked with same session)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
