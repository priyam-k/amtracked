/**
 * Standalone test for the Amtrak scraper.
 * Usage: npm run test:scraper
 * Tip: set DEBUG_XHR=true to log all JSON XHR responses and identify the correct endpoint.
 */
import 'dotenv/config';
import { searchTrains } from '../src/scraper/amtrak';
import { searchViaApi } from '../src/scraper/api';
import { getBrowserContext, closeBrowser } from '../src/scraper/browser';

async function main() {
  // Adjust origin/destination/date as needed
  const params = {
    origin: process.argv[2] ?? 'NYP',
    destination: process.argv[3] ?? 'WAS',
    travel_date: process.argv[4] ?? '2025-07-01',
    passengers: 1,
  };

  console.log(`Searching: ${params.origin} → ${params.destination} on ${params.travel_date}\n`);

  try {
    const result = await searchTrains(params);

    if (result.trains.length === 0) {
      console.log('No trains found (or parsing failed). Try setting DEBUG_XHR=true.');
    } else {
      console.log(`Found ${result.trains.length} train(s):\n`);
      for (const train of result.trains) {
        const price =
          train.cheapest_cents !== null
            ? `$${(train.cheapest_cents / 100).toFixed(2)}`
            : 'N/A';
        console.log(`  #${train.number} ${train.name}`);
        console.log(`    ${train.departs_at} → ${train.arrives_at} (${train.duration_minutes}min)`);
        console.log(`    Cheapest: ${price}`);
        for (const f of train.fares) {
          const p = f.price_cents !== null ? `$${(f.price_cents / 100).toFixed(2)}` : 'Sold out';
          console.log(`    ${f.fare_class} (${f.fare_type}): ${p}`);
        }
        console.log();
      }
    }
  } finally {
    await closeBrowser();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
