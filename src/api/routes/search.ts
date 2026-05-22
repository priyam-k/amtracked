import { Router, Request, Response } from 'express';
import { searchTrains } from '../../scraper/amtrak';
import { saveSnapshot } from '../../db/queries';
import { closeBrowser } from '../../scraper/browser';

const router = Router();

/**
 * POST /search
 * Body: { origin: string, destination: string, travel_date: string (YYYY-MM-DD), save?: boolean, passengers?: number }
 */
router.post('/', async (req: Request, res: Response) => {
  const { origin, destination, travel_date, save = false, passengers = 1 } = req.body as {
    origin?: string;
    destination?: string;
    travel_date?: string;
    save?: boolean;
    passengers?: number;
  };

  if (!origin || !destination || !travel_date) {
    res.status(400).json({ error: 'origin, destination, and travel_date are required' });
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(travel_date)) {
    res.status(400).json({ error: 'travel_date must be YYYY-MM-DD' });
    return;
  }

  try {
    const result = await searchTrains({ origin: origin.toUpperCase(), destination: destination.toUpperCase(), travel_date, passengers });

    if (save) {
      await saveSnapshot(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: 'Search failed', detail: String(err) });
  } finally {
    // Close browser after each search to free memory; next request will reopen
    await closeBrowser();
  }
});

export default router;
