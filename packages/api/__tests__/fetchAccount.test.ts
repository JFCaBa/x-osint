import { describe, it, expect, vi } from 'vitest';
import { fetchAccount } from '../src/fetcher/fetchAccount.js';
import type { NitterInstance } from '../src/types.js';
import type { HttpGet } from '../src/fetcher/http.js';

const INSTANCES: NitterInstance[] = [
  { url: 'https://nitter.net', userAgent: 'UA1' },
  { url: 'https://nitter.poast.org', userAgent: 'UA2' },
];

const recent = new Date().toUTCString();
const rss = (title: string) => `<rss version="2.0"><channel><title>Acct</title>
<item><title>${title}</title><link>https://nitter.net/h/status/100#m</link>
<pubDate>${recent}</pubDate>
<description>&lt;img src="https://nitter.net/pic/orig/media%2FX.jpg"/&gt;</description></item></channel></rss>`;

const now = () => Date.parse('2026-06-18T00:00:00.000Z');

describe('fetchAccount', () => {
  it('parses items into normalized posts with rewritten url and media', async () => {
    const httpGet: HttpGet = vi.fn(async () => ({ ok: true, status: 200, text: rss('hello world') }));
    const res = await fetchAccount('h', INSTANCES, httpGet, 30);
    expect(res.ok).toBe(true);
    expect(res.posts).toHaveLength(1);
    const p = res.posts[0];
    expect(p.handle).toBe('h');
    expect(p.text).toBe('hello world');
    expect(p.url).toBe('https://x.com/h/status/100');
    expect(p.media_url).toBe('https://pbs.twimg.com/media/X.jpg');
    expect(httpGet).toHaveBeenCalledTimes(1); // first instance succeeded, no failover
  });

  it('fails over to the second instance when the first returns non-200', async () => {
    const httpGet: HttpGet = vi.fn(async (url) =>
      url.startsWith('https://nitter.net')
        ? { ok: false, status: 429, text: '' }
        : { ok: true, status: 200, text: rss('from second') });
    const res = await fetchAccount('h', INSTANCES, httpGet, 30);
    expect(res.ok).toBe(true);
    expect(res.posts[0].text).toBe('from second');
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  it('returns ok=false when all instances fail', async () => {
    const httpGet: HttpGet = vi.fn(async () => ({ ok: false, status: 0, text: '' }));
    const res = await fetchAccount('h', INSTANCES, httpGet, 30);
    expect(res.ok).toBe(false);
    expect(res.posts).toEqual([]);
  });

  it('skips items older than the retention window', async () => {
    const old = new Date(Date.parse('2026-01-01T00:00:00.000Z')).toUTCString();
    const oldRss = `<rss version="2.0"><channel><item><title>old news</title>
<link>https://nitter.net/h/status/1</link><pubDate>${old}</pubDate><description>d</description></item></channel></rss>`;
    const httpGet: HttpGet = vi.fn(async () => ({ ok: true, status: 200, text: oldRss }));
    const res = await fetchAccount('h', INSTANCES, httpGet, 30, now);
    expect(res.ok).toBe(true);
    expect(res.posts).toEqual([]);
  });

  it('drops too-short text', async () => {
    const shortRss = `<rss version="2.0"><channel><item><title>hi</title>
<link>https://nitter.net/h/status/1</link><pubDate>${recent}</pubDate><description>d</description></item></channel></rss>`;
    const httpGet: HttpGet = vi.fn(async () => ({ ok: true, status: 200, text: shortRss }));
    const res = await fetchAccount('h', INSTANCES, httpGet, 30);
    expect(res.posts).toEqual([]);
  });
});
