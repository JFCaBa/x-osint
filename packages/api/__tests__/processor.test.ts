import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import { createAiProcessor } from '../src/ai/processor.js';
import type { AiProvider } from '../src/ai/provider.js';
import type { Post } from '../src/types.js';

function makePost(id: string): Post {
  return { id, handle: 'h', text: `text ${id}`, url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' };
}

function mockProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async (t: string) => ({ match: t.includes('1'), angles: t.includes('1') ? ['money'] : [] })),
    translate: vi.fn(async () => 'traduzido'),
    ...over,
  };
}

describe('aiProcessor', () => {
  it('translates matches and skips translation for non-matches', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1'), makePost('2')]);
    const provider = mockProvider();
    const proc = createAiProcessor({ repo, provider, batchSize: 10 });

    const n = await proc.processBatch();
    expect(n).toBe(2);
    expect(provider.translate).toHaveBeenCalledTimes(1); // only the match

    const posts = repo.listPosts({});
    const p1 = posts.find(p => p.id === '1')!;
    const p2 = posts.find(p => p.id === '2')!;
    expect(p1.angle_match).toBe(1);
    expect(p1.text_pt).toBe('traduzido');
    expect(p2.angle_match).toBe(0);
    expect(p2.text_pt).toBeNull();
    expect(repo.listPostsNeedingAi(10)).toHaveLength(0);
  });

  it('marks a post error when the provider throws', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1')]);
    const provider = mockProvider({ classify: vi.fn(async () => { throw new Error('ollama down'); }) });
    const proc = createAiProcessor({ repo, provider });
    await proc.processBatch();
    const [p] = repo.listPosts({});
    expect(p.ai_status).toBe('error');
  });

  it('processAll drains all pending posts', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts(Array.from({ length: 5 }, (_, i) => makePost(String(i))));
    const proc = createAiProcessor({ repo, provider: mockProvider(), batchSize: 2 });
    await proc.processAll();
    expect(repo.listPostsNeedingAi(99)).toHaveLength(0);
  });
});
