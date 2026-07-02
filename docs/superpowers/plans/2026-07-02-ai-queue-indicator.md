# AI Processing-Queue Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live indicator on the Feed of the AI backlog (posts still needing classification/translation) and the post currently being processed, so the user can see the pipeline is working through its queue.

**Architecture:** Add a backlog `COUNT` to the repo and an `onActivity` callback to the AI processor that reports the current post + phase. `index.ts` holds the latest activity and exposes a getter through to a new `GET /api/ai/queue` route. The Feed polls it every 3s while open.

**Tech Stack:** TypeScript, Express 5, better-sqlite3 (API); Vue 3 (web); Vitest + supertest.

## Global Constraints

- Backlog = posts with `ai_status` null / `'pending'` / `'error'` (same predicate as `listPostsNeedingAi`).
- Activity type: `{ handle: string; phase: 'classify' | 'translate' }` or `null` (idle).
- Processor emits `classify` before classifying a post, `translate` before translating (only when it matched), and `null` in a `finally` when a batch ends (even on error). Omitting `onActivity` leaves behavior unchanged.
- `GET /api/ai/queue` (auth) → `{ pending: number, processing: boolean, current: { handle, phase } | null }` where `processing = current !== null`. Getter defaults to `() => null` when AI is disabled.
- Indicator lives on the Feed, polled every 3000ms while mounted, cleared on unmount; shown only when `pending > 0 || processing`.
- No change to how/when posts are processed; this only observes.

---

### Task 1: Backend primitives — backlog count + processor activity

**Files:**
- Modify: `packages/api/src/store/repo.ts`
- Modify: `packages/api/src/ai/processor.ts`
- Test: `packages/api/__tests__/repo.test.ts`, `packages/api/__tests__/processor.test.ts`

**Interfaces:**
- Produces:
  - `repo.countPostsNeedingAi(): number`
  - `export type AiActivity = { handle: string; phase: 'classify' | 'translate' }` (from `processor.ts`)
  - `createAiProcessor` deps gain `onActivity?: (a: AiActivity | null) => void`.

- [ ] **Step 1: Write the failing repo test**

In `packages/api/__tests__/repo.test.ts`, add inside the `describe('repo', ...)` block:
```ts
  it('counts posts needing AI (null/pending/error), excluding done', () => {
    repo.upsertPosts([
      makePost('1', 'a', '2026-06-18T00:00:00.000Z'),
      makePost('2', 'a', '2026-06-18T00:00:00.000Z'),
      makePost('3', 'a', '2026-06-18T00:00:00.000Z'),
    ]);
    repo.setPostAi('1', { status: 'done', match: false, angles: [] }); // done → excluded
    repo.setPostAi('2', { status: 'error' });                          // error → counted
    // '3' stays null → counted
    expect(repo.countPostsNeedingAi()).toBe(2);
    expect(repo.countPostsNeedingAi()).toBe(repo.listPostsNeedingAi(1000).length);
  });
```

- [ ] **Step 2: Run the repo test to verify it fails**

Run: `npm test -w @x-osint/api -- repo`
Expected: FAIL — `repo.countPostsNeedingAi is not a function`.

- [ ] **Step 3: Implement `countPostsNeedingAi`**

In `packages/api/src/store/repo.ts`, add this method right after `listPostsNeedingAi`:
```ts
    countPostsNeedingAi(): number {
      const row = db.prepare(
        `SELECT COUNT(*) AS c FROM posts
         WHERE ai_status IS NULL OR ai_status = 'pending' OR ai_status = 'error'`,
      ).get() as { c: number };
      return row.c;
    },
```

- [ ] **Step 4: Run the repo test to verify it passes**

Run: `npm test -w @x-osint/api -- repo`
Expected: PASS.

- [ ] **Step 5: Write the failing processor test**

