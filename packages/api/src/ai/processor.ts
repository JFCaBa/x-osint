import type { createRepo } from '../store/repo.js';
import type { AiProvider } from './provider.js';
import type { Post } from '../types.js';
import { logger } from '../logger.js';

type Repo = ReturnType<typeof createRepo>;

export type AiActivity = { handle: string; phase: 'classify' | 'translate' };

export function createAiProcessor(deps: { repo: Repo; provider: AiProvider; batchSize?: number; onActivity?: (a: AiActivity | null) => void }): {
  processBatch(): Promise<number>;
  processAll(): Promise<void>;
} {
  const { repo, provider, onActivity } = deps;
  const batchSize = deps.batchSize ?? 25;

  async function processOne(post: Post, labels: string[]): Promise<void> {
    try {
      onActivity?.({ handle: post.handle, phase: 'classify' });
      const { match, angles } = await provider.classify(post.text, labels);
      let textPt: string | null = null;
      if (match) {
        onActivity?.({ handle: post.handle, phase: 'translate' });
        textPt = await provider.translate(post.text);
      }
      repo.setPostAi(post.id, { status: 'done', match, angles, textPt });
    } catch (err) {
      logger.warn({ err, id: post.id }, 'ai processing failed');
      repo.setPostAi(post.id, { status: 'error' });
    }
  }

  async function processBatch(): Promise<number> {
    const labels = repo.getFilters().map(f => f.label);
    const posts = repo.listPostsNeedingAi(batchSize);
    try {
      for (const post of posts) await processOne(post, labels);
      return posts.length;
    } finally {
      onActivity?.(null);
    }
  }

  async function processAll(): Promise<void> {
    const labels = repo.getFilters().map(f => f.label);
    const attempted = new Set<string>();
    const allPosts = repo.listPostsNeedingAi(Number.MAX_SAFE_INTEGER);
    try {
      for (const post of allPosts) {
        if (attempted.has(post.id)) continue;
        attempted.add(post.id);
        await processOne(post, labels);
      }
    } finally {
      onActivity?.(null);
    }
  }

  return { processBatch, processAll };
}
