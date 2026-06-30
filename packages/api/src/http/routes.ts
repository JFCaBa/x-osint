import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../types.js';
import type { createRepo } from '../store/repo.js';
import { signToken, comparePassword } from '../auth/token.js';
import { makeAuthMiddleware } from './authMiddleware.js';
import { buildWorkbookBuffer } from '../reports/excel.js';

type Repo = ReturnType<typeof createRepo>;

const handleSchema = z.object({ handle: z.string().min(1).max(50) });
const enabledSchema = z.object({ enabled: z.boolean() });

function normalizeHandle(h: string): string {
  return h.replace(/^@/, '').trim().toLowerCase();
}

const reportParamsSchema = z.object({
  mode: z.enum(['since-last', 'range']).default('since-last'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export function createRoutes(config: Config, repo: Repo, triggerFetch: () => void, aiAvailable = false): Router {
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
    const rawLimit = typeof q.limit === 'string' ? Number(q.limit) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    res.json(repo.listPosts({
      handle: typeof q.handle === 'string' ? normalizeHandle(q.handle) : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      since: typeof q.since === 'string' ? q.since : undefined,
      limit,
      angleOnly: q.angleOnly === 'true',
    }));
  });

  router.post('/fetch', auth, (_req: Request, res: Response) => {
    triggerFetch();
    res.json({ started: true });
  });

  router.get('/reports/summary', auth, (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse({
      mode: req.query.mode, from: req.query.from, to: req.query.to,
    });
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const posts = repo.listExportablePosts(parsed.data);
    const { lastExportAt } = repo.getExportState();
    res.json({ count: posts.length, lastExportAt, aiAvailable });
  });

  router.post('/reports/export', auth, async (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const posts = repo.listExportablePosts(parsed.data);
    const buffer = await buildWorkbookBuffer(posts, config.reportTz);
    const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
    repo.recordExport({ coveredUpto, rowCount: posts.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="x-osint-report.xlsx"');
    res.send(buffer);
  });

  return router;
}