In `packages/api/__tests__/processor.test.ts`, add inside `describe('aiProcessor', ...)`:
```ts
  it('reports activity: classify then translate per match, classify-only for non-match, null at end', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1'), makePost('2')]); // '1' matches, '2' does not
    const events: Array<{ handle: string; phase: string } | null> = [];
    const proc = createAiProcessor({ repo, provider: mockProvider(), onActivity: (a) => events.push(a) });
    await proc.processBatch();
    expect(events).toEqual([
      { handle: 'h', phase: 'classify' },
      { handle: 'h', phase: 'translate' },
      { handle: 'h', phase: 'classify' },
      null,
    ]);
  });

  it('still emits null (idle) when a classify call throws', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1')]);
    const events: Array<{ handle: string; phase: string } | null> = [];
    const provider = mockProvider({ classify: vi.fn(async () => { throw new Error('down'); }) });
    const proc = createAiProcessor({ repo, provider, onActivity: (a) => events.push(a) });
    await proc.processBatch();
    expect(events[0]).toEqual({ handle: 'h', phase: 'classify' });
    expect(events[events.length - 1]).toBeNull();
  });
```

- [ ] **Step 6: Run the processor test to verify it fails**

Run: `npm test -w @x-osint/api -- processor`
Expected: FAIL — `onActivity` not accepted / no events recorded.

- [ ] **Step 7: Add `onActivity` to the processor**

In `packages/api/src/ai/processor.ts`:

(a) Export the activity type near the top (after the imports):
```ts
export type AiActivity = { handle: string; phase: 'classify' | 'translate' };
```

(b) Change the deps signature and destructuring:
```ts
export function createAiProcessor(deps: { repo: Repo; provider: AiProvider; batchSize?: number; onActivity?: (a: AiActivity | null) => void }): {
  processBatch(): Promise<number>;
  processAll(): Promise<void>;
} {
  const { repo, provider, onActivity } = deps;
  const batchSize = deps.batchSize ?? 25;
```

(c) Emit activity in `processOne` (replace the whole function):
```ts
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
```

(d) Emit idle (`null`) in a `finally` for both batch methods (replace both functions):
```ts
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
```

- [ ] **Step 8: Run the processor test + full suite + typecheck**

Run: `npm test -w @x-osint/api -- processor` → Expected: PASS.
Run: `npm test -w @x-osint/api` → Expected: all files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/store/repo.ts packages/api/src/ai/processor.ts packages/api/__tests__/repo.test.ts packages/api/__tests__/processor.test.ts
git commit -m "feat(api): countPostsNeedingAi + processor onActivity reporting"
```

---

### Task 2: Route + wiring — `GET /api/ai/queue`

**Files:**
- Modify: `packages/api/src/http/routes.ts`
- Modify: `packages/api/src/http/app.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `repo.countPostsNeedingAi` and `AiActivity` from Task 1.
- Produces:
  - `createRoutes(..., getAiActivity: () => AiActivity | null = () => null)` (new trailing param, 7th).
  - `AppDeps.getAiActivity?: () => AiActivity | null`.
  - Route `GET /api/ai/queue` → `{ pending, processing, current }`.

- [ ] **Step 1: Write the failing route tests**

In `packages/api/__tests__/routes.test.ts`:

(a) Extend the `setup` helper's options and its `createApp` call to accept a `getAiActivity`. Change the `setup` signature/opts to include it and pass it through — replace the `createApp({...})` call inside `setup` with:
```ts
  const app = createApp({
    config, repo, triggerFetch,
    aiAvailable: opts.aiAvailable ?? true,
    checkAiReady: opts.checkAiReady,
    getAiActivity: opts.getAiActivity,
  });
```
and widen the opts type to:
```ts
function setup(opts: { aiAvailable?: boolean; checkAiReady?: () => Promise<boolean>; getAiActivity?: () => { handle: string; phase: 'classify' | 'translate' } | null } = {}) {
```

