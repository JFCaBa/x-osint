import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import type { Post } from '../src/types.js';

function makePost(id: string, handle: string, postedAt: string, text = 'hello world'): Post {
  return { id, handle, text, url: `https://x.com/${handle}/status/${id}`, media_url: null, posted_at: postedAt, fetched_at: '2026-06-18T00:00:00.000Z' };
}

describe('repo', () => {
  let repo: ReturnType<typeof createRepo>;
  beforeEach(() => { repo = createRepo(openDb(':memory:')); });

  it('adds, lists, toggles, and removes accounts', () => {
    const a = repo.addAccount('handle1');
    expect(a.handle).toBe('handle1');
    expect(a.enabled).toBe(true);
    expect(repo.listAccounts()).toHaveLength(1);
    expect(repo.getEnabledHandles()).toEqual(['handle1']);

    const toggled = repo.setAccountEnabled('handle1', false);
    expect(toggled?.enabled).toBe(false);
    expect(repo.getEnabledHandles()).toEqual([]);

    expect(repo.removeAccount('handle1')).toBe(true);
    expect(repo.listAccounts()).toHaveLength(0);
  });

  it('records account fetch status', () => {
    repo.addAccount('h');
    repo.setAccountStatus('h', 'error', '2026-06-18T01:00:00.000Z');
    const acc = repo.listAccounts()[0];
    expect(acc.last_status).toBe('error');
    expect(acc.last_fetched_at).toBe('2026-06-18T01:00:00.000Z');
  });

  it('upserts posts idempotently by id', () => {
    const inserted1 = repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    expect(inserted1).toBe(1);
    const inserted2 = repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    expect(inserted2).toBe(0);
    expect(repo.listPosts({})).toHaveLength(1);
  });

  it('lists posts newest first and filters by handle, q, since, limit', () => {
    repo.upsertPosts([
      makePost('1', 'alice', '2026-06-10T00:00:00.000Z', 'missile launch'),
      makePost('2', 'bob', '2026-06-15T00:00:00.000Z', 'weather report'),
      makePost('3', 'alice', '2026-06-18T00:00:00.000Z', 'drone sighting'),
    ]);
    expect(repo.listPosts({}).map(p => p.id)).toEqual(['3', '2', '1']);
    expect(repo.listPosts({ handle: 'alice' }).map(p => p.id)).toEqual(['3', '1']);
    expect(repo.listPosts({ q: 'drone' }).map(p => p.id)).toEqual(['3']);
    expect(repo.listPosts({ since: '2026-06-12T00:00:00.000Z' }).map(p => p.id)).toEqual(['3', '2']);
    expect(repo.listPosts({ limit: 1 }).map(p => p.id)).toEqual(['3']);
  });

  it('prunes posts older than retention window', () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const recent = new Date().toISOString();
    repo.upsertPosts([makePost('old', 'h', old), makePost('new', 'h', recent)]);
    const removed = repo.pruneOldPosts(30);
    expect(removed).toBe(1);
    expect(repo.listPosts({}).map(p => p.id)).toEqual(['new']);
  });
});

describe('repo AI + exports', () => {
  let repo: ReturnType<typeof createRepo>;
  beforeEach(() => { repo = createRepo(openDb(':memory:')); });

  it('lists posts needing AI and updates them', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    expect(repo.listPostsNeedingAi(10)).toHaveLength(1);

    repo.setPostAi('1', { status: 'done', match: true, angles: ['money', 'business'], textPt: 'olá' });
    expect(repo.listPostsNeedingAi(10)).toHaveLength(0);

    const [p] = repo.listPosts({});
    expect(p.angle_match).toBe(1);
    expect(p.angles).toBe('money,business');
    expect(p.text_pt).toBe('olá');
  });

  it('re-queues errored posts for AI', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'error' });
    expect(repo.listPostsNeedingAi(10)).toHaveLength(1);
  });

  it('filters posts by angleOnly', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z'), makePost('2', 'h', '2026-06-19T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    repo.setPostAi('2', { status: 'done', match: false, angles: [] });
    expect(repo.listPosts({ angleOnly: true }).map(p => p.id)).toEqual(['1']);
    expect(repo.listPosts({})).toHaveLength(2);
  });

  it('exports since last export and records progress', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z'), makePost('2', 'h', '2026-06-20T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'a' });
    repo.setPostAi('2', { status: 'done', match: true, angles: ['business'], textPt: 'b' });

    expect(repo.getExportState()).toEqual({ lastExportAt: null, coveredUpto: null });
    const all = repo.listExportablePosts({ mode: 'since-last' });
    expect(all.map(p => p.id)).toEqual(['1', '2']); // chronological

    repo.recordExport({ coveredUpto: '2026-06-18T00:00:00.000Z', rowCount: 1 });
    const since = repo.listExportablePosts({ mode: 'since-last' });
    expect(since.map(p => p.id)).toEqual(['2']);
    expect(repo.getExportState().coveredUpto).toBe('2026-06-18T00:00:00.000Z');
  });

  it('exports a date range inclusive of bounds', () => {
    repo.upsertPosts([
      makePost('1', 'h', '2026-06-10T00:00:00.000Z'),
      makePost('2', 'h', '2026-06-15T12:00:00.000Z'),
      makePost('3', 'h', '2026-06-20T00:00:00.000Z'),
    ]);
    for (const id of ['1', '2', '3']) repo.setPostAi(id, { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    const r = repo.listExportablePosts({ mode: 'range', from: '2026-06-15T00:00:00.000Z', to: '2026-06-16T00:00:00.000Z' });
    expect(r.map(p => p.id)).toEqual(['2']);
  });

  it('stores null for an empty angles array', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: [], textPt: 'x' });
    expect(repo.listPosts({})[0].angles).toBeNull();
  });
});
