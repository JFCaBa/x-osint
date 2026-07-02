# AI processing-queue indicator

**Date:** 2026-07-02
**Status:** Approved (pending spec review)

## Problem

Classifying/translating posts with the local model is slow, and the app gives no
visibility into the backlog. A user watching the Feed can't tell whether posts are
still being processed or the pipeline is idle — it just looks like nothing is
happening.

## Goal

Show a compact, live indicator on the Feed of the AI backlog (how many posts still need
classification/translation) and, while a batch is running, which post is currently being
processed and in which phase.

## Scope decisions (from brainstorming)

- Shows a **live pending count** plus the **current item** (handle + phase) while a batch
  runs; hidden when nothing is pending and nothing is processing.
- Lives on the **Feed view**, polled every ~3s **while that view is open** (stops on
  unmount) — not an app-wide poller.
- No full queue list, no progress bar — count + current item only.

## Architecture

### Backlog count (`packages/api/src/store/repo.ts`)

Add `countPostsNeedingAi(): number`, mirroring `listPostsNeedingAi`'s predicate:
```sql
SELECT COUNT(*) AS c FROM posts
WHERE ai_status IS NULL OR ai_status = 'pending' OR ai_status = 'error'
```

### Processor activity callback (`packages/api/src/ai/processor.ts`)

`createAiProcessor` deps gain an optional callback:
```ts
onActivity?: (a: { handle: string; phase: 'classify' | 'translate' } | null) => void;
```
Behavior inside `processOne(post, labels)`:
- emit `{ handle: post.handle, phase: 'classify' }` before `provider.classify(...)`;
- if it matched (so a translate happens), emit `{ handle: post.handle, phase: 'translate' }`
  before `provider.translate(...)`.

Both `processAll` and `processBatch` emit `null` (idle) in a `finally`, so activity is
always cleared when a batch ends — even on error. When `onActivity` is omitted, behavior
is unchanged.

### Wiring (`index.ts` → `app.ts` → `routes.ts`)

`index.ts` keeps a mutable `let aiActivity: { handle: string; phase: 'classify' | 'translate' } | null = null`
and creates the processor with `onActivity: (a) => { aiActivity = a; }`. It passes a getter
`getAiActivity: () => aiActivity` into `createApp`, threaded to `createRoutes` (same
optional-dependency pattern as `aiProvider` / `checkAiReady`). When there is no processor
(AI disabled), the getter defaults to `() => null`.

New route (auth-protected):
```
GET /api/ai/queue  ->  {
  pending: number,                 // repo.countPostsNeedingAi()
  processing: boolean,             // getAiActivity() !== null
  current: { handle, phase } | null  // getAiActivity()
}
```

### Frontend

- `services/api.ts`: add
  ```ts
  export interface AiQueue { pending: number; processing: boolean; current: { handle: string; phase: 'classify' | 'translate' } | null; }
  ```
  and `aiQueue(): Promise<AiQueue>` → `GET /ai/queue`.
- `views/FeedView.vue`: on mount, poll `api.aiQueue()` every 3000ms; store the latest
  result; clear the interval on unmount. Render a compact status line only when
  `pending > 0 || processing`:
  - idle-with-backlog: `⚙ AI: {pending} pending`
  - processing: `⚙ AI: {pending} pending · {current.handle} — {phase === 'classify' ? 'classifying' : 'translating'}…`
  Poll errors are swallowed (keep polling; treat as no change). Styling consistent with
  the existing dark theme (small, muted text).

## Testing

### `repo.test.ts`
- Seed posts across statuses (null via `upsertPosts`, `done`, `error`, `pending` via
  `resetAiStatus`); assert `countPostsNeedingAi()` equals the length of
  `listPostsNeedingAi(BIG)` for the same data (both count null/pending/error, exclude
  done).

### `processor.test.ts`
- With an `onActivity` spy and one matching + one non-matching post, assert the emitted
  sequence: `{handle, 'classify'}` then `{handle, 'translate'}` for the match, only
  `{handle, 'classify'}` for the non-match, and a final `null`. (Use the existing
  `mockProvider`; a post "matches" when its text drives `classify` to return angles.)
- Assert `null` is still emitted when a `classify` call throws (the `finally` path).

### `routes.test.ts`
- `GET /api/ai/queue` requires auth (401 without token).
- With a seeded backlog and a `getAiActivity` returning `null`, response is
  `{ pending: <n>, processing: false, current: null }`.
- With `getAiActivity` returning `{ handle: 'alice', phase: 'classify' }`, response is
  `{ pending: <n>, processing: true, current: { handle: 'alice', phase: 'classify' } }`.

(No frontend unit tests exist; the Feed indicator is covered by the `www` build gate and
manual/E2E check.)

## Out of scope

- A full list of queued posts or a done/total progress bar.
- App-wide (non-Feed) polling or a nav badge.
- Changing how/when posts are processed (the scheduler + batch logic are unchanged;
  this only observes them).
- Persisting activity across restarts (in-memory; resets to idle on boot).
