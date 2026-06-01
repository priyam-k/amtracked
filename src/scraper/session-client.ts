/**
 * Direct HTTP client for the Amtrak search API.
 * Uses Akamai-validated session cookies captured from a real browser session
 * (either manually pasted via AMTRAK_COOKIES env var, auto-extracted from Playwright,
 * or eventually captured by a Chrome extension).
 *
 * No Playwright needed — just a plain fetch with the right cookies + headers.
 */
import { SearchParams, SearchResult } from '../types';
import { parseAmtrakResponse } from './amtrak';

const SEARCH_URL = 'https://www.amtrak.com/dotcom/journey-solution-option';

function makeTraceId(): string {
  // x-amtrak-trace-id format: 36 hex chars + timestamp ms (confirmed from captured requests)
  const hex = () => Math.random().toString(16).slice(2).padEnd(9, '0');
  return hex() + hex() + hex() + hex() + Date.now();
}

function buildRequestBody(params: SearchParams): object {
  const [year, month, day] = params.travel_date.split('-');
  const departureDateTime = `${year}-${month}-${day}T00:00:00`;
  const passengers = params.passengers ?? 1;

  return {
    journeyRequest: {
      fare: { pricingUnit: 'DOLLARS' },
      type: 'OW',
      journeyLegRequests: [
        {
          origin: { code: params.origin, schedule: { departureDateTime } },
          destination: { code: params.destination },
          passengers: Array.from({ length: passengers }, (_, i) => ({
            id: `P${i + 1}`,
            type: 'F',
            initialType: 'adult',
          })),
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
}

export async function searchWithSession(
  cookieHeader: string,
  params: SearchParams
): Promise<SearchResult> {
  const body = buildRequestBody(params);
  const traceId = makeTraceId();

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);

  let resp: Response;
  try {
    resp = await fetch(SEARCH_URL, {
      method: 'POST',
      signal: abort.signal,
      headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://www.amtrak.com',
      'referer': 'https://www.amtrak.com/tickets/departure.html',
      'cookie': cookieHeader,
      'x-amtrak-trace-id': traceId,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", ";Not A Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(body),
  });
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = (err as Error).name === 'AbortError';
    throw new Error(isTimeout ? 'Request timed out (15s) — session may be exhausted' : String(err));
  }
  clearTimeout(timeout);

  console.log(`[session-client] HTTP ${resp.status} for ${params.origin}→${params.destination} ${params.travel_date}`);

  if (!resp.ok) {
    const errText = await resp.text();
    const isSessionDead = errText.includes('Access Denied') || errText.includes('Reference #')
      || errText.includes('502 Bad Gateway') || errText.includes('Error Page');
    throw new Error(
      isSessionDead
        ? `Akamai blocked the request (${resp.status}) — session cookies may have expired`
        : `HTTP ${resp.status}: ${errText.slice(0, 200)}`
    );
  }

  const rawText = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Response was not JSON: ${rawText.slice(0, 200)}`);
  }

  const trains = parseAmtrakResponse(json);
  console.log(`[session-client] Parsed ${trains.length} train(s)`);

  if (trains.length === 0) {
    // Log enough of the structure to diagnose parser mismatches
    const obj = json as Record<string, unknown>;
    const topKeys = Object.keys(obj).join(', ');
    const dataKeys = obj.data && typeof obj.data === 'object'
      ? Object.keys(obj.data as object).join(', ')
      : '(no data key)';
    console.warn(`[session-client] 0 trains parsed. Top keys: [${topKeys}] | data keys: [${dataKeys}]`);
    console.warn(`[session-client] Raw snippet: ${rawText.slice(0, 400)}`);
  }

  return {
    origin: params.origin,
    destination: params.destination,
    travel_date: params.travel_date,
    scraped_at: new Date().toISOString(),
    trains,
  };
}
