/**
 * Direct API approach: makes the Amtrak search API call from within the Playwright browser
 * context (using page.evaluate + fetch), which uses Chromium's TLS fingerprint and
 * session cookies — avoiding the headless bot detection on the browser level.
 *
 * Endpoint discovered by intercepting Angular's POST request:
 *   POST https://www.amtrak.com/dotcom/journey-solution-option
 */
import { Page } from 'playwright';
import { FareOption, SearchParams, SearchResult, Train } from '../types';

export async function searchViaApi(page: Page, params: SearchParams): Promise<SearchResult> {
  const [year, month, day] = params.travel_date.split('-');
  const departureDateTime = `${year}-${month}-${day}T00:00:00`;
  const passengers = params.passengers ?? 1;

  const passengerList = Array.from({ length: passengers }, (_, i) => ({
    id: `P${i + 1}`,
    type: 'F',
    initialType: 'adult',
  }));

  const requestBody = {
    journeyRequest: {
      fare: { pricingUnit: 'DOLLARS' },
      type: 'OW',
      journeyLegRequests: [
        {
          origin: {
            code: params.origin,
            schedule: { departureDateTime },
          },
          destination: { code: params.destination },
          passengers: passengerList,
        },
      ],
      customer: { tierStatus: 'MEMBER' },
      isPassRider: false,
      isCorporateTraveller: false,
      tripTags: true,
      singleAdultFare: passengers === 1,
      cascadesWSDOTFilter: false,
      xDelay: '60',
    },
    initialJourneyLegOnly: false,
    reservableAccomodationOptions: 'ALL',
  };

  // Get CSRF token and generate trace ID (Angular includes these in the request)
  const sessionInfo = await page.evaluate(async () => {
    // Try to get CSRF token from the page or cookies
    let csrfToken: string | undefined;
    try {
      const resp = await fetch('/libs/granite/csrf/token.json');
      const data = await resp.json();
      csrfToken = data.token ?? data['granite-csrf-token'] ?? undefined;
    } catch {}
    if (!csrfToken) {
      // Check cookies for CSRF token
      const cookies = document.cookie.split(';');
      const csrfCookie = cookies.find((c) => c.trim().startsWith('CSRF-Token='));
      csrfToken = csrfCookie?.split('=')[1];
    }
    // Generate trace ID: UUID-like hex + timestamp (format from captured request)
    const hex = () => Math.random().toString(16).slice(2);
    const traceId = hex() + hex() + hex() + Date.now();
    return { csrfToken, traceId };
  });

  console.log('[api] Session info:', JSON.stringify({ csrfToken: sessionInfo.csrfToken ? '[set]' : '[missing]', traceId: sessionInfo.traceId }));
  console.log('[api] Calling journey-solution-option...');

  const result = await page.evaluate(async ({ body, traceId, csrfToken }) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'x-amtrak-trace-id': traceId,
    };
    if (csrfToken) headers['csrf-token'] = csrfToken;

    try {
      const resp = await fetch('https://www.amtrak.com/dotcom/journey-solution-option', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const text = await resp.text();
      return { status: resp.status, ok: resp.ok, body: text };
    } catch (e) {
      return { status: 0, ok: false, body: String(e) };
    }
  }, { body: requestBody, traceId: sessionInfo.traceId, csrfToken: sessionInfo.csrfToken });

  console.log(`[api] Response status: ${result.status}`);

  if (!result.ok || result.status === 403) {
    console.warn(`[api] API blocked (${result.status}). Body: ${result.body.slice(0, 200)}`);
    return emptyResult(params);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    console.warn('[api] Could not parse response JSON:', result.body.slice(0, 200));
    return emptyResult(params);
  }

  const trains = parseJourneyResponse(parsed);
  console.log(`[api] Parsed ${trains.length} train(s) from API response`);

  return {
    origin: params.origin,
    destination: params.destination,
    travel_date: params.travel_date,
    scraped_at: new Date().toISOString(),
    trains,
  };
}

