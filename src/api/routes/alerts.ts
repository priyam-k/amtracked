import { Router, Request, Response } from 'express';
import { createAlert, deleteAlert, getAlerts, upsertRoute } from '../../db/queries';

const router = Router();

// GET /alerts — list all alerts (with route info via join in future; for now return alert rows)
router.get('/', (_req: Request, res: Response) => {
  res.json(getAlerts());
});

// POST /alerts — create an alert
// Body: { origin, destination, travel_date, max_price_cents, notify_method? }
// Auto-creates the route if it doesn't exist.
router.post('/', (req: Request, res: Response) => {
  const { origin, destination, travel_date, max_price_cents, notify_method } =
    req.body as Record<string, unknown>;

  if (!origin || !destination || !travel_date || max_price_cents === undefined) {
    res.status(400).json({ error: 'origin, destination, travel_date, and max_price_cents are required' });
    return;
  }

  const priceCents = Number(max_price_cents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    res.status(400).json({ error: 'max_price_cents must be a positive number' });
    return;
  }

  const route = upsertRoute(String(origin).toUpperCase(), String(destination).toUpperCase());
  const alert = createAlert(
    route.id,
    String(travel_date),
    priceCents,
    notify_method ? String(notify_method) : 'console'
  );

  res.status(201).json({ alert, route });
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  deleteAlert(id);
  res.status(204).send();
});

export default router;
