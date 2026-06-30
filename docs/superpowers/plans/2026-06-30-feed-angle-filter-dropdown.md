# Feed Angle-Filter Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Feed's "Money/business only" checkbox with a dropdown offering All posts, Matched (any filter), and one option per configured filter (which isolates that single angle).

**Architecture:** Add an `angle` filter to `repo.listPosts` (exact CSV membership against the stored `angles` column) and pass it through `/api/posts`. On the frontend, the store's `angleOnly` boolean becomes an `angleFilter` string that `loadPosts` maps to either `angleOnly` (any) or `angle` (specific), and the Feed checkbox becomes a `<select>` populated from the editable filters already in the store.

**Tech Stack:** TypeScript (ESM), Express 5, better-sqlite3, Vue 3 + Pinia + Tailwind, Vitest.

## Global Constraints

- ESM throughout: relative imports end in `.js`.
- The `angle` value is used ONLY as a bound SQL parameter — never interpolated into SQL.
- Exact CSV membership check (avoids substring false-positives like `eco`→`economy`):
  `(',' || angles || ',') LIKE @anglePat` with `params.anglePat = `%,${angle},%``.
- The existing `angleOnly` query param + behavior (`angle_match = 1`) is RETAINED, not removed.
- Store sentinel values: `''` = all posts; `'__any__'` = matched-any; any other string = a filter label.
- `/api/posts` stays behind the existing `auth` middleware (it already is).
- Feed only — Reports/Excel untouched.
- API tests: `npm test --workspace @x-osint/api`. www tests: `npm test --workspace @x-osint/www`. www build: `npm run build --workspace @x-osint/www`.

---

### Task 1: Backend — `angle` filter on listPosts + /api/posts

**Files:**
- Modify: `packages/api/src/store/repo.ts` (`listPosts`)
- Modify: `packages/api/src/http/routes.ts` (`/posts` handler)
- Test: `packages/api/__tests__/repo.test.ts` (append), `packages/api/__tests__/routes.test.ts` (append)

**Interfaces:**
- Produces: `repo.listPosts(opts)` accepts `angle?: string`; when set, filters to posts whose `angles` CSV contains that exact label. `/api/posts?angle=<label>` passes it through.

- [ ] **Step 1: Write the failing repo test** — append to `packages/api/__tests__/repo.test.ts`:

```ts
describe('repo angle filter', () => {
  let repo: ReturnType<typeof createRepo>;
  beforeEach(() => { repo = createRepo(openDb(':memory:')); });

  it('filters posts by an exact angle label (CSV membership, no substring match)', () => {
    repo.upsertPosts([
      makePost('1', 'h', '2026-06-18T00:00:00.000Z'),
      makePost('2', 'h', '2026-06-19T00:00:00.000Z'),
    ]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money', 'business'], textPt: 'a' });
    repo.setPostAi('2', { status: 'done', match: true, angles: ['economy'], textPt: 'b' });
    expect(repo.listPosts({ angle: 'money' }).map(p => p.id)).toEqual(['1']);
    expect(repo.listPosts({ angle: 'business' }).map(p => p.id)).toEqual(['1']);
    expect(repo.listPosts({ angle: 'economy' }).map(p => p.id)).toEqual(['2']);
    expect(repo.listPosts({ angle: 'eco' })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run repo test to verify it fails**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: FAIL — `angle` is ignored, so `{ angle: 'money' }` returns both posts.

- [ ] **Step 3: Add the `angle` clause to `listPosts`** — in `packages/api/src/store/repo.ts`, update the `listPosts` signature and add the clause after the existing `angleOnly` line:

```ts
    listPosts(opts: { handle?: string; q?: string; since?: string; limit?: number; angleOnly?: boolean; angle?: string }): Post[] {
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (opts.handle) { where.push('handle = @handle'); params.handle = opts.handle; }
      if (opts.q) { where.push('text LIKE @q'); params.q = `%${opts.q}%`; }
      if (opts.since) { where.push('posted_at > @since'); params.since = opts.since; }
      if (opts.angleOnly) { where.push('angle_match = 1'); }
      if (opts.angle) { where.push("(',' || angles || ',') LIKE @anglePat"); params.anglePat = `%,${opts.angle},%`; }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : '';
      return db.prepare(`SELECT * FROM posts ${clause} ORDER BY posted_at DESC ${limit}`).all(params) as Post[];
    },
