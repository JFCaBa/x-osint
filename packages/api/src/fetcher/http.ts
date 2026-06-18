import https from 'node:https';

export type HttpGet = (url: string, userAgent: string, timeoutMs: number)
  => Promise<{ ok: boolean; status: number; text: string }>;

/** HTTP/1.1 GET via node:https. Native fetch uses HTTP/2, which some Nitter instances reject. */
export const httpsGet: HttpGet = (url, userAgent, timeoutMs) =>
  new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': userAgent },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, text: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, text: '' }); });
  });
