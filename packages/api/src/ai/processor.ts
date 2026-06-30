import type { createRepo } from '../store/repo.js';
import type { AiProvider } from './provider.js';
import { logger } from '../logger.js';

type Repo = ReturnType<typeof createRepo>;

export function createAiProcessor(deps: { repo: Repo; provider: AiProvider; batchSize?: number }): {
  processBatch(): Promise<number>;
  processAll(): Promise<void>;
} {
  const { repo, provider } = deps;
  const batchSize = deps.batchSize ?? 25;

  async function processBatch(): Promise<number> {
    const posts = repo.listPostsNeedingAi(batchSize);
    for (const post of posts) {
      try {
        const { match, angles } = await provider.classify(post.text);
        const textPt = match ? await provider.translate(post.text) : null;
        repo.setPostAi(post.id, { status: 'done', match, angles, textPt });
      } catch (err) {
        logger.warn({ err, id: post.id }, 'ai processing failed');
        repo.setPostAi(post.id, { status: 'error' });
      }
    }
    return posts.length;
  }

  async function processAll(): Promise<void> {
    while ((await processBatch()) > 0) { /* keep draining */ }
  }

  return { processBatch, processAll };
}
