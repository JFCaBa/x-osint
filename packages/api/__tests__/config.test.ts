import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when X_OSINT_PASSWORD is missing', () => {
    expect(() => loadConfig({})).toThrow(/X_OSINT_PASSWORD/);
  });

  it('applies defaults when only password is set', () => {
    const cfg = loadConfig({ X_OSINT_PASSWORD: 'pw' });
    expect(cfg.port).toBe(8080);
    expect(cfg.pollIntervalMin).toBe(5);
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.tokenTtlDays).toBe(7);
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.tokenSecret).toBe('pw'); // derived from password when no TOKEN_SECRET
    expect(cfg.nitterInstances.length).toBeGreaterThanOrEqual(2);
  });

  it('parses overrides including NITTER_INSTANCES json', () => {
    const cfg = loadConfig({
      X_OSINT_PASSWORD: 'pw',
      PORT: '9000',
      POLL_INTERVAL_MIN: '10',
      RETENTION_DAYS: '7',
      TOKEN_SECRET: 'sekret',
      NITTER_INSTANCES: '[{"url":"https://x.example","userAgent":"UA"}]',
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.pollIntervalMin).toBe(10);
    expect(cfg.retentionDays).toBe(7);
    expect(cfg.tokenSecret).toBe('sekret');
    expect(cfg.nitterInstances).toEqual([{ url: 'https://x.example', userAgent: 'UA' }]);
  });

  it('throws on malformed NITTER_INSTANCES', () => {
    expect(() => loadConfig({ X_OSINT_PASSWORD: 'pw', NITTER_INSTANCES: 'not json' }))
      .toThrow(/NITTER_INSTANCES/);
  });
});