```

- [ ] **Step 4: Run repo test to verify it passes**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: PASS.

- [ ] **Step 5: Write the failing routes test** — append to `packages/api/__tests__/routes.test.ts`:

```ts
describe('posts angle filter route', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('filters /posts by a specific angle label', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    ctx.repo.upsertPosts([
      { id: '1', handle: 'alice', text: 't1', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' },
      { id: '2', handle: 'alice', text: 't2', url: null, media_url: null, posted_at: '2026-06-19T00:00:00.000Z', fetched_at: '2026-06-19T00:00:00.000Z' },
    ]);
    ctx.repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    ctx.repo.setPostAi('2', { status: 'done', match: true, angles: ['business'], textPt: 'y' });
    const res = await auth(request(ctx.app).get('/api/posts?angle=money'));
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(['1']);
  });
});
```

- [ ] **Step 6: Run routes test to verify it fails**

Run: `npm test --workspace @x-osint/api -- routes`
Expected: FAIL — `angle` is ignored, so both posts return.

- [ ] **Step 7: Pass `angle` through the `/posts` handler** — in `packages/api/src/http/routes.ts`, inside the `router.get('/posts', ...)` handler, add `angle` to the `repo.listPosts({...})` call:

```ts
    res.json(repo.listPosts({
      handle: typeof q.handle === 'string' ? normalizeHandle(q.handle) : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      since: typeof q.since === 'string' ? q.since : undefined,
      limit,
      angleOnly: q.angleOnly === 'true',
      angle: typeof q.angle === 'string' ? q.angle : undefined,
    }));
```

- [ ] **Step 8: Run the full API suite + typecheck**

Run: `npm test --workspace @x-osint/api && npm run typecheck --workspace @x-osint/api`
Expected: all pass; no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/store/repo.ts packages/api/src/http/routes.ts packages/api/__tests__/repo.test.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): filter posts by a specific angle label"
```

---

### Task 2: Frontend API client — `angle` param

**Files:**
- Modify: `packages/www/src/services/api.ts` (`listPosts`)
- Test: `packages/www/__tests__/api.test.ts` (append)

**Interfaces:**
- Consumes: `/api/posts?angle=` (Task 1).
- Produces: `api.listPosts` accepts `angle?: string` and sets `angle=<value>` in the query.

- [ ] **Step 1: Write the failing test** — append to the existing `describe('reports api', ...)` block in `packages/www/__tests__/api.test.ts` (it already has `beforeEach(() => { api.setToken('tok'); })`):

```ts
  it('listPosts passes a specific angle', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listPosts({ angle: 'money' });
    expect(fetchMock.mock.calls[0][0]).toContain('angle=money');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/www -- api`
Expected: FAIL — the URL has no `angle=money` (param ignored).

- [ ] **Step 3: Add the `angle` param** — in `packages/www/src/services/api.ts`, update `listPosts`:

```ts
  listPosts(params: { handle?: string; q?: string; limit?: number; angleOnly?: boolean; angle?: string }): Promise<Post[]> {
    const qs = new URLSearchParams();
    if (params.handle) qs.set('handle', params.handle);
    if (params.q) qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.angleOnly) qs.set('angleOnly', 'true');
    if (params.angle) qs.set('angle', params.angle);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return call<Post[]>('GET', `/posts${suffix}`);
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/www -- api`
Expected: PASS (existing `angleOnly` test still passes too).

