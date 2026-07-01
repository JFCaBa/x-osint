import { describe, it, expect, vi } from 'vitest';
import { buildAnalysisMarkdown } from '../src/reports/analysis.js';
import type { Post } from '../src/types.js';
import type { AiProvider } from '../src/ai/provider.js';

function post(over: Partial<Post>): Post {
  return {
    id: '1', handle: 'alice', text: 'orig text', url: 'https://x.com/alice/status/1',
    media_url: null, posted_at: '2026-06-18T13:30:00.000Z', fetched_at: '2026-06-18T13:30:00.000Z',
    text_pt: 'texto traduzido', angle_match: 1, angles: 'money', ...over,
  };
}

function stubProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async () => ({ match: false, angles: [] })),
    translate: vi.fn(async (t: string) => `PT(${t})`),
    summarize: vi.fn(async () => 'English summary.'),
    ...over,
  };
}

const FILTERS = [
  { label: 'money', color: '#111111', emoji: '' },
  { label: 'business', color: '#222222', emoji: '' },
];

describe('buildAnalysisMarkdown', () => {
  it('renders EN then PT sections with per-tag narrative and stats', async () => {
    const posts = [
      post({ id: '1', handle: 'alice', angles: 'money', posted_at: '2026-06-18T00:00:00.000Z' }),
      post({ id: '2', handle: 'bob', angles: 'money', posted_at: '2026-06-20T00:00:00.000Z' }),
    ];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    const enIdx = md.indexOf('# Analysis (English)');
    const ptIdx = md.indexOf('# Análise (Português)');
    expect(enIdx).toBeGreaterThanOrEqual(0);
    expect(ptIdx).toBeGreaterThan(enIdx);
    expect(md).toContain('## money');
    expect(md).toContain('2 posts · 2 accounts · 2026-06-18–2026-06-20');
    expect(md).toContain('English summary.');
    expect(md).toContain('PT(English summary.)');
    expect(md).toContain('2 posts · 2 contas · 2026-06-18–2026-06-20');
  });

  it('groups a multi-angle post under each matching tag and omits empty tags', async () => {
    const posts = [post({ id: '1', angles: 'money,business' })];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('## money');
    expect(md).toContain('## business');
    // a filter with no posts would not appear; both here have the one post
  });

  it('caps key posts at 5 newest-first, truncates snippets, and handles null url', async () => {
    const long = 'x'.repeat(250);
    const posts = Array.from({ length: 6 }, (_, i) => post({
      id: String(i), handle: `u${i}`, angles: 'money',
      posted_at: `2026-06-1${i}T00:00:00.000Z`, url: i === 0 ? null : `https://x.com/u/${i}`,
      text: i === 5 ? long : `t${i}`,
    }));
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    const keyLines = md.split('\n').filter(l => l.startsWith('- @'));
    // 5 EN + 5 PT = 10 lines total
    expect(keyLines.length).toBe(10);
    // newest (id 5, posted 2026-06-15) is first and its long text is truncated with an ellipsis
    expect(md).toContain('@u5: "' + 'x'.repeat(200) + '…"');
  });

  it('uses the localized unavailable note when provider is null', async () => {
    const md = await buildAnalysisMarkdown({ posts: [post({})], filters: FILTERS, tz: 'UTC', provider: null });
    expect(md).toContain('_AI summary unavailable._');
    expect(md).toContain('_Resumo de IA indisponível._');
    expect(md).toContain('## money'); // stats/keyposts still render
  });

  it('shows the note for a tag whose summarize call throws', async () => {
    const provider = stubProvider({ summarize: vi.fn(async () => { throw new Error('down'); }) });
    const md = await buildAnalysisMarkdown({ posts: [post({})], filters: FILTERS, tz: 'UTC', provider });
    expect(md).toContain('_AI summary unavailable._');
    expect(md).toContain('_Resumo de IA indisponível._');
  });

  it('returns a minimal document when there are no posts', async () => {
    const md = await buildAnalysisMarkdown({ posts: [], filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('# Analysis (English)');
    expect(md).toContain('No matching posts for this period.');
    expect(md).toContain('# Análise (Português)');
    expect(md).toContain('Sem posts correspondentes para este período.');
    expect(md).not.toContain('## ');
  });

  it('falls back to a single "All posts" group when no filter matches', async () => {
    const posts = [post({ angles: 'sports' })];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('## All posts');
  });
});
