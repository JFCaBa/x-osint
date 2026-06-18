import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import { loadConfig } from '../src/config.js';

function setup() {
  const config = loadConfig({ X_OSINT_PASSWORD: 'pw' });
  const repo = createRepo(openDb(':memory:'));
  const triggerFetch = vi.fn();
  const app = createApp({ config, repo, triggerFetch });
  return { app, repo, triggerFetch };
}

async function tokenFor(app: ReturnType<typeof setup>['app']): Promise<string> {
  const res = await request(app).post('/api/login').send({ password: 'pw' });
  return res.body.token as string;
}

describe('routes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('health needs no auth', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('rejects wrong password and accepts the right one', async () => {
    expect((await request(ctx.app).post('/api/login').send({ password: 'nope' })).status).toBe(401);
    const ok = await request(ctx.app).post('/api/login').send({ password: 'pw' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');
  });

  it('blocks unauthenticated access to accounts', async () => {
    expect((await request(ctx.app).get('/api/accounts')).status).toBe(401);
  });

  it('does full account CRUD with a token', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    const created = await auth(request(ctx.app).post('/api/accounts').send({ handle: '@Alice' }));
    expect(created.status).toBe(201);
    expect(created.body.handle).toBe('alice'); // normalized

    expect((await auth(request(ctx.app).post('/api/accounts').send({ handle: 'alice' }))).status).toBe(409);

    const list = await auth(request(ctx.app).get('/api/accounts'));
    expect(list.body).toHaveLength(1);

    const patched = await auth(request(ctx.app).patch('/api/accounts/alice').send({ enabled: false }));
    expect(patched.body.enabled).toBe(false);

    expect((await auth(request(ctx.app).delete('/api/accounts/alice'))).status).toBe(204);
    expect((await auth(request(ctx.app).delete('/api/accounts/alice'))).status).toBe(404);
  });

  it('triggers a fetch', async () => {
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).post('/api/fetch').set('Authorization', `Bearer ${token}`);
    expect(res.body.started).toBe(true);
    expect(ctx.triggerFetch).toHaveBeenCalledOnce();
  });

  it('lists posts with filters', async () => {
    ctx.repo.upsertPosts([
      { id: '1', handle: 'alice', text: 'missile', url: null, media_url: null, posted_at: '2026-06-10T00:00:00.000Z', fetched_at: '2026-06-10T00:00:00.000Z' },
      { id: '2', handle: 'bob', text: 'weather', url: null, media_url: null, posted_at: '2026-06-15T00:00:00.000Z', fetched_at: '2026-06-15T00:00:00.000Z' },
    ]);
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/posts?handle=alice').set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('1');
  });
});
