# Editable AI Filters + Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit the AI filter list (label + color + emoji) at runtime from a new Settings page, constrain the classifier to those labels, re-classify on demand, and show each matched filter as a colored emoji badge on the Feed.

**Architecture:** Filters are stored as JSON in a new `settings` key-value table. `AiProvider.classify(text, labels)` injects the labels into the prompt and intersects the model's answer with them; the processor reads the current labels each batch. New Settings API/page edit the list and trigger a full re-classify. The Feed renders each post's matched labels as badges styled from the filter config.

**Tech Stack:** TypeScript (ESM), Express 5, better-sqlite3, zod, Vue 3 + Pinia + Tailwind, Vitest, Ollama.

## Global Constraints

- ESM throughout: every relative import ends in `.js` (e.g. `import { x } from './y.js'`), even from `.ts`.
- `Filter` shape, exact: `{ label: string; color: string; emoji: string }`.
- Default filters, verbatim (seeded on read when unset — keeps today's behavior):
  `[{"label":"money","color":"#22c55e","emoji":"💰"},{"label":"entrepreneurship","color":"#3b82f6","emoji":"🚀"},{"label":"business","color":"#a855f7","emoji":"🏢"},{"label":"economy","color":"#f59e0b","emoji":"📈"}]`
- Classify rule: `match = (matched labels).length > 0`; the model's `angles` are intersected with the configured labels case-insensitively, output as the **canonical configured label**.
- PUT /settings validation: `filters` array length 1–20; `label` trimmed, non-empty, ≤40 chars, unique case-insensitively; `color` matches `^#[0-9a-fA-F]{6}$`; `emoji` optional string ≤8 chars, default `''`.
- All `/api/*` routes except `/login` and `/health` are behind the existing Bearer `auth` middleware. New settings routes MUST use `auth`.
- Badges render on the **Feed only**. The Excel export keeps its existing four columns (no change).
- Tests never call a real Ollama — use a mock `AiProvider` or a stubbed `postJson`.
- API tests: `npm test --workspace @x-osint/api`. www tests: `npm test --workspace @x-osint/www`. www build: `npm run build --workspace @x-osint/www`.

---

### Task 1: Settings table + repo (filters, reset)

**Files:**
- Modify: `packages/api/src/store/schema.ts`
- Modify: `packages/api/src/types.ts` (add `Filter`)
- Modify: `packages/api/src/store/repo.ts`
- Test: `packages/api/__tests__/repo.test.ts` (append)

**Interfaces:**
- Produces: `Filter` type; `repo.getSetting(key): string | null`; `repo.setSetting(key, value): void`; `repo.getFilters(): Filter[]`; `repo.setFilters(filters: Filter[]): void`; `repo.resetAiStatus(): number`.

- [ ] **Step 1: Write the failing test** — append to `packages/api/__tests__/repo.test.ts`:

```ts
describe('repo settings + filters', () => {
  let repo: ReturnType<typeof createRepo>;
  beforeEach(() => { repo = createRepo(openDb(':memory:')); });

  it('getFilters returns defaults when unset', () => {
    expect(repo.getFilters().map(f => f.label)).toEqual(['money', 'entrepreneurship', 'business', 'economy']);
    expect(repo.getFilters()[0]).toEqual({ label: 'money', color: '#22c55e', emoji: '💰' });
  });

  it('round-trips filters via setFilters/getFilters', () => {
    repo.setFilters([{ label: 'tech', color: '#111111', emoji: '🤖' }]);
    expect(repo.getFilters()).toEqual([{ label: 'tech', color: '#111111', emoji: '🤖' }]);
  });

  it('getFilters falls back to defaults on malformed JSON', () => {
    repo.setSetting('classify_filters', 'not json');
    expect(repo.getFilters()).toHaveLength(4);
  });

  it('getSetting/setSetting round-trip', () => {
    expect(repo.getSetting('x')).toBeNull();
    repo.setSetting('x', 'y');
    expect(repo.getSetting('x')).toBe('y');
    repo.setSetting('x', 'z');
    expect(repo.getSetting('x')).toBe('z');
  });

  it('resetAiStatus marks all posts pending and preserves exported_at', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    repo.markExported(['1'], '2026-06-19T00:00:00.000Z');
    expect(repo.resetAiStatus()).toBe(1);
    expect(repo.listPostsNeedingAi(10).map(p => p.id)).toEqual(['1']);
    expect(repo.listPosts({})[0].exported_at).toBe('2026-06-19T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: FAIL — `repo.getFilters is not a function`.

- [ ] **Step 3: Add the settings table** — in `packages/api/src/store/schema.ts`, append inside the template literal (after the `exports` table):

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Add the `Filter` type** — in `packages/api/src/types.ts`, add (anywhere top-level):

```ts
export interface Filter {
  label: string;
  color: string;
  emoji: string;
}
```

- [ ] **Step 5: Add repo methods** — in `packages/api/src/store/repo.ts`:

Add the import for the type at the top (extend the existing type import):

```ts
import type { Account, Post, Filter } from '../types.js';
```

Add this default constant near the top of the file (after the imports, before `createRepo`):

```ts
const DEFAULT_CLASSIFY_FILTERS: Filter[] = [
  { label: 'money', color: '#22c55e', emoji: '💰' },
  { label: 'entrepreneurship', color: '#3b82f6', emoji: '🚀' },
  { label: 'business', color: '#a855f7', emoji: '🏢' },
  { label: 'economy', color: '#f59e0b', emoji: '📈' },
];
```

Inside `createRepo`, add two closure helpers near `getAccount`:

```ts
  function getSettingRaw(key: string): string | null {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  function setSettingRaw(key: string, value: string): void {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
```

Add these methods to the returned object (e.g. after `getExportState`):

```ts
    getSetting(key: string): string | null { return getSettingRaw(key); },
    setSetting(key: string, value: string): void { setSettingRaw(key, value); },

    getFilters(): Filter[] {
      const raw = getSettingRaw('classify_filters');
      if (!raw) return DEFAULT_CLASSIFY_FILTERS;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0
          && parsed.every(f => f && typeof (f as Filter).label === 'string')) {
          return parsed as Filter[];
        }
        return DEFAULT_CLASSIFY_FILTERS;
      } catch {
        return DEFAULT_CLASSIFY_FILTERS;
      }
    },

    setFilters(filters: Filter[]): void {
      setSettingRaw('classify_filters', JSON.stringify(filters));
    },

    resetAiStatus(): number {
      return db.prepare("UPDATE posts SET ai_status = 'pending'").run().changes;
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/store/schema.ts packages/api/src/types.ts packages/api/src/store/repo.ts packages/api/__tests__/repo.test.ts
git commit -m "feat(api): settings table with editable classify filters and resetAiStatus"
```

---

### Task 2: Provider — classify(text, labels) constrained to labels

**Files:**
- Modify: `packages/api/src/ai/provider.ts`
- Modify: `packages/api/src/ai/ollama.ts`
- Test: `packages/api/__tests__/ollama.test.ts` (rewrite the classify tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AiProvider.classify(text: string, labels: string[]): Promise<{ match: boolean; angles: string[] }>`. Angles are the model's answer intersected with `labels` (case-insensitive → canonical label); `match = angles.length > 0`. Empty `labels` returns `{ match: false, angles: [] }` with no HTTP call.

- [ ] **Step 1: Write the failing test** — replace the whole body of `packages/api/__tests__/ollama.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, type PostJson } from '../src/ai/ollama.js';

function stub(content: string): PostJson {
  return vi.fn(async () => ({ ok: true, status: 200, json: { message: { content } } }));
}

const LABELS = ['money', 'entrepreneurship', 'business', 'economy'];

describe('OllamaProvider.classify', () => {
  it('intersects model angles with the supplied labels and injects them in the prompt', async () => {
    const post = stub(JSON.stringify({ match: true, angles: ['money', 'sports', 'business'] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', postJson: post });
    const r = await p.classify('buy bitcoin and start a company', LABELS);
    expect(r.match).toBe(true);
    expect(r.angles).toEqual(['money', 'business']);
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).format).toBe('json');
    const system = (body as any).messages[0].content as string;
    expect(system).toContain('money, entrepreneurship, business, economy');
  });

  it('matches labels case-insensitively and returns the canonical label', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ angles: ['Business'] })) });
    const r = await p.classify('quarterly earnings', ['business', 'economy']);
    expect(r).toEqual({ match: true, angles: ['business'] });
  });

  it('is not a match when no returned angle is in the label set', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ match: true, angles: ['sports'] })) });
    expect(await p.classify('the game', LABELS)).toEqual({ match: false, angles: [] });
  });

  it('short-circuits with no HTTP call when labels is empty', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: true, status: 200, json: { message: { content: '{}' } } }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    expect(await p.classify('anything', [])).toEqual({ match: false, angles: [] });
    expect((post as any).mock.calls.length).toBe(0);
  });

  it('throws on malformed JSON content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('not json') });
    await expect(p.classify('x', LABELS)).rejects.toThrow();
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.classify('x', LABELS)).rejects.toThrow();
  });

  it('translates returning trimmed content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('  Olá mundo  ') });
    expect(await p.translate('Hello world')).toBe('Olá mundo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- ollama`
Expected: FAIL — `classify` ignores the `labels` argument / signature mismatch.

- [ ] **Step 3: Update the provider interface** — replace `packages/api/src/ai/provider.ts` with:

```ts
export interface ClassifyResult {
  match: boolean;
  angles: string[];
}

export interface AiProvider {
  classify(text: string, labels: string[]): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
}
```

- [ ] **Step 4: Update the Ollama provider** — in `packages/api/src/ai/ollama.ts`:

Change the first import line (drop `ANGLES`):

```ts
import { type AiProvider, type ClassifyResult } from './provider.js';
```

Remove the `CLASSIFY_SYSTEM` constant and add a builder function in its place:

```ts
function classifySystem(labels: string[]): string {
  return 'You are a strict text classifier. Decide which of these topics the post is related to: '
    + labels.join(', ') + '. Respond ONLY with JSON of the form '
    + '{"match": boolean, "angles": string[]} where angles is the subset of exactly those topics '
    + 'the post matches. No prose.';
}
```

Replace the `classify` method with:

```ts
  async classify(text: string, labels: string[]): Promise<ClassifyResult> {
    if (labels.length === 0) return { match: false, angles: [] };
    const content = await this.chat(classifySystem(labels), text, true);
    const parsed = classifySchema.parse(JSON.parse(content));
    const canon = new Map(labels.map(l => [l.toLowerCase(), l]));
    const angles: string[] = [];
    for (const a of parsed.angles ?? []) {
      const hit = canon.get(String(a).toLowerCase());
      if (hit && !angles.includes(hit)) angles.push(hit);
    }
    return { match: angles.length > 0, angles };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- ollama`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/ai/provider.ts packages/api/src/ai/ollama.ts packages/api/__tests__/ollama.test.ts
git commit -m "feat(api): classify constrained to configured filter labels"
```

---

### Task 3: Processor passes current filter labels

**Files:**
- Modify: `packages/api/src/ai/processor.ts`
- Test: `packages/api/__tests__/processor.test.ts`

**Interfaces:**
- Consumes: `repo.getFilters()` (Task 1); `provider.classify(text, labels)` (Task 2).
- Produces: processor reads `repo.getFilters().map(f => f.label)` once per `processBatch`/`processAll` and passes the labels to `classify`.

- [ ] **Step 1: Update the existing tests + add one** — in `packages/api/__tests__/processor.test.ts`:

Change `mockProvider` so `classify` accepts the labels argument:

```ts
function mockProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async (t: string, _labels: string[]) => ({ match: t.includes('1'), angles: t.includes('1') ? ['money'] : [] })),
    translate: vi.fn(async () => 'traduzido'),
    ...over,
  };
}
```

Add this test inside the `describe('aiProcessor', ...)` block:

```ts
  it('passes the configured filter labels to classify', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.setFilters([{ label: 'tech', color: '#111111', emoji: '🤖' }]);
    repo.upsertPosts([makePost('1')]);
    const provider = mockProvider();
    await createAiProcessor({ repo, provider }).processBatch();
    expect(provider.classify).toHaveBeenCalledWith('text 1', ['tech']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- processor`
Expected: FAIL — `classify` was called with one argument (`'text 1'`), not `['tech']`.

- [ ] **Step 3: Update the processor** — replace `packages/api/src/ai/processor.ts` with:

```ts
import type { createRepo } from '../store/repo.js';
import type { AiProvider } from './provider.js';
import type { Post } from '../types.js';
import { logger } from '../logger.js';

type Repo = ReturnType<typeof createRepo>;

export function createAiProcessor(deps: { repo: Repo; provider: AiProvider; batchSize?: number }): {
  processBatch(): Promise<number>;
  processAll(): Promise<void>;
} {
  const { repo, provider } = deps;
  const batchSize = deps.batchSize ?? 25;

  async function processOne(post: Post, labels: string[]): Promise<void> {
    try {
      const { match, angles } = await provider.classify(post.text, labels);
      const textPt = match ? await provider.translate(post.text) : null;
      repo.setPostAi(post.id, { status: 'done', match, angles, textPt });
    } catch (err) {
      logger.warn({ err, id: post.id }, 'ai processing failed');
      repo.setPostAi(post.id, { status: 'error' });
    }
  }

  async function processBatch(): Promise<number> {
    const labels = repo.getFilters().map(f => f.label);
    const posts = repo.listPostsNeedingAi(batchSize);
    for (const post of posts) await processOne(post, labels);
    return posts.length;
  }

  async function processAll(): Promise<void> {
    const labels = repo.getFilters().map(f => f.label);
    const attempted = new Set<string>();
    const allPosts = repo.listPostsNeedingAi(Number.MAX_SAFE_INTEGER);
    for (const post of allPosts) {
      if (attempted.has(post.id)) continue;
      attempted.add(post.id);
      await processOne(post, labels);
    }
  }

  return { processBatch, processAll };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- processor`
Expected: PASS (all processor tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/ai/processor.ts packages/api/__tests__/processor.test.ts
git commit -m "feat(api): processor passes configured labels to classify"
```

---

### Task 4: Settings routes (GET/PUT/reclassify)

**Files:**
- Modify: `packages/api/src/http/routes.ts`
- Test: `packages/api/__tests__/routes.test.ts` (append)

**Interfaces:**
- Consumes: `repo.getFilters`, `repo.setFilters`, `repo.resetAiStatus` (Task 1); existing `triggerFetch`.
- Produces: `GET /api/settings` → `{ filters }`; `PUT /api/settings` `{filters}` → validates + `{ filters }`; `POST /api/settings/reclassify` → `{ queued }`.

- [ ] **Step 1: Write the failing test** — append to `packages/api/__tests__/routes.test.ts`:

```ts
describe('settings routes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('GET /settings returns the default filters', async () => {
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.filters.map((f: { label: string }) => f.label)).toEqual(['money', 'entrepreneurship', 'business', 'economy']);
  });

  it('PUT /settings saves valid filters', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const ok = await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'tech', color: '#112233', emoji: '🤖' }] }));
    expect(ok.status).toBe(200);
    expect(ok.body.filters).toEqual([{ label: 'tech', color: '#112233', emoji: '🤖' }]);
    const got = await auth(request(ctx.app).get('/api/settings'));
    expect(got.body.filters[0].label).toBe('tech');
  });

  it('PUT /settings rejects invalid input', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [] }))).status).toBe(400);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'x', color: 'red', emoji: '' }] }))).status).toBe(400);
    expect((await auth(request(ctx.app).put('/api/settings').send({ filters: [{ label: 'a', color: '#111111', emoji: '' }, { label: 'A', color: '#222222', emoji: '' }] }))).status).toBe(400);
  });

  it('POST /settings/reclassify resets posts and returns the queued count', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    ctx.repo.upsertPosts([{ id: '1', handle: 'h', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' }]);
    ctx.repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    const res = await auth(request(ctx.app).post('/api/settings/reclassify'));
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
    expect(ctx.repo.listPostsNeedingAi(10)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- routes`
Expected: FAIL — `GET /api/settings` returns 404.

- [ ] **Step 3: Add the schemas + routes** — in `packages/api/src/http/routes.ts`:

Add near the other zod schemas (top of file):

```ts
const filterSchema = z.object({
  label: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  emoji: z.string().max(8).optional().default(''),
});
const filtersBodySchema = z.object({
  filters: z.array(filterSchema).min(1).max(20).refine(
    fs => new Set(fs.map(f => f.label.toLowerCase())).size === fs.length,
    'labels must be unique',
  ),
});
```

Add these routes before `return router;`:

```ts
  router.get('/settings', auth, (_req: Request, res: Response) => {
    res.json({ filters: repo.getFilters() });
  });

  router.put('/settings', auth, (req: Request, res: Response) => {
    const body = filtersBodySchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'invalid filters' }); return; }
    repo.setFilters(body.data.filters);
    res.json({ filters: repo.getFilters() });
  });

  router.post('/settings/reclassify', auth, (_req: Request, res: Response) => {
    const queued = repo.resetAiStatus();
    triggerFetch();
    res.json({ queued });
  });
```

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `npm test --workspace @x-osint/api && npm run typecheck --workspace @x-osint/api`
Expected: all pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/http/routes.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): settings routes for filters and reclassify"
```

---

### Task 5: Frontend API client

**Files:**
- Modify: `packages/www/src/services/api.ts`
- Test: `packages/www/__tests__/api.test.ts` (append)

**Interfaces:**
- Produces: `Filter` interface `{ label; color; emoji }`; `api.getSettings(): Promise<{ filters: Filter[] }>`; `api.saveSettings(filters): Promise<{ filters: Filter[] }>`; `api.reclassifyAll(): Promise<{ queued: number }>`.

- [ ] **Step 1: Write the failing test** — append to `packages/www/__tests__/api.test.ts`:

```ts
describe('settings api', () => {
  beforeEach(() => { api.setToken('tok'); });

  it('getSettings GETs /settings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filters: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.getSettings();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect((opts as RequestInit).method).toBe('GET');
  });

  it('saveSettings PUTs the filters', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filters: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.saveSettings([{ label: 'tech', color: '#112233', emoji: '🤖' }]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect((opts as RequestInit).method).toBe('PUT');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ filters: [{ label: 'tech', color: '#112233', emoji: '🤖' }] });
  });

  it('reclassifyAll POSTs /settings/reclassify', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.reclassifyAll()).toEqual({ queued: 3 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings/reclassify');
    expect((opts as RequestInit).method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/www -- api`
Expected: FAIL — `api.getSettings is not a function`.

- [ ] **Step 3: Add the type + methods** — in `packages/www/src/services/api.ts`:

Add near the other interfaces:

```ts
export interface Filter {
  label: string;
  color: string;
  emoji: string;
}
```

Add to the `api` object (after `exportReport`):

```ts
  getSettings(): Promise<{ filters: Filter[] }> { return call<{ filters: Filter[] }>('GET', '/settings'); },
  saveSettings(filters: Filter[]): Promise<{ filters: Filter[] }> { return call<{ filters: Filter[] }>('PUT', '/settings', { filters }); },
  reclassifyAll(): Promise<{ queued: number }> { return call<{ queued: number }>('POST', '/settings/reclassify'); },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/www -- api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/__tests__/api.test.ts
git commit -m "feat(www): api client for settings filters and reclassify"
```

---

### Task 6: Store + Settings view + route + nav

**Files:**
- Modify: `packages/www/src/stores/data.ts`
- Create: `packages/www/src/views/SettingsView.vue`
- Modify: `packages/www/src/router.ts`
- Modify: `packages/www/src/App.vue`

**Interfaces:**
- Consumes: `api.getSettings`, `api.saveSettings`, `api.reclassifyAll`, `Filter` (Task 5).
- Produces: store `filters` ref + `loadFilters()`, `saveFilters(filters)`, `reclassifyAll()`. New `/settings` route + nav link.

- [ ] **Step 1: Extend the store** — in `packages/www/src/stores/data.ts`:

Add `Filter` to the import:

```ts
import { api, type Account, type Post, type ReportParams, type ReportSummary, type Filter } from '../services/api';
```

Add the state + actions inside the store setup (and include them in the `return`):

```ts
  const filters = ref<Filter[]>([]);
  async function loadFilters(): Promise<void> { filters.value = (await api.getSettings()).filters; }
  async function saveFilters(next: Filter[]): Promise<void> { filters.value = (await api.saveSettings(next)).filters; }
  async function reclassifyAll(): Promise<number> { return (await api.reclassifyAll()).queued; }
```

Add `filters, loadFilters, saveFilters, reclassifyAll` to the returned object.

- [ ] **Step 2: Create the Settings view** — `packages/www/src/views/SettingsView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useData } from '../stores/data';
import type { Filter } from '../services/api';

const data = useData();
const rows = ref<Filter[]>([]);
const error = ref('');
const saved = ref(false);
const busy = ref(false);
const reclassMsg = ref('');

onMounted(async () => {
  await data.loadFilters();
  rows.value = data.filters.map(f => ({ ...f }));
});

function addRow(): void { rows.value.push({ label: '', color: '#888888', emoji: '' }); }
function removeRow(i: number): void { rows.value.splice(i, 1); }

function validate(): string | null {
  if (rows.value.length < 1 || rows.value.length > 20) return '1 to 20 filters required';
  const seen = new Set<string>();
  for (const r of rows.value) {
    const label = r.label.trim();
    if (!label || label.length > 40) return 'each filter needs a label (max 40 chars)';
    if (seen.has(label.toLowerCase())) return `duplicate label: ${label}`;
    seen.add(label.toLowerCase());
    if (!/^#[0-9a-fA-F]{6}$/.test(r.color)) return `invalid color for "${label}"`;
    if (r.emoji.length > 8) return `emoji too long for "${label}"`;
  }
  return null;
}

async function save(): Promise<void> {
  error.value = ''; saved.value = false;
  const v = validate();
  if (v) { error.value = v; return; }
  busy.value = true;
  try {
    await data.saveFilters(rows.value.map(r => ({ label: r.label.trim(), color: r.color, emoji: r.emoji })));
    rows.value = data.filters.map(f => ({ ...f }));
    saved.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    busy.value = false;
  }
}

async function reclassify(): Promise<void> {
  reclassMsg.value = '';
  if (!confirm('Re-classify ALL stored posts with the current filters? This runs in the background.')) return;
  busy.value = true;
  try {
    const queued = await data.reclassifyAll();
    reclassMsg.value = `Queued ${queued} posts for re-classification.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'reclassify failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h2 class="text-base font-semibold">Settings — AI filters</h2>
    <p class="text-xs text-gray-400">
      The AI keeps posts related to at least one filter below. New posts use these immediately;
      use "Re-classify all" to re-run posts already collected.
    </p>

    <div class="flex flex-col gap-2">
      <div v-for="(r, i) in rows" :key="i" class="flex items-center gap-2">
        <input v-model="r.emoji" maxlength="8" aria-label="Emoji" placeholder="🙂"
          class="w-12 text-center bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm" />
        <input v-model="r.label" maxlength="40" aria-label="Filter label" placeholder="label"
          class="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1 text-sm" />
        <input v-model="r.color" type="color" aria-label="Color"
          class="w-10 h-8 bg-gray-900 border border-gray-700 rounded" />
        <button class="text-gray-400 hover:text-red-400 text-sm px-2" @click="removeRow(i)">✕</button>
      </div>
      <button class="self-start text-cyan-400 hover:text-cyan-300 text-sm" @click="addRow">+ add filter</button>
    </div>

    <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>
    <p v-if="saved" class="text-green-400 text-xs">Saved.</p>

    <div class="flex gap-2">
      <button :disabled="busy" class="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 rounded px-4 py-2 text-sm" @click="save">Save</button>
      <button :disabled="busy" class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded px-4 py-2 text-sm" @click="reclassify">Re-classify all posts</button>
    </div>
    <p v-if="reclassMsg" class="text-gray-300 text-xs">{{ reclassMsg }}</p>
  </div>
</template>
```

- [ ] **Step 3: Register the route** — in `packages/www/src/router.ts`:

Add the import:

```ts
import SettingsView from './views/SettingsView.vue';
```

Add the route after `/reports`:

```ts
    { path: '/settings', component: SettingsView },
```

- [ ] **Step 4: Add the nav link** — in `packages/www/src/App.vue`, after the Reports `RouterLink`:

```html
      <RouterLink to="/settings" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Settings</RouterLink>
```

- [ ] **Step 5: Build + test**

Run: `npm run build --workspace @x-osint/www && npm test --workspace @x-osint/www`
Expected: `vue-tsc` build clean; tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/www/src/stores/data.ts packages/www/src/views/SettingsView.vue packages/www/src/router.ts packages/www/src/App.vue
git commit -m "feat(www): settings page to edit AI filters and trigger reclassify"
```

---

### Task 7: Feed badges

**Files:**
- Create: `packages/www/src/services/badges.ts`
- Test: `packages/www/__tests__/badges.test.ts` (create)
- Modify: `packages/www/src/views/FeedView.vue`

**Interfaces:**
- Consumes: `Filter` (Task 5); store `filters` + `loadFilters` (Task 6).
- Produces: `badgeStyle(filter?: Filter): Record<string, string>` — inline style for a badge; neutral grey when `filter` is undefined.

- [ ] **Step 1: Write the failing test** — create `packages/www/__tests__/badges.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { badgeStyle } from '../src/services/badges';

describe('badgeStyle', () => {
  it('derives border/text color from the filter color', () => {
    const s = badgeStyle({ label: 'money', color: '#22c55e', emoji: '💰' });
    expect(s.borderColor).toBe('#22c55e');
    expect(s.color).toBe('#22c55e');
    expect(s.backgroundColor).toBe('#22c55e22');
  });

  it('falls back to neutral grey for an unknown filter', () => {
    const s = badgeStyle(undefined);
    expect(s.borderColor).toBe('#6b7280');
    expect(s.color).toBe('#9ca3af');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/www -- badges`
Expected: FAIL — cannot find `../src/services/badges`.

- [ ] **Step 3: Implement the helper** — `packages/www/src/services/badges.ts`:

```ts
import type { Filter } from './api';

export function badgeStyle(filter?: Filter): Record<string, string> {
  if (!filter) {
    return { borderColor: '#6b7280', color: '#9ca3af', backgroundColor: '#6b728022' };
  }
  return { borderColor: filter.color, color: filter.color, backgroundColor: `${filter.color}22` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/www -- badges`
Expected: PASS.

- [ ] **Step 5: Render badges in the Feed** — in `packages/www/src/views/FeedView.vue`:

In `<script setup>`, add imports/helpers (alongside the existing ones):

```ts
import { computed } from 'vue';
import { badgeStyle } from '../services/badges';
import type { Post, Filter } from '../services/api';

const filterByLabel = computed(() => {
  const m = new Map<string, Filter>();
  for (const f of data.filters) m.set(f.label.toLowerCase(), f);
  return m;
});
function angleLabels(p: Post): string[] {
  return p.angles ? p.angles.split(',').filter(Boolean) : [];
}
function filterFor(label: string): Filter | undefined {
  return filterByLabel.value.get(label.toLowerCase());
}
```

> Note: `FeedView.vue` already imports `ref, onMounted` from `vue` and `useData`. Add `computed` to the existing `vue` import rather than duplicating it, and keep the single `import { useData }` line.

Update `onMounted` so the Feed also loads filters — change the existing `onMounted(() => { data.loadAccounts(); data.loadPosts(); });` to:

```ts
onMounted(() => { data.loadAccounts(); data.loadPosts(); data.loadFilters(); });
```

In the template, inside the post `<article>`, after the `<p ...>{{ p.text }}</p>` line, add the badge row:

```html
        <div v-if="angleLabels(p).length" class="flex flex-wrap gap-1 mt-2">
          <span v-for="lbl in angleLabels(p)" :key="lbl"
            class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
            :style="badgeStyle(filterFor(lbl))">
            <span v-if="filterFor(lbl)?.emoji">{{ filterFor(lbl)!.emoji }}</span>{{ lbl }}
          </span>
        </div>
```

- [ ] **Step 6: Build + test**

Run: `npm run build --workspace @x-osint/www && npm test --workspace @x-osint/www`
Expected: `vue-tsc` build clean; all www tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/www/src/services/badges.ts packages/www/__tests__/badges.test.ts packages/www/src/views/FeedView.vue
git commit -m "feat(www): show matched filter badges on feed posts"
```

---

## Final verification

- [ ] **API suite + typecheck:** `npm test --workspace @x-osint/api && npm run typecheck --workspace @x-osint/api` — all pass, clean.
- [ ] **www suite + build:** `npm test --workspace @x-osint/www && npm run build --workspace @x-osint/www` — pass + clean.
- [ ] **Manual smoke (optional, with the running Docker stack):** open Settings, change a filter color/emoji and add a new filter (e.g. `technology`), Save; click "Re-classify all posts"; after the next poll, confirm Feed posts show the updated badges and the new label can match.

## Self-review notes (coverage check)

- Spec §1 settings storage/default/repo → Task 1 (incl. `resetAiStatus` preserving `exported_at`).
- Spec §2 classify constrained to labels, intersect case-insensitive, `match = angles>0`, empty-labels short-circuit → Task 2.
- Spec §3 processor passes current labels → Task 3.
- Spec §4 API GET/PUT/reclassify + validation bounds → Task 4.
- Spec §5 frontend api client → Task 5; store → Task 6.
- Spec §5 Settings page + nav → Task 6; badges on Feed (with neutral fallback) → Task 7.
- Spec §6 inline color styling → Task 7 (`badgeStyle`).
- Testing: every task TDD; no real Ollama; badge mapping unit-tested as a pure helper (no component-mount infra added).
- Excel export untouched (no task changes `reports/excel.ts`) — matches "no new column".
