import { describe, it, expect } from 'vitest';
import { parseNitterRss } from '../src/fetcher/rss.js';

const XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>Acct / @h</title>
<item><title>First tweet</title><link>https://nitter.net/h/status/1#m</link>
<pubDate>Wed, 18 Jun 2026 14:03:00 GMT</pubDate>
<description>&lt;p&gt;First tweet&lt;/p&gt;&lt;img src="https://nitter.net/pic/orig/media%2FA.jpg"/&gt;</description></item>
<item><title>Second tweet</title><link>https://nitter.net/h/status/2#m</link>
<pubDate>Wed, 18 Jun 2026 13:00:00 GMT</pubDate><description>plain</description></item>
</channel></rss>`;

describe('parseNitterRss', () => {
  it('returns one RawItem per channel item', () => {
    const items = parseNitterRss(XML);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('First tweet');
    expect(items[0].link).toBe('https://nitter.net/h/status/1#m');
  });
  it('returns empty array for non-rss body', () => {
    expect(parseNitterRss('<html>blocked</html>')).toEqual([]);
  });
  it('handles a single (non-array) item', () => {
    const single = `<rss><channel><item><title>only</title><link>https://nitter.net/h/status/9</link><pubDate>x</pubDate><description>d</description></item></channel></rss>`;
    expect(parseNitterRss(single)).toHaveLength(1);
  });
});
