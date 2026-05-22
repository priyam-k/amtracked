import { Router, Request, Response } from 'express';

const router = Router();

// Alert CRUD — stubbed for Phase 3
router.get('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Alerts not yet implemented (Phase 3)' });
});

router.post('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Alerts not yet implemented (Phase 3)' });
});

router.delete('/:id', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Alerts not yet implemented (Phase 3)' });
});

export default router;
