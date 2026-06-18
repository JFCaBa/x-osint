import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token format: base64url(JSON {exp}) + '.' + hmac. Stateless, no session store. */
export function signToken(secret: string, ttlDays: number, now: () => number = Date.now): string {
  const exp = now() + ttlDays * 86_400_000;
  const payload = b64url(JSON.stringify({ exp }));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret: string, token: string, now: () => number = Date.now): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = sign(secret, payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' && decoded.exp > now();
  } catch {
    return false;
  }
}

export function comparePassword(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
