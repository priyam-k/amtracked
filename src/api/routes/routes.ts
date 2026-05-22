import { Router, Request, Response } from 'express';
import { getRoutes, upsertRoute, deleteRoute } from '../../db/queries';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(getRoutes());
});

router.post('/', (req: Request, res: Response) => {
  const body = req.body as { origin?: string | string[]; destination?: string | string[] };
  const origin = Array.isArray(body.origin) ? body.origin[0] : body.origin;
  const destination = Array.isArray(body.destination) ? body.destination[0] : body.destination;
  if (!origin || !destination) {
    res.status(400).json({ error: 'origin and destination are required' });
    return;
  }
  const route = upsertRoute(String(origin).toUpperCase(), String(destination).toUpperCase());
  res.status(201).json(route);
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  deleteRoute(id);
  res.status(204).send();
});

export default router;
