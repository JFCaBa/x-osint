import { describe, it, expect } from 'vitest';
import { createDedupe } from '../src/fetcher/dedupe.js';

describe('createDedupe (per-run)', () => {
  it('treats the first sighting as new and the second as duplicate by id', () => {
    const d = createDedupe();
    const post = { id: '1', url: 'https://x.com/a/status/1', text: 'hello' };
    expect(d.isDuplicate(post)).toBe(false);
    expect(d.isDuplicate(post)).toBe(true);
  });
  it('dedupes by url even with different id', () => {
    const d = createDedupe();
    expect(d.isDuplicate({ id: '1', url: 'https://x.com/a/status/1', text: 'hello' })).toBe(false);
    expect(d.isDuplicate({ id: '2', url: 'https://x.com/a/status/1', text: 'different' })).toBe(true);
  });
  it('dedupes by text snippet when url is null', () => {
    const d = createDedupe();
    expect(d.isDuplicate({ id: '1', url: null, text: 'a repeated message here' })).toBe(false);
    expect(d.isDuplicate({ id: '2', url: null, text: 'a repeated message here' })).toBe(true);
  });
});
