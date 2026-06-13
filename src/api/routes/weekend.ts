import { Router, Request, Response } from 'express';
import { searchTrains } from '../../scraper/amtrak';
import { saveSnapshot } from '../../db/queries';
import { Train, SearchResult } from '../../types';

const router = Router();

/**
 * POST /weekend-roundtrip
 * Body: {
 *   origin: string,           default "WAS"
 *   destination: string,      default "TRE"
 *   weeks_ahead: number,      default 4
 *   outbound_min_hour: number, default 18  (6pm+)
 *   return_min_hour: number,  default 12  (noon+)
 *   include_thu_mon: boolean, default false
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  const {
    origin = 'WAS',
    destination = 'TRE',
    weeks_ahead = 4,
    outbound_min_hour = 18,
    return_min_hour = 12,
    include_thu_mon = false,
  } = req.body as {
    origin?: string;
    destination?: string;
    weeks_ahead?: number;
    outbound_min_hour?: number;
    return_min_hour?: number;
    include_thu_mon?: boolean;
  };

  const org = origin.toUpperCase();
  const dst = destination.toUpperCase();
  const weeksN = Math.min(Math.max(1, weeks_ahead), 8);

  const fridays = nextNFridays(weeksN);

  type WeekendResult = {
    friday: string;
    sunday: string;
    thursday?: string;
    monday?: string;
    outbound_trains: Train[];
    return_trains: Train[];
  };

  type Combo = {
    weekend: { friday: string; sunday: string };
    outbound: Train;
    return: Train;
    total_cents: number;
  };

  const weekends: WeekendResult[] = [];
  const allCombos: Combo[] = [];
  const errors: string[] = [];

  for (const friday of fridays) {
    const sunday = addDays(friday, 2);
    const thursday = include_thu_mon ? addDays(friday, -1) : undefined;
    const monday = include_thu_mon ? addDays(friday, 3) : undefined;

    // Outbound dates: Thursday (optional) + Friday
    const outboundDates = [thursday, friday].filter(Boolean) as string[];
    // Return dates: Sunday + Monday (optional)
    const returnDates = [sunday, monday].filter(Boolean) as string[];

    let outboundTrains: Train[] = [];
    let returnTrains: Train[] = [];

    for (const date of outboundDates) {
      await sleep(3000);
      try {
        const result = await searchTrains({ origin: org, destination: dst, travel_date: date });
        saveSnapshot(result);
        const filtered = filterByHour(result.trains, date === friday ? outbound_min_hour : 0);
        outboundTrains = [...outboundTrains, ...filtered];
      } catch (err) {
        errors.push(`${org}→${dst} ${date}: ${(err as Error).message}`);
      }
    }

    for (const date of returnDates) {
      await sleep(3000);
      try {
        const result = await searchTrains({ origin: dst, destination: org, travel_date: date });
        saveSnapshot(result);
        const filtered = filterByHour(result.trains, date === sunday ? return_min_hour : 0);
        returnTrains = [...returnTrains, ...filtered];
      } catch (err) {
        errors.push(`${dst}→${org} ${date}: ${(err as Error).message}`);
      }
    }

    // Sort by cheapest
    outboundTrains.sort((a, b) => (a.cheapest_cents ?? Infinity) - (b.cheapest_cents ?? Infinity));
    returnTrains.sort((a, b) => (a.cheapest_cents ?? Infinity) - (b.cheapest_cents ?? Infinity));

    weekends.push({ friday, sunday, thursday, monday, outbound_trains: outboundTrains, return_trains: returnTrains });

    // Generate combos for this weekend
    for (const ob of outboundTrains) {
      if (ob.cheapest_cents === null) continue;
      for (const ret of returnTrains) {
        if (ret.cheapest_cents === null) continue;
        allCombos.push({
          weekend: { friday, sunday },
          outbound: ob,
          return: ret,
          total_cents: ob.cheapest_cents + ret.cheapest_cents,
        });
      }
    }
  }

  // Top 5 cheapest combos overall
  allCombos.sort((a, b) => a.total_cents - b.total_cents);
  const best_combos = allCombos.slice(0, 5);

  res.json({ weekends, best_combos, ...(errors.length ? { errors } : {}) });
});

function nextNFridays(n: number, from: Date = new Date()): string[] {
  const results: string[] = [];
  const d = new Date(from);
  // Advance to next Friday (day 5)
  const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilFriday);
  for (let i = 0; i < n; i++) {
    results.push(toYMD(d));
    d.setDate(d.getDate() + 7);
  }
  return results;
}

function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return toYMD(d);
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function filterByHour(trains: Train[], minHour: number): Train[] {
  return trains.filter((t) => {
    const hour = parseInt(t.departs_at.slice(11, 13), 10);
    return hour >= minHour;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default router;
