import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './store/db.js';
import { createRepo } from './store/repo.js';
import { createScheduler } from './scheduler.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';

function main(): void {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'x-osint.db'));
  const repo = createRepo(db);
  const scheduler = createScheduler({ config, repo });

  // Built SPA lives next to dist/ at runtime: <app>/www
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(here, '..', 'www');

  const app = createApp({ config, repo, triggerFetch: () => scheduler.triggerNow(), staticDir });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'x-osint listening');
    scheduler.start();
  });

  const shutdown = (): void => {
    logger.info('shutting down');
    scheduler.stop();
    server.close(() => { db.close(); process.exit(0); });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
