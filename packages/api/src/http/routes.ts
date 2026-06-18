import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../types.js';
import type { createRepo } from '../store/repo.js';
import { signToken, comparePassword } from '../auth/token.js';
import { makeAuthMiddleware } from './authMiddleware.js';

type Repo = ReturnType<typeof createRepo>;

const handleSchema = z.object({ handle: z.string().min(1).max(50) });
const enabledSchema = z.object({ enabled: z.boolean() });

function normalizeHandle(h: string): string {
  return h.replace(/^@/, '').trim().toLowerCase();
}

export function createRoutes(config: Config, repo: Repo, triggerFetch: () => void): Router {
  const router = Router();
  const auth = makeAuthMiddleware(config.tokenSecret);

  router.get('/health', (_req: Request, res: Response) => { res.json({ status: 'ok' }); });

  router.post('/login', (req: Request, res: Response) => {
    const body = z.object({ password: z.string() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'password required' }); return; }
    if (!comparePassword(body.data.password, config.password)) {
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    res.json({ token: signToken(config.tokenSecret, config.tokenTtlDays) });
  });

  router.get('/accounts', auth, (_req: Request, res: Response) => {
    res.json(repo.listAccounts());
  });

  router.post('/accounts', auth, (req: Request, res: Response) => {
    const body = handleSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'handle required' }); return; }
    const handle = normalizeHandle(body.data.handle);
    if (!handle) { res.status(400).json({ error: 'handle required' }); return; }
    if (repo.listAccounts().some(a => a.handle === handle)) {
      res.status(409).json({ error: 'already exists' });
      return;
    }
    res.status(201).json(repo.addAccount(handle));
  });

  router.patch('/accounts/:handle', auth, (req: Request, res: Response) => {
    const body = enabledSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'enabled required' }); return; }
    const updated = repo.setAccountEnabled(normalizeHandle(req.params.handle as string), body.data.enabled);
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    res.json(updated);
  });

  router.delete('/accounts/:handle', auth, (req: Request, res: Response) => {
    const ok = repo.removeAccount(normalizeHandle(req.params.handle as string));
    if (!ok) { res.status(404).json({ error: 'not found' }); return; }
    res.status(204).end();
  });

  router.get('/posts', auth, (req: Request, res: Response) => {
    const q = req.query;
    res.json(repo.listPosts({
      handle: typeof q.handle === 'string' ? normalizeHandle(q.handle) : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      since: typeof q.since === 'string' ? q.since : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    }));
  });

  router.post('/fetch', auth, (_req: Request, res: Response) => {
    triggerFetch();
    res.json({ started: true });
  });

  return router;
}