- [ ] **Step 5: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/__tests__/api.test.ts
git commit -m "feat(www): listPosts supports a specific angle param"
```

---

### Task 3: Store `angleFilter` + Feed dropdown

**Files:**
- Modify: `packages/www/src/stores/data.ts`
- Modify: `packages/www/src/views/FeedView.vue`

**Interfaces:**
- Consumes: `api.listPosts({ angle })` (Task 2); store `filters` (already present from the badges work).
- Produces: store `angleFilter` string ref (replaces `angleOnly` boolean); `loadPosts` maps it to the API call.

- [ ] **Step 1: Replace `angleOnly` with `angleFilter` in the store** — in `packages/www/src/stores/data.ts`:

Change the ref declaration:

```ts
  const angleFilter = ref('');
```

Replace `loadPosts` with:

```ts
  async function loadPosts(params: { handle?: string; q?: string } = {}): Promise<void> {
    loading.value = true;
    const sel = angleFilter.value;
    const extra = sel === '' ? {} : sel === '__any__' ? { angleOnly: true } : { angle: sel };
    try { posts.value = await api.listPosts({ ...params, ...extra, limit: 200 }); }
    finally { loading.value = false; }
  }
```

In the store's returned object, replace `angleOnly` with `angleFilter` (keep every other returned key as-is).

- [ ] **Step 2: Replace the checkbox with a dropdown in the Feed** — in `packages/www/src/views/FeedView.vue`, replace the existing angle checkbox block:

```html
      <label class="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
        <input type="checkbox" v-model="data.angleOnly" @change="applyFilters" />
        Money/business only
      </label>
```

with this `<select>` (same styling as the existing `handleFilter` select):

```html
      <select v-model="data.angleFilter" @change="applyFilters"
        class="bg-gray-900 border border-gray-700 rounded px-2 py-2 text-sm">
        <option value="">All posts</option>
        <option value="__any__">Matched (any filter)</option>
        <option v-for="f in data.filters" :key="f.label" :value="f.label">{{ f.emoji }} {{ f.label }}</option>
      </select>
```

(The Feed already calls `data.loadFilters()` in `onMounted`, so `data.filters` is populated.)

- [ ] **Step 3: Build + test**

Run: `npm run build --workspace @x-osint/www && npm test --workspace @x-osint/www`
Expected: `vue-tsc` build clean (this also confirms no lingering `data.angleOnly` reference remains); all www tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/www/src/stores/data.ts packages/www/src/views/FeedView.vue
git commit -m "feat(www): replace feed angle checkbox with All/any/per-filter dropdown"
```

---

## Final verification

- [ ] **API suite + typecheck:** `npm test --workspace @x-osint/api && npm run typecheck --workspace @x-osint/api` — all pass, clean.
- [ ] **www suite + build:** `npm test --workspace @x-osint/www && npm run build --workspace @x-osint/www` — pass + clean (build fails if any `data.angleOnly` reference was missed).
- [ ] **Manual smoke (optional, running stack):** on the Feed, the dropdown lists All posts / Matched (any filter) / each filter (emoji + label); selecting `💰 money` shows only money-matched posts; "Matched (any filter)" matches today's checkbox; "All posts" shows everything.

## Self-review notes (coverage check)

- Spec §1 backend angle filter (CSV membership, parameterized, angleOnly retained) → Task 1.
- Spec §2 API `angle` query param → Task 1.
- Spec §3 www api client `angle` → Task 2.
- Spec §4 store `angleFilter` replacing `angleOnly`, sentinel mapping → Task 3.
- Spec §5 Feed `<select>` with All / Matched-any / per-filter options → Task 3.
- Testing: repo exact-membership (incl. no-substring), routes `angle`, www api `angle` → Tasks 1–2; select wiring via build gate → Task 3.
- NULL-`angles` posts: `(',' || angles || ',')` is NULL for them → excluded from specific/any views, shown only under "All posts" (matches spec) — covered implicitly by the membership SQL.
