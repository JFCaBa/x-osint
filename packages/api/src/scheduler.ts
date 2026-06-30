import type { Config } from './types.js';
import type { createRepo } from './store/repo.js';
import { fetchAccount } from './fetcher/fetchAccount.js';
import { httpsGet, type HttpGet } from './fetcher/http.js';
import { logger } from './logger.js';

type Repo = ReturnType<typeof createRepo>;

export function createScheduler(deps: { config: Config; repo: Repo; httpGet?: HttpGet; aiProcess?: () => Promise<void> }): { start(): void; stop(): void; triggerNow(): void } {
  const { config, repo } = deps;
  const httpGet = deps.httpGet ?? httpsGet;
  const aiProcess = deps.aiProcess;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let initTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function pollOnce(): Promise<void> {
    if (running) { logger.debug('poll already running, skipping'); return; }
    running = true;
    try {
      const handles = repo.getEnabledHandles();
      let total = 0;
      for (const handle of handles) {
        const result = await fetchAccount(handle, config.nitterInstances, httpGet, config.retentionDays);
        const fetchedAt = new Date().toISOString();
        repo.setAccountStatus(handle, result.ok ? 'ok' : 'error', fetchedAt);
        if (result.posts.length) total += repo.upsertPosts(result.posts);
      }
      logger.info({ accounts: handles.length, newPosts: total }, 'poll complete');
      if (aiProcess) {
        try { await aiProcess(); }
        catch (err) { logger.error({ err }, 'ai processing failed'); }
      }
    } catch (err) {
      logger.error({ err }, 'poll failed');
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      initTimer = setTimeout(() => { void pollOnce(); }, 2000);
      pollTimer = setInterval(() => { void pollOnce(); }, config.pollIntervalMin * 60_000);
      pruneTimer = setInterval(() => {
        try {
          const removed = repo.pruneOldPosts(config.retentionDays);
          if (removed) logger.info({ removed }, 'pruned old posts');
        } catch (err) {
          logger.error({ err }, 'prune failed');
        }
      }, 6 * 60 * 60_000);
    },
    stop(): void {
      if (initTimer) clearTimeout(initTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      initTimer = null;
      pollTimer = null;
      pruneTimer = null;
    },
    triggerNow(): void { void pollOnce(); },
  };
}
