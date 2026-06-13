import express from 'express';
import path from 'path';
import searchRouter from './routes/search';
import snapshotsRouter from './routes/snapshots';
import routesRouter from './routes/routes';
import alertsRouter from './routes/alerts';
import weekendRouter from './routes/weekend';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/search', searchRouter);
  app.use('/snapshots', snapshotsRouter);
  app.use('/routes', routesRouter);
  app.use('/alerts', alertsRouter);
  app.use('/weekend-roundtrip', weekendRouter);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Serve web UI from public/
  app.use(express.static(path.join(__dirname, '../../public')));

  return app;
}
