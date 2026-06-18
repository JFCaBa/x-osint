import type { NitterInstance, Post } from '../types.js';
import type { HttpGet } from './http.js';
import { parseNitterRss } from './rss.js';
import { decodeHtmlEntities } from './text.js';
import { nitterLinkToTwitter, extractStatusId, nitterMediaToTwitterCdn, extractNitterMedia } from './urls.js';
import { makeId } from './id.js';
import { createDedupe } from './dedupe.js';
import { logger } from '../logger.js';

const FETCH_TIMEOUT_MS = 10_000;

export async function fetchAccount(
  handle: string,
  instances: NitterInstance[],
  httpGet: HttpGet,
  retentionDays: number,
  now: () => number = Date.now,
): Promise<{ ok: boolean; posts: Post[] }> {
  const clean = handle.replace('@', '');
  const dedupe = createDedupe();
  const fetchedAt = new Date(now()).toISOString();
  const retentionMs = retentionDays * 86_400_000;

  for (const instance of instances) {
    const rssUrl = `${instance.url}/${clean}/rss`;
    let res;
    try {
      res = await httpGet(rssUrl, instance.userAgent, FETCH_TIMEOUT_MS);
    } catch (err) {
      logger.warn({ err, handle: clean, instance: instance.url }, 'nitter fetch threw');
      continue;
    }
    if (!res.ok) {
      logger.warn({ handle: clean, instance: instance.url, status: res.status }, 'nitter non-OK');
      continue;
    }
    const items = parseNitterRss(res.text);
    if (items.length === 0 && !res.text.includes('<rss')) {
      logger.warn({ handle: clean, instance: instance.url }, 'nitter response not RSS');
      continue;
    }

    const posts: Post[] = [];
    for (const item of items) {
      const text = decodeHtmlEntities(item.title);
      if (!text || text.length < 5) continue;
      const postedAtMs = item.pubDate ? Date.parse(item.pubDate) : now();
      if (Number.isNaN(postedAtMs)) continue;
      if (now() - postedAtMs >= retentionMs) continue;

      const url = item.link ? nitterLinkToTwitter(item.link) : null;
      const statusId = extractStatusId(item.link);
      const rawMedia = extractNitterMedia(item.description);
      const media = rawMedia ? nitterMediaToTwitterCdn(rawMedia) : null;
      const post: Post = {
        id: makeId(`twitter:${clean}:${statusId ?? ''}`, text.slice(0, 80)),
        handle: clean,
        text,
        url,
        media_url: media,
        posted_at: new Date(postedAtMs).toISOString(),
        fetched_at: fetchedAt,
      };
      if (!dedupe.isDuplicate({ id: post.id, url: post.url, text: post.text })) posts.push(post);
    }
    return { ok: true, posts };
  }

  logger.warn({ handle: clean }, 'all nitter instances failed');
  return { ok: false, posts: [] };
}
