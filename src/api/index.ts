import express from 'express';
import searchRouter from './routes/search';
import snapshotsRouter from './routes/snapshots';
import routesRouter from './routes/routes';
import alertsRouter from './routes/alerts';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/search', searchRouter);
  app.use('/snapshots', snapshotsRouter);
  app.use('/routes', routesRouter);
  app.use('/alerts', alertsRouter);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  return app;
}
