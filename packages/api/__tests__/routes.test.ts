import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
// Register xlsx content-type with the binary (image) parser so supertest returns
// res.body as a Buffer instead of an empty object for xlsx responses.
// (supertest calls .buffer() in its constructor which forces buffer=true; without
//  an explicit parser registered, superagent falls through to the text parser.)
import superagent from 'superagent';
(superagent as any).parse['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] =
  (superagent as any).parse.image;
import { createApp } from '../src/http/app.js';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import { loadConfig } from '../src/config.js';

function setup() {
  const config = loadConfig({ X_OSINT_PASSWORD: 'pw' });
  const repo = createRepo(openDb(':memory:'));
  const triggerFetch = vi.fn();
  const app = createApp({ config, repo, triggerFetch, aiAvailable: true });
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

describe('reports routes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  async function seedMatch(id: string, postedAt: string) {
    ctx.repo.upsertPosts([{ id, handle: 'alice', text: `t${id}`, url: `https://x.com/alice/status/${id}`, media_url: null, posted_at: postedAt, fetched_at: postedAt }]);
    ctx.repo.setPostAi(id, { status: 'done', match: true, angles: ['money'], textPt: `pt${id}` });
  }

  it('summary counts matching posts and reports aiAvailable', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const res = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.lastExportAt).toBeNull();
    expect(typeof res.body.aiAvailable).toBe('boolean');
  });

  it('export returns an xlsx and advances since-last', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const res = await auth(request(ctx.app).post('/api/reports/export').send({ mode: 'since-last' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Buffer.isBuffer(res.body) || res.body.length > 0).toBeTruthy();
    // a second since-last summary now shows 0 (export advanced covered_upto)
    const after = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(after.body.count).toBe(0);
    expect(after.body.lastExportAt).not.toBeNull();
  });

  it('filters /posts by angleOnly', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    ctx.repo.upsertPosts([{ id: '2', handle: 'alice', text: 't2', url: null, media_url: null, posted_at: '2026-06-19T00:00:00.000Z', fetched_at: '2026-06-19T00:00:00.000Z' }]);
    ctx.repo.setPostAi('2', { status: 'done', match: false, angles: [] });
    const all = await auth(request(ctx.app).get('/api/posts'));
    expect(all.body).toHaveLength(2);
    const only = await auth(request(ctx.app).get('/api/posts?angleOnly=true'));
    expect(only.body.map((p: { id: string }) => p.id)).toEqual(['1']);
  });
});

describe('settings routes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('GET /settings returns the default filters', async () => {
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.filters.map((f: { label: string }) => f.label)).toEqual(['money', 'entrepreneurship', 'business', 'economy']);
  });

  it('PUT /settings saves valid filters', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const ok = await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'tech', color: '#112233', emoji: '🤖' }] }));
    expect(ok.status).toBe(200);
    expect(ok.body.filters).toEqual([{ label: 'tech', color: '#112233', emoji: '🤖' }]);
    const got = await auth(request(ctx.app).get('/api/settings'));
    expect(got.body.filters[0].label).toBe('tech');
  });

  it('PUT /settings rejects invalid input', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [] }))).status).toBe(400);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'x', color: 'red', emoji: '' }] }))).status).toBe(400);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'a', color: '#111111', emoji: '' }, { label: 'A', color: '#222222', emoji: '' }] }))).status).toBe(400);
  });

  it('POST /settings/reclassify resets posts and returns the queued count', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    ctx.repo.upsertPosts([{ id: '1', handle: 'h', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' }]);
    ctx.repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    const res = await auth(request(ctx.app).post('/api/settings/reclassify'));
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
    expect(ctx.repo.listPostsNeedingAi(10)).toHaveLength(1);
  });
});
