import { getDb } from './client';
import { PriceSnapshot, Route, SearchResult, Train } from '../types';

// ─── Routes ─────────────────────────────────────────────────────────────────

export function upsertRoute(origin: string, destination: string): Route {
  const db = getDb();
  db.prepare(`
    INSERT INTO routes (origin, destination)
    VALUES (?, ?)
    ON CONFLICT(origin, destination) DO NOTHING
  `).run(origin, destination);

  return db.prepare('SELECT * FROM routes WHERE origin = ? AND destination = ?')
    .get(origin, destination) as Route;
}

export function getRoutes(): Route[] {
  return getDb().prepare('SELECT * FROM routes ORDER BY created_at DESC').all() as Route[];
}

export function deleteRoute(id: number): void {
  getDb().prepare('DELETE FROM routes WHERE id = ?').run(id);
}

// ─── Price Snapshots ─────────────────────────────────────────────────────────

export function saveSnapshot(result: SearchResult): PriceSnapshot {
  const db = getDb();
  const minPrice = result.trains.reduce<number | null>((min, t) => {
    if (t.cheapest_cents === null) return min;
    return min === null ? t.cheapest_cents : Math.min(min, t.cheapest_cents);
  }, null);

  const stmt = db.prepare(`
    INSERT INTO price_snapshots (origin, destination, travel_date, scraped_at, trains, min_price_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    result.origin,
    result.destination,
    result.travel_date,
    result.scraped_at,
    JSON.stringify(result.trains),
    minPrice
  );

  return getDb().prepare('SELECT * FROM price_snapshots WHERE id = ?')
    .get(info.lastInsertRowid) as PriceSnapshot;
}

export function getSnapshots(
  origin: string,
  destination: string,
  opts: {
    travel_date?: string;
    max_price_cents?: number;
    sort?: 'price_asc' | 'price_desc' | 'date_desc';
    limit?: number;
  } = {}
): PriceSnapshot[] {
  const { travel_date, max_price_cents, sort = 'date_desc', limit = 50 } = opts;

  let sql = 'SELECT * FROM price_snapshots WHERE origin = ? AND destination = ?';
  const params: (string | number)[] = [origin, destination];

  if (travel_date) {
    sql += ' AND travel_date = ?';
    params.push(travel_date);
  }
  if (max_price_cents !== undefined) {
    sql += ' AND min_price_cents <= ?';
    params.push(max_price_cents);
  }

  const orderMap = {
    price_asc: 'min_price_cents ASC NULLS LAST',
    price_desc: 'min_price_cents DESC NULLS LAST',
    date_desc: 'scraped_at DESC',
  };
  sql += ` ORDER BY ${orderMap[sort]} LIMIT ${limit}`;

  const rows = getDb().prepare(sql).all(...params) as Array<PriceSnapshot & { trains: string }>;
  return rows.map((r) => ({ ...r, trains: JSON.parse(r.trains) as Train[] }));
}

export function getLatestSnapshot(
  origin: string,
  destination: string,
  travel_date: string
): PriceSnapshot | null {
  const row = getDb().prepare(`
    SELECT * FROM price_snapshots
    WHERE origin = ? AND destination = ? AND travel_date = ?
    ORDER BY scraped_at DESC LIMIT 1
  `).get(origin, destination, travel_date) as (PriceSnapshot & { trains: string }) | undefined;

  if (!row) return null;
  return { ...row, trains: JSON.parse(row.trains) as Train[] };
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export function getAlerts() {
  return getDb().prepare('SELECT * FROM alerts WHERE active = 1').all();
}