(b) Add a new describe block at the end of the file:
```ts
describe('ai queue route', () => {
  it('requires auth', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/ai/queue')).status).toBe(401);
  });

  it('reports pending backlog and idle when nothing is processing', async () => {
    const ctx = setup();
    ctx.repo.upsertPosts([
      { id: '1', handle: 'alice', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' },
      { id: '2', handle: 'bob', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' },
    ]);
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/ai/queue').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: 2, processing: false, current: null });
  });

  it('reports the current item when processing', async () => {
    const ctx = setup({ getAiActivity: () => ({ handle: 'alice', phase: 'classify' }) });
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/ai/queue').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ pending: 0, processing: true, current: { handle: 'alice', phase: 'classify' } });
  });
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `npm test -w @x-osint/api -- routes`
Expected: FAIL — `/api/ai/queue` 404; `getAiActivity` not accepted by `createApp` types.

- [ ] **Step 3: Add the route + param in `routes.ts`**

In `packages/api/src/http/routes.ts`:

(a) Import the type (next to the other type imports):
```ts
import type { AiActivity } from '../ai/processor.js';
```

(b) Add the 7th parameter to `createRoutes`:
```ts
export function createRoutes(
  config: Config,
  repo: Repo,
  triggerFetch: () => void,
  aiAvailable = false,
  checkAiReady: () => Promise<boolean> = async () => false,
  aiProvider: AiProvider | null = null,
  getAiActivity: () => AiActivity | null = () => null,
): Router {
```

(c) Add the route just after the existing `GET /ai/status` route:
```ts
  router.get('/ai/queue', auth, (_req: Request, res: Response) => {
    const current = getAiActivity();
    res.json({ pending: repo.countPostsNeedingAi(), processing: current !== null, current });
  });
```

- [ ] **Step 4: Thread `getAiActivity` through `app.ts`**

In `packages/api/src/http/app.ts`:

(a) Import the type:
```ts
import type { AiActivity } from '../ai/processor.js';
```
(b) Add to `AppDeps`:
```ts
  getAiActivity?: () => AiActivity | null;
```
(c) Update the `createRoutes` call to pass it (append the argument):
```ts
  app.use('/api', createRoutes(deps.config, deps.repo, deps.triggerFetch, deps.aiAvailable ?? false, deps.checkAiReady, deps.aiProvider ?? null, deps.getAiActivity ?? (() => null)));
```

- [ ] **Step 5: Wire the activity holder in `index.ts`**

In `packages/api/src/index.ts`:

(a) Import the type:
```ts
import { createAiProcessor, type AiActivity } from './ai/processor.js';
```
(replace the existing `import { createAiProcessor } from './ai/processor.js';` line.)

(b) Add a mutable holder and pass `onActivity` when creating the processor — replace the `const processor = ...` line with:
```ts
  let aiActivity: AiActivity | null = null;
  const processor = provider ? createAiProcessor({ repo, provider, onActivity: (a) => { aiActivity = a; } }) : null;
```

(c) Pass the getter into `createApp` (add to the deps object):
```ts
    aiProvider: provider,
    getAiActivity: () => aiActivity,
```

- [ ] **Step 6: Run route tests + full suite + typecheck**

Run: `npm test -w @x-osint/api -- routes` → Expected: PASS (auth + idle + processing cases, plus all existing route tests).
Run: `npm test -w @x-osint/api` → Expected: all files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/http/routes.ts packages/api/src/http/app.ts packages/api/src/index.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): GET /api/ai/queue reports backlog + current activity"
```

---

### Task 3: Frontend — Feed queue indicator

**Files:**
- Modify: `packages/www/src/services/api.ts`
- Modify: `packages/www/src/views/FeedView.vue`

**Interfaces:**
- Consumes: `GET /api/ai/queue` (Task 2).
- Produces: `api.aiQueue(): Promise<AiQueue>` and the `AiQueue` type.

- [ ] **Step 1: Add the API method + type in `api.ts`**

In `packages/www/src/services/api.ts`, add the interface near the other interfaces (e.g. after `ExportStatus`):
```ts
export interface AiQueue {
  pending: number;
  processing: boolean;
  current: { handle: string; phase: 'classify' | 'translate' } | null;
}
```
And add the method inside the `api` object (e.g. after `exportStatus`):
```ts
  aiQueue(): Promise<AiQueue> { return call<AiQueue>('GET', '/ai/queue'); },
```

- [ ] **Step 2: Add the indicator + polling in `FeedView.vue`**

In `packages/www/src/views/FeedView.vue`:

(a) Update the imports at the top of `<script setup>`:
```ts
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useData } from '../stores/data';
import { badgeStyle } from '../services/badges';
import { api, type Post, type Filter, type AiQueue } from '../services/api';
```
(This replaces the existing `import { ref, onMounted, computed } from 'vue';` and the `import type { Post, Filter } from '../services/api';` lines.)

(b) Add queue state + polling (place after the `const handleFilter = ref('');` line):
```ts
const aiQueue = ref<AiQueue | null>(null);
let queueTimer: ReturnType<typeof setInterval> | null = null;
async function pollQueue(): Promise<void> {
  try { aiQueue.value = await api.aiQueue(); } catch { /* keep polling */ }
}
onMounted(() => { void pollQueue(); queueTimer = setInterval(() => { void pollQueue(); }, 3000); });
onUnmounted(() => { if (queueTimer) { clearInterval(queueTimer); queueTimer = null; } });
```

(c) In the `<template>`, add the indicator immediately after the filter-bar `</div>` (the div that contains the search input, selects, and Refresh button) and before the list of posts:
```html
    <div v-if="aiQueue && (aiQueue.pending > 0 || aiQueue.processing)"
      class="text-xs text-gray-400 flex items-center gap-2">
      <span>⚙ AI: {{ aiQueue.pending }} pending</span>
      <span v-if="aiQueue.processing && aiQueue.current">
        · @{{ aiQueue.current.handle }} — {{ aiQueue.current.phase === 'classify' ? 'classifying' : 'translating' }}…
      </span>
    </div>
```

- [ ] **Step 3: Build the web package**

Run: `npm run build -w @x-osint/www`
Expected: `vue-tsc` passes (no type errors) and `vite build` completes.

- [ ] **Step 4: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/src/views/FeedView.vue
git commit -m "feat(www): Feed AI-queue indicator (pending count + current item)"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api suite + web build**

Run: `npm test -w @x-osint/api` → Expected: all pass.
Run: `npm run build -w @x-osint/www` → Expected: clean.

- [ ] **Step 2: Rebuild the image and bring the stack up**

Run: `docker compose up -d --build`
Expected: containers start; app listens on 8080.

- [ ] **Step 3: Watch the queue endpoint during processing**

Trigger a re-classify (queues all stored posts) then poll the queue endpoint to watch the backlog drain and the current item change:
```bash
TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X POST localhost:8080/api/settings/reclassify -H "Authorization: Bearer $TOKEN"; echo
for i in $(seq 1 20); do curl -s localhost:8080/api/ai/queue -H "Authorization: Bearer $TOKEN"; echo; sleep 3; done
```
Expected: `pending` starts high and trends down; while a batch runs, `processing:true` with `current` cycling through `{handle, phase:'classify'|'translate'}`; when idle, `processing:false, current:null`. Also confirm in the browser at http://localhost:8080 that the Feed shows the `⚙ AI: N pending · @handle — classifying…` line while processing and hides it when the backlog is 0 and idle.

---

## Self-Review

**Spec coverage:**
- `countPostsNeedingAi` mirroring the needing-AI predicate → Task 1. ✓
- Processor `onActivity`: classify before classify, translate before translate (match only), null in finally (incl. error path) → Task 1 steps 7(c)(d) + both processor tests. ✓
- Wiring `getAiActivity` index→app→routes; default `() => null` when AI off → Task 2 steps 3-5. ✓
- `GET /api/ai/queue` shape `{ pending, processing, current }`, auth → Task 2 step 3 + tests. ✓
- `api.aiQueue()` + `AiQueue` type → Task 3 step 1. ✓
- Feed indicator: poll every 3000ms while mounted, stop on unmount, show only when pending>0||processing, exact copy → Task 3 step 2. ✓
- Tests: repo count, processor activity sequence (+error), route shape/auth → Tasks 1-2. ✓
- Out-of-scope (full list, progress bar, app-wide polling, changing processing) respected. ✓

**Placeholder scan:** No TBD/vague steps; complete code in every code step. ✓

**Type consistency:** `AiActivity = { handle: string; phase: 'classify' | 'translate' }` defined in `processor.ts` and imported by `routes.ts`/`app.ts`/`index.ts`; the frontend `AiQueue.current` uses the identical inline shape. `getAiActivity: () => AiActivity | null` identical across `createRoutes` param, `AppDeps`, `app.ts` pass-through, and `index.ts` getter. Response shape `{ pending, processing, current }` identical in route, tests, and `AiQueue`. `countPostsNeedingAi(): number` matches its call in the route. ✓
