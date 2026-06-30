import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import { loadConfig } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';
import type { HttpGet } from '../src/fetcher/http.js';

const RSS = (items: string) => `<rss><channel>${items}</channel></rss>`;
const item = (id: string) => `<item><title>hello world ${id}</title><link>https://nitter.net/h/status/${id}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`;

describe('scheduler aiProcess', () => {
  it('runs aiProcess after a poll', async () => {
    const config = loadConfig({ X_OSINT_PASSWORD: 'pw' });
    const repo = createRepo(openDb(':memory:'));
    repo.addAccount('h');
    const httpGet: HttpGet = vi.fn(async () => ({ ok: true, status: 200, text: RSS(item('1')) }));
    const aiProcess = vi.fn(async () => {});
    const scheduler = createScheduler({ config, repo, httpGet, aiProcess });
    scheduler.triggerNow();
    await vi.waitFor(() => expect(aiProcess).toHaveBeenCalled());
    scheduler.stop();
  });
});
