import { Router, Request, Response } from 'express';
import { getSnapshots } from '../../db/queries';

const router = Router();

/**
 * GET /snapshots?origin=NYP&destination=WAS&date=2026-07-15&sort=price_asc&max_price=5000&limit=20
 */
router.get('/', (req: Request, res: Response) => {
  const { origin, destination, date, sort, max_price, limit } = req.query as Record<string, string | undefined>;

  if (!origin || !destination) {
    res.status(400).json({ error: 'origin and destination are required' });
    return;
  }

  const validSorts = ['price_asc', 'price_desc', 'date_desc'] as const;
  const sortParam = validSorts.includes(sort as never) ? (sort as typeof validSorts[number]) : 'date_desc';

  const snapshots = getSnapshots(origin.toUpperCase(), destination.toUpperCase(), {
    travel_date: date,
    max_price_cents: max_price ? parseInt(max_price) : undefined,
    sort: sortParam,
    limit: limit ? parseInt(limit) : 50,
  });

  res.json(snapshots);
});

export default router;
