import { describe, it, expect } from 'vitest';
import { nitterLinkToTwitter, extractStatusId, nitterMediaToTwitterCdn, extractNitterMedia } from '../src/fetcher/urls.js';

describe('url rewriters', () => {
  it('rewrites nitter link to x.com keeping the path', () => {
    expect(nitterLinkToTwitter('https://nitter.net/handle/status/123#m')).toBe('https://x.com/handle/status/123');
  });
  it('returns input unchanged when not a URL', () => {
    expect(nitterLinkToTwitter('not a url')).toBe('not a url');
  });
  it('extracts the numeric status id', () => {
    expect(extractStatusId('https://nitter.net/h/status/1789#m')).toBe('1789');
    expect(extractStatusId('https://nitter.net/h')).toBeNull();
  });
  it('rewrites proxied media to the twitter cdn', () => {
    expect(nitterMediaToTwitterCdn('https://nitter.net/pic/orig/media%2FAbCdEf.jpg')).toBe('https://pbs.twimg.com/media/AbCdEf.jpg');
  });
  it('fails open on unrecognized media url', () => {
    expect(nitterMediaToTwitterCdn('https://example.com/x.png')).toBe('https://example.com/x.png');
  });
  it('extracts the first img src from description html', () => {
    expect(extractNitterMedia('<p>hi</p><img src="https://nitter.net/pic/x.jpg" />')).toBe('https://nitter.net/pic/x.jpg');
    expect(extractNitterMedia('<p>no image</p>')).toBeNull();
  });
});
