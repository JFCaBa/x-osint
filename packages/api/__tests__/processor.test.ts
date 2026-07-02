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
    classify: vi.fn(async (t: string, _labels: string[]) => ({ match: t.includes('1'), angles: t.includes('1') ? ['money'] : [] })),
    translate: vi.fn(async () => 'traduzido'),
    summarize: vi.fn(async () => 'resumo'),
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

  it('passes the configured filter labels to classify', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.setFilters([{ label: 'tech', color: '#111111', emoji: '🤖' }]);
    repo.upsertPosts([makePost('1')]);
    const provider = mockProvider();
    await createAiProcessor({ repo, provider }).processBatch();
    expect(provider.classify).toHaveBeenCalledWith('text 1', ['tech']);
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

  it('processAll terminates when the provider always fails', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts(Array.from({ length: 4 }, (_, i) => makePost(String(i))));
    const provider = mockProvider({ classify: vi.fn(async () => { throw new Error('down'); }) });
    const proc = createAiProcessor({ repo, provider, batchSize: 2 });
    await proc.processAll(); // must not hang
    expect(repo.listPosts({}).every(p => p.ai_status === 'error')).toBe(true);
  });

  it('reports activity: classify then translate per match, classify-only for non-match, null at end', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1'), makePost('2')]); // '1' matches, '2' does not
    // Both posts share the same posted_at, so listPostsNeedingAi's tie-break order
    // (not insertion order) determines processing order — derive it the same way
    // processBatch does, rather than assuming '1' is processed before '2'.
    const order = repo.listPostsNeedingAi(10).map(p => p.id);
    const events: Array<{ handle: string; phase: string } | null> = [];
    const proc = createAiProcessor({ repo, provider: mockProvider(), onActivity: (a) => events.push(a) });
    await proc.processBatch();
    const expected: Array<{ handle: string; phase: string } | null> = order.flatMap(id =>
      id === '1'
        ? [{ handle: 'h', phase: 'classify' }, { handle: 'h', phase: 'translate' }]
        : [{ handle: 'h', phase: 'classify' }],
    );
    expected.push(null);
    expect(events).toEqual(expected);
  });

  it('still emits null (idle) when a classify call throws', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1')]);
    const events: Array<{ handle: string; phase: string } | null> = [];
    const provider = mockProvider({ classify: vi.fn(async () => { throw new Error('down'); }) });
    const proc = createAiProcessor({ repo, provider, onActivity: (a) => events.push(a) });
    await proc.processBatch();
    expect(events[0]).toEqual({ handle: 'h', phase: 'classify' });
    expect(events[events.length - 1]).toBeNull();
  });
});
