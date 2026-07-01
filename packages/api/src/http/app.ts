import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../types.js';
import type { createRepo } from '../store/repo.js';
import { createRoutes } from './routes.js';
import type { AiProvider } from '../ai/provider.js';

type Repo = ReturnType<typeof createRepo>;

export interface AppDeps {
  config: Config;
  repo: Repo;
  triggerFetch: () => void;
  staticDir?: string;
  aiAvailable?: boolean;
  checkAiReady?: () => Promise<boolean>;
  aiProvider?: AiProvider | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(deps.config, deps.repo, deps.triggerFetch, deps.aiAvailable ?? false, deps.checkAiReady, deps.aiProvider ?? null));

  if (deps.staticDir && existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir));
    // SPA fallback: non-/api routes serve index.html
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(join(deps.staticDir!, 'index.html'));
    });
  }
  return app;
}
