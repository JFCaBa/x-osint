import { z } from 'zod';
import type { Config, NitterInstance } from './types.js';

const DEFAULT_NITTER: NitterInstance[] = [
  { url: 'https://nitter.net', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  { url: 'https://nitter.poast.org', userAgent: 'mistique' },
];

const instanceSchema = z.array(z.object({ url: z.string().url(), userAgent: z.string().min(1) }));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const password = env.X_OSINT_PASSWORD;
  if (!password) throw new Error('X_OSINT_PASSWORD is required');

  let nitterInstances = DEFAULT_NITTER;
  if (env.NITTER_INSTANCES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.NITTER_INSTANCES);
    } catch {
      throw new Error('NITTER_INSTANCES must be valid JSON');
    }
    const result = instanceSchema.safeParse(parsed);
    if (!result.success) throw new Error('NITTER_INSTANCES must be an array of {url,userAgent}');
    nitterInstances = result.data;
  }

  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid numeric env value: ${v}`);
    return n;
  };

  return {
    password,
    port: num(env.PORT, 8080),
    dataDir: env.DATA_DIR ?? '/data',
    pollIntervalMin: num(env.POLL_INTERVAL_MIN, 5),
    retentionDays: num(env.RETENTION_DAYS, 30),
    tokenTtlDays: num(env.TOKEN_TTL_DAYS, 7),
    tokenSecret: env.TOKEN_SECRET ?? password,
    nitterInstances,
  };
}