function emptyResult(params: SearchParams): SearchResult {
  return {
    origin: params.origin,
    destination: params.destination,
    travel_date: params.travel_date,
    scraped_at: new Date().toISOString(),
    trains: [],
  };
}

// ─── Parse the journey-solution-option response ──────────────────────────────

function parseJourneyResponse(raw: unknown): Train[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // Expected structure (to be refined once we get a successful response):
  // { journeyLegs: [{ journeyOptions: [{ travelLegs: [...], fares: {...} }] }] }
  // OR: { solutions: [...] }
  // OR: some other structure

  const legs = (obj.journeyLegs as unknown[]) ?? (obj.solutions as unknown[]) ?? (obj.results as unknown[]) ?? [];

  if (legs.length === 0) {
    // Log top-level keys to help understand the response structure
    console.log('[api] Response top-level keys:', Object.keys(obj).join(', '));
    // Try treating raw as an array
    if (Array.isArray(raw)) {
      return (raw as Record<string, unknown>[]).map(parseJourneyOption);
    }
    return [];
  }

  const trains: Train[] = [];
  for (const leg of legs as Record<string, unknown>[]) {
    const options = (leg.journeyOptions as unknown[]) ?? (leg.options as unknown[]) ?? [leg];
    for (const opt of options as Record<string, unknown>[]) {
      trains.push(parseJourneyOption(opt));
    }
  }
  return trains;
}

function parseJourneyOption(opt: Record<string, unknown>): Train {
  const fares = parseFaresFromOption(opt);
  const cheapest = fares
    .filter((f) => f.available && f.price_cents !== null)
    .reduce<number | null>((min, f) => {
      if (f.price_cents === null) return min;
      return min === null ? f.price_cents : Math.min(min, f.price_cents);
    }, null);

  // Try various field names for train number and name
  const number = String(
    opt.trainNumber ?? opt.number ?? opt.trainNum ?? opt.serviceId ?? opt.legId ?? ''
  );
  const name = String(opt.trainName ?? opt.name ?? opt.routeName ?? opt.serviceDescription ?? '');
  const departs = String(
    opt.departureDateTime ?? opt.departs ?? opt.originDepartureTime ?? opt.departTime ?? ''
  );
  const arrives = String(
    opt.arrivalDateTime ?? opt.arrives ?? opt.destArrivalTime ?? opt.arrivalTime ?? ''
  );

  return {
    number,
    name,
    departs_at: departs,
    arrives_at: arrives,
    duration_minutes: parseDurationFromOption(opt),
    fares,
    cheapest_cents: cheapest,
  };
}

function parseFaresFromOption(opt: Record<string, unknown>): FareOption[] {
  const rawFares =
    (opt.fares as unknown[]) ??
    (opt.fareOptions as unknown[]) ??
    (opt.prices as unknown[]) ??
    [];

  return rawFares.map((f) => {
    const fare = f as Record<string, unknown>;
    const price = parsePrice(fare.price ?? fare.amount ?? fare.totalPrice ?? fare.lowestFare);
    return {
      fare_class: String(fare.class ?? fare.fareClass ?? fare.type ?? fare.classCode ?? ''),
      fare_type: String(fare.fareType ?? fare.tier ?? fare.bucketCode ?? 'Standard'),
      price_cents: price,
      available: price !== null && (fare.available as boolean) !== false && (fare.soldOut as boolean) !== true,
    };
  });
}

function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'N/A') return null;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (isNaN(num) || num <= 0) return null;
  return num < 10000 ? Math.round(num * 100) : Math.round(num);
}

function parseDurationFromOption(opt: Record<string, unknown>): number {
  const raw = opt.travelTime ?? opt.duration ?? opt.durationMinutes;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const hm = raw.match(/(\d+)h\s*(\d+)?m?/);
    if (hm) return parseInt(hm[1]) * 60 + parseInt(hm[2] ?? '0');
    const mins = parseInt(raw);
    if (!isNaN(mins)) return mins;
  }
  return 0;
}
