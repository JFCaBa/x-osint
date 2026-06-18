import { XMLParser } from 'fast-xml-parser';

export interface RawItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

export function parseNitterRss(xml: string): RawItem[] {
  if (!xml.includes('<rss')) return [];
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (!channel) return [];
  const raw = channel.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (items as Record<string, unknown>[]).map(e => ({
    title: ((e.title as string) ?? '').trim(),
    link: ((e.link as string) ?? '').trim(),
    pubDate: (e.pubDate as string) ?? '',
    description: (e.description as string) ?? '',
  }));
}
