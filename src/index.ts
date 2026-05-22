import 'dotenv/config';
import { createApp } from './api/index';
import { getDb } from './db/client';
import { startScheduler } from './scheduler/index';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Initialize DB
getDb();
console.log('[db] SQLite database ready');

// Start scheduler
startScheduler();

// Start server
const app = createApp();
app.listen(PORT, () => {
  console.log(`[server] amtracked running on http://localhost:${PORT}`);
  console.log('[server] Endpoints:');
  console.log('[server]   POST /search          - search trains (triggers scraper)');
  console.log('[server]   GET  /snapshots        - query historical price snapshots');
  console.log('[server]   GET  /routes           - list saved routes');
  console.log('[server]   POST /routes           - add a saved route');
  console.log('[server]   DELETE /routes/:id     - remove a saved route');
});
