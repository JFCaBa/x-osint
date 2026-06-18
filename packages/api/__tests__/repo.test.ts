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
