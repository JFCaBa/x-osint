export function nitterLinkToTwitter(nitterLink: string): string {
  try {
    const url = new URL(nitterLink);
    return `https://x.com${url.pathname}`;
  } catch {
    return nitterLink;
  }
}

export function extractStatusId(link: string): string | null {
  const match = link.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

export function nitterMediaToTwitterCdn(nitterUrl: string): string {
  const picMatch = nitterUrl.match(/\/pic(?:\/orig)?\/media%2F(.+)/);
  if (picMatch) return `https://pbs.twimg.com/media/${decodeURIComponent(picMatch[1])}`;
  return nitterUrl;
}

export function extractNitterMedia(descriptionHtml: string): string | null {
  const match = descriptionHtml.match(/<img\s+[^>]*src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}
