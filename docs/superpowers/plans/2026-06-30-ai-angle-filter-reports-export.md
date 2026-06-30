# AI Angle-Filter + Reports/Excel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every collected post for money/entrepreneurship/business/economy angles using a self-hosted LLM, translate matches to Portuguese, and add a Reports view that exports matching stories to Excel (since-last-export or date range).

**Architecture:** A pluggable `AiProvider` interface (default `OllamaProvider`) runs at collection time. The scheduler, after upserting posts, drives a processor that classifies each `pending` post and translates matches; results are stored on the `posts` row. A new Reports API queries `angle_match=1` rows and builds an `.xlsx` with ExcelJS, recording each export so "since last export" can advance.

**Tech Stack:** TypeScript (ESM), Express 5, better-sqlite3, zod, ExcelJS (new), Vitest, Vue 3 + Pinia + Tailwind, Ollama (`gemma3:4b`).

## Global Constraints

- ESM throughout: every relative import ends in `.js` (e.g. `import { x } from './y.js'`), even from `.ts` source. This repo's existing imports do this.
- All `/api/*` routes except `/login` and `/health` are behind the existing Bearer auth middleware. New report routes MUST use `auth`.
- New env vars and defaults (verbatim): `AI_PROVIDER`=`ollama` (`ollama`|`none`), `OLLAMA_HOST`=`http://localhost:11434`, `AI_MODEL`=`gemma3:4b`, `REPORT_TZ`=`Europe/London`.
- The four valid angles (verbatim, lowercase): `money`, `entrepreneurship`, `business`, `economy`.
- Excel columns, in order, exact headers: `Date`, `X handle`, `Text (PT)`, `Post link`.
- Date column format: `YYYY-MM-DD HH:mm`, 24-hour, rendered in `REPORT_TZ`.
- Tests never call a real Ollama. Use a mock `AiProvider` or a stubbed `postJson`.
- Run API tests with `npm test --workspace @x-osint/api`; www tests with `npm test --workspace @x-osint/www`.

---

### Task 1: Config — AI + report env vars

**Files:**
- Modify: `packages/api/src/types.ts` (Config interface)
- Modify: `packages/api/src/config.ts`
- Test: `packages/api/__tests__/config.test.ts`

**Interfaces:**
- Produces: `Config.aiProvider: 'ollama' | 'none'`, `Config.ollamaHost: string`, `Config.aiModel: string`, `Config.reportTz: string`.

- [ ] **Step 1: Write the failing test** — append to `packages/api/__tests__/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config AI defaults', () => {
  it('defaults AI settings when env is absent', () => {
    const c = loadConfig({ X_OSINT_PASSWORD: 'pw' });
    expect(c.aiProvider).toBe('ollama');
    expect(c.ollamaHost).toBe('http://localhost:11434');
    expect(c.aiModel).toBe('gemma3:4b');
    expect(c.reportTz).toBe('Europe/London');
  });

  it('reads AI overrides from env', () => {
    const c = loadConfig({
      X_OSINT_PASSWORD: 'pw', AI_PROVIDER: 'none',
      OLLAMA_HOST: 'http://ollama:11434', AI_MODEL: 'gemma3:1b', REPORT_TZ: 'UTC',
    });
    expect(c.aiProvider).toBe('none');
    expect(c.ollamaHost).toBe('http://ollama:11434');
    expect(c.aiModel).toBe('gemma3:1b');
    expect(c.reportTz).toBe('UTC');
  });

  it('rejects an invalid AI_PROVIDER', () => {
    expect(() => loadConfig({ X_OSINT_PASSWORD: 'pw', AI_PROVIDER: 'openai' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- config`
Expected: FAIL — `c.aiProvider` is undefined.

- [ ] **Step 3: Add fields to the Config interface** — in `packages/api/src/types.ts`, add to `interface Config` (after `nitterInstances`):

```ts
  aiProvider: 'ollama' | 'none';
  ollamaHost: string;
  aiModel: string;
  reportTz: string;
```

- [ ] **Step 4: Populate them in `loadConfig`** — in `packages/api/src/config.ts`, just before the final `return {`, add:

```ts
  const aiProviderRaw = (env.AI_PROVIDER ?? 'ollama').trim();
  if (aiProviderRaw !== 'ollama' && aiProviderRaw !== 'none') {
    throw new Error("AI_PROVIDER must be 'ollama' or 'none'");
  }
  const aiProvider = aiProviderRaw;
```

Then add these keys to the returned object:

```ts
    aiProvider,
    ollamaHost: env.OLLAMA_HOST?.trim() || 'http://localhost:11434',
    aiModel: env.AI_MODEL?.trim() || 'gemma3:4b',
    reportTz: env.REPORT_TZ?.trim() || 'Europe/London',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- config`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/types.ts packages/api/src/config.ts packages/api/__tests__/config.test.ts
git commit -m "feat(api): add AI + report timezone config env vars"
```

---

### Task 2: DB migration — AI columns + exports table

**Files:**
- Modify: `packages/api/src/store/schema.ts`
- Modify: `packages/api/src/store/db.ts`
- Test: `packages/api/__tests__/migrate.test.ts` (create)

**Interfaces:**
- Produces: `posts` rows gain columns `ai_status TEXT`, `angle_match INTEGER`, `angles TEXT`, `text_pt TEXT`. New table `exports(id, exported_at, covered_upto, row_count)`. `openDb(path)` is idempotent and adds missing columns to a pre-existing DB.

- [ ] **Step 1: Write the failing test** — create `packages/api/__tests__/migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/store/db.js';

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
}

describe('migrate', () => {
  it('adds AI columns to a fresh db', () => {
    const db = openDb(':memory:');
    const c = cols(db, 'posts');
    expect(c).toEqual(expect.arrayContaining(['ai_status', 'angle_match', 'angles', 'text_pt']));
  });

  it('adds AI columns to a legacy posts table missing them', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, handle TEXT, text TEXT, url TEXT, media_url TEXT, posted_at TEXT, fetched_at TEXT)`);
    legacy.exec(`INSERT INTO posts (id, handle, text, posted_at, fetched_at) VALUES ('1','h','hi','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    // Re-open the same file-backed db is overkill; simulate by running the migrate path:
    // openDb runs schema + migrate; emulate by importing migrate indirectly via a fresh openDb on a shared file is unnecessary —
    // instead assert migrate is exported and idempotent:
  });

  it('creates the exports table', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'exports')).toEqual(expect.arrayContaining(['id', 'exported_at', 'covered_upto', 'row_count']));
  });
});
```

> Note: delete the second `it(...)` block's body placeholder and replace it with the real legacy test below in Step 4 once `migrate` is exported. Keep tests 1 and 3 as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- migrate`
Expected: FAIL — `ai_status` not in columns; `exports` table missing.

- [ ] **Step 3: Add the exports table to SCHEMA** — in `packages/api/src/store/schema.ts`, append inside the template literal (after the posts indexes):

```sql
CREATE TABLE IF NOT EXISTS exports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exported_at   TEXT NOT NULL,
  covered_upto  TEXT,
  row_count     INTEGER NOT NULL
);
```

- [ ] **Step 4: Add a `migrate` function and call it in `openDb`** — replace `packages/api/src/store/db.ts` with:

```ts
import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

const POST_COLUMNS: Record<string, string> = {
  ai_status: 'TEXT',
  angle_match: 'INTEGER',
  angles: 'TEXT',
  text_pt: 'TEXT',
};

export function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(posts)`).all() as { name: string }[]).map(c => c.name),
  );
  for (const [name, type] of Object.entries(POST_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  }
}

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
```

Now replace the placeholder second test in `migrate.test.ts` with a real one that uses the exported `migrate`:

```ts
import { migrate } from '../src/store/db.js';
// ...inside describe:
  it('adds AI columns to a legacy posts table missing them', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, handle TEXT, text TEXT, url TEXT, media_url TEXT, posted_at TEXT, fetched_at TEXT)`);
    migrate(legacy);
    expect(cols(legacy, 'posts')).toEqual(expect.arrayContaining(['ai_status', 'angle_match', 'angles', 'text_pt']));
    // idempotent second run does not throw
    expect(() => migrate(legacy)).not.toThrow();
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- migrate`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/store/schema.ts packages/api/src/store/db.ts packages/api/__tests__/migrate.test.ts
git commit -m "feat(api): migrate posts table for AI columns and add exports table"
```

---

### Task 3: Repo — AI fields, angle filter, exportable posts, export log

**Files:**
- Modify: `packages/api/src/types.ts` (extend `Post`)
- Modify: `packages/api/src/store/repo.ts`
- Test: `packages/api/__tests__/repo.test.ts` (append)

**Interfaces:**
- Consumes: migrated `posts` + `exports` tables (Task 2).
- Produces (new repo methods):
  - `listPostsNeedingAi(limit: number): Post[]`
  - `setPostAi(id: string, v: { status: 'done' | 'error'; match?: boolean; angles?: string[]; textPt?: string | null }): void`
  - `listPosts(opts)` gains `opts.angleOnly?: boolean`
  - `listExportablePosts(opts: { mode: 'since-last' | 'range'; from?: string; to?: string }): Post[]` (chronological ASC, `angle_match=1` only)
  - `recordExport(v: { coveredUpto: string | null; rowCount: number }): void`
  - `getExportState(): { lastExportAt: string | null; coveredUpto: string | null }`
- `Post` interface gains: `ai_status?: string | null; angle_match?: number | null; angles?: string | null; text_pt?: string | null`.

- [ ] **Step 1: Write the failing test** — append to `packages/api/__tests__/repo.test.ts`:

```ts
describe('repo AI + exports', () => {
  let repo: ReturnType<typeof createRepo>;
  beforeEach(() => { repo = createRepo(openDb(':memory:')); });

  it('lists posts needing AI and updates them', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    expect(repo.listPostsNeedingAi(10)).toHaveLength(1);

    repo.setPostAi('1', { status: 'done', match: true, angles: ['money', 'business'], textPt: 'olá' });
    expect(repo.listPostsNeedingAi(10)).toHaveLength(0);

    const [p] = repo.listPosts({});
    expect(p.angle_match).toBe(1);
    expect(p.angles).toBe('money,business');
    expect(p.text_pt).toBe('olá');
  });

  it('re-queues errored posts for AI', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'error' });
    expect(repo.listPostsNeedingAi(10)).toHaveLength(1);
  });

  it('filters posts by angleOnly', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z'), makePost('2', 'h', '2026-06-19T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    repo.setPostAi('2', { status: 'done', match: false, angles: [] });
    expect(repo.listPosts({ angleOnly: true }).map(p => p.id)).toEqual(['1']);
    expect(repo.listPosts({})).toHaveLength(2);
  });

  it('exports since last export and records progress', () => {
    repo.upsertPosts([makePost('1', 'h', '2026-06-18T00:00:00.000Z'), makePost('2', 'h', '2026-06-20T00:00:00.000Z')]);
    repo.setPostAi('1', { status: 'done', match: true, angles: ['money'], textPt: 'a' });
    repo.setPostAi('2', { status: 'done', match: true, angles: ['business'], textPt: 'b' });

    expect(repo.getExportState()).toEqual({ lastExportAt: null, coveredUpto: null });
    const all = repo.listExportablePosts({ mode: 'since-last' });
    expect(all.map(p => p.id)).toEqual(['1', '2']); // chronological

    repo.recordExport({ coveredUpto: '2026-06-18T00:00:00.000Z', rowCount: 1 });
    const since = repo.listExportablePosts({ mode: 'since-last' });
    expect(since.map(p => p.id)).toEqual(['2']);
    expect(repo.getExportState().coveredUpto).toBe('2026-06-18T00:00:00.000Z');
  });

  it('exports a date range inclusive of bounds', () => {
    repo.upsertPosts([
      makePost('1', 'h', '2026-06-10T00:00:00.000Z'),
      makePost('2', 'h', '2026-06-15T12:00:00.000Z'),
      makePost('3', 'h', '2026-06-20T00:00:00.000Z'),
    ]);
    for (const id of ['1', '2', '3']) repo.setPostAi(id, { status: 'done', match: true, angles: ['money'], textPt: 'x' });
    const r = repo.listExportablePosts({ mode: 'range', from: '2026-06-15T00:00:00.000Z', to: '2026-06-16T00:00:00.000Z' });
    expect(r.map(p => p.id)).toEqual(['2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: FAIL — `repo.listPostsNeedingAi is not a function`.

- [ ] **Step 3: Extend the `Post` type** — in `packages/api/src/types.ts`, add to `interface Post` (after `fetched_at`):

```ts
  ai_status?: string | null;
  angle_match?: number | null;
  angles?: string | null;
  text_pt?: string | null;
```

- [ ] **Step 4: Add `angleOnly` to `listPosts`** — in `packages/api/src/store/repo.ts`, inside `listPosts`, after the `since` clause block, add:

```ts
      if (opts.angleOnly) { where.push('angle_match = 1'); }
```

And update the `listPosts` parameter type to include `angleOnly?: boolean`:

```ts
    listPosts(opts: { handle?: string; q?: string; since?: string; limit?: number; angleOnly?: boolean }): Post[] {
```

- [ ] **Step 5: Add the new methods** — in `packages/api/src/store/repo.ts`, add these inside the returned object (e.g. after `pruneOldPosts`):

```ts
    listPostsNeedingAi(limit: number): Post[] {
      return db.prepare(
        `SELECT * FROM posts
         WHERE ai_status IS NULL OR ai_status = 'pending' OR ai_status = 'error'
         ORDER BY posted_at DESC LIMIT ?`,
      ).all(Math.max(1, Math.floor(limit))) as Post[];
    },

    setPostAi(id: string, v: { status: 'done' | 'error'; match?: boolean; angles?: string[]; textPt?: string | null }): void {
      db.prepare(
        `UPDATE posts SET ai_status = @status, angle_match = @match, angles = @angles, text_pt = @textPt WHERE id = @id`,
      ).run({
        id,
        status: v.status,
        match: v.match === undefined ? null : (v.match ? 1 : 0),
        angles: v.angles ? v.angles.join(',') : null,
        textPt: v.textPt ?? null,
      });
    },

    listExportablePosts(opts: { mode: 'since-last' | 'range'; from?: string; to?: string }): Post[] {
      const where = ['angle_match = 1'];
      const params: Record<string, string> = {};
      if (opts.mode === 'since-last') {
        const covered = (db.prepare('SELECT MAX(covered_upto) AS c FROM exports').get() as { c: string | null }).c;
        if (covered) { where.push('posted_at > @covered'); params.covered = covered; }
      } else {
        if (opts.from) { where.push('posted_at >= @from'); params.from = opts.from; }
        if (opts.to) { where.push('posted_at <= @to'); params.to = opts.to; }
      }
      return db.prepare(
        `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY posted_at ASC`,
      ).all(params) as Post[];
    },

    recordExport(v: { coveredUpto: string | null; rowCount: number }): void {
      db.prepare('INSERT INTO exports (exported_at, covered_upto, row_count) VALUES (?, ?, ?)')
        .run(new Date().toISOString(), v.coveredUpto, v.rowCount);
    },

    getExportState(): { lastExportAt: string | null; coveredUpto: string | null } {
      const row = db.prepare('SELECT MAX(exported_at) AS lastExportAt, MAX(covered_upto) AS coveredUpto FROM exports')
        .get() as { lastExportAt: string | null; coveredUpto: string | null };
      return { lastExportAt: row.lastExportAt ?? null, coveredUpto: row.coveredUpto ?? null };
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- repo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/types.ts packages/api/src/store/repo.ts packages/api/__tests__/repo.test.ts
git commit -m "feat(api): repo methods for AI status, angle filter, exports"
```

---

### Task 4: AI provider — interface + Ollama implementation

**Files:**
- Create: `packages/api/src/ai/provider.ts`
- Create: `packages/api/src/ai/ollama.ts`
- Create: `packages/api/src/ai/factory.ts`
- Test: `packages/api/__tests__/ollama.test.ts` (create)

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  - `provider.ts`: `interface AiProvider { classify(text): Promise<{ match: boolean; angles: string[] }>; translate(text, target?): Promise<string> }`; `const ANGLES = ['money','entrepreneurship','business','economy'] as const`.
  - `ollama.ts`: `type PostJson = (url: string, body: unknown, timeoutMs: number) => Promise<{ ok: boolean; status: number; json: unknown }>`; `class OllamaProvider implements AiProvider` with constructor `({ host, model, postJson? })`.
  - `factory.ts`: `createAiProvider(config: Config): AiProvider | null` (null when `aiProvider==='none'`).

- [ ] **Step 1: Write the failing test** — create `packages/api/__tests__/ollama.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, type PostJson } from '../src/ai/ollama.js';

function stub(content: string): PostJson {
  return vi.fn(async () => ({ ok: true, status: 200, json: { message: { content } } }));
}

describe('OllamaProvider', () => {
  it('classifies and keeps only valid angles', async () => {
    const post = stub(JSON.stringify({ match: true, angles: ['money', 'sports', 'business'] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', postJson: post });
    const r = await p.classify('buy bitcoin and start a company');
    expect(r.match).toBe(true);
    expect(r.angles).toEqual(['money', 'business']);
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).model).toBe('gemma3:4b');
    expect((body as any).format).toBe('json');
  });

  it('treats non-empty angles as a match even if match flag missing', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ angles: ['economy'] })) });
    expect((await p.classify('inflation rises')).match).toBe(true);
  });

  it('throws on malformed JSON content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('not json') });
    await expect(p.classify('x')).rejects.toThrow();
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.classify('x')).rejects.toThrow();
  });

  it('translates returning trimmed content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('  Olá mundo  ') });
    expect(await p.translate('Hello world')).toBe('Olá mundo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- ollama`
Expected: FAIL — cannot find `../src/ai/ollama.js`.

- [ ] **Step 3: Create the provider interface** — `packages/api/src/ai/provider.ts`:

```ts
export const ANGLES = ['money', 'entrepreneurship', 'business', 'economy'] as const;
export type Angle = (typeof ANGLES)[number];

export interface ClassifyResult {
  match: boolean;
  angles: string[];
}

export interface AiProvider {
  classify(text: string): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
}
```

- [ ] **Step 4: Create the Ollama provider** — `packages/api/src/ai/ollama.ts`:

```ts
import { z } from 'zod';
import { ANGLES, type AiProvider, type ClassifyResult } from './provider.js';

const TIMEOUT_MS = 30_000;

export type PostJson = (url: string, body: unknown, timeoutMs: number)
  => Promise<{ ok: boolean; status: number; json: unknown }>;

const defaultPostJson: PostJson = async (url, body, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
};

const CLASSIFY_SYSTEM =
  'You are a strict text classifier. Decide whether the post has at least one of these angles: ' +
  'money, entrepreneurship, business, economy. Respond ONLY with JSON of the form ' +
  '{"match": boolean, "angles": string[]} where angles is a subset of ' +
  '["money","entrepreneurship","business","economy"]. No prose.';

const TRANSLATE_SYSTEM =
  'You are a translator. Translate the user message into European Portuguese. ' +
  'Output ONLY the translation, with no preamble, quotes, or notes.';

const classifySchema = z.object({
  match: z.boolean().optional(),
  angles: z.array(z.string()).optional(),
});

const messageSchema = z.object({ message: z.object({ content: z.string() }) });

export class OllamaProvider implements AiProvider {
  private host: string;
  private model: string;
  private postJson: PostJson;

  constructor(deps: { host: string; model: string; postJson?: PostJson }) {
    this.host = deps.host.replace(/\/$/, '');
    this.model = deps.model;
    this.postJson = deps.postJson ?? defaultPostJson;
  }

  private async chat(system: string, user: string, json: boolean): Promise<string> {
    const res = await this.postJson(`${this.host}/api/chat`, {
      model: this.model,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, TIMEOUT_MS);
    if (!res.ok) throw new Error(`ollama request failed: ${res.status}`);
    return messageSchema.parse(res.json).message.content;
  }

  async classify(text: string): Promise<ClassifyResult> {
    const content = await this.chat(CLASSIFY_SYSTEM, text, true);
    const parsed = classifySchema.parse(JSON.parse(content));
    const valid = (ANGLES as readonly string[]);
    const angles = (parsed.angles ?? []).filter(a => valid.includes(a));
    return { match: parsed.match === true || angles.length > 0, angles };
  }

  async translate(text: string): Promise<string> {
    const content = await this.chat(TRANSLATE_SYSTEM, text, false);
    return content.trim();
  }
}
```

- [ ] **Step 5: Create the factory** — `packages/api/src/ai/factory.ts`:

```ts
import type { Config } from '../types.js';
import type { AiProvider } from './provider.js';
import { OllamaProvider } from './ollama.js';

export function createAiProvider(config: Config): AiProvider | null {
  if (config.aiProvider === 'none') return null;
  return new OllamaProvider({ host: config.ollamaHost, model: config.aiModel });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- ollama`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/ai/provider.ts packages/api/src/ai/ollama.ts packages/api/src/ai/factory.ts packages/api/__tests__/ollama.test.ts
git commit -m "feat(api): pluggable AI provider with Ollama implementation"
```

---

### Task 5: AI processor worker

**Files:**
- Create: `packages/api/src/ai/processor.ts`
- Test: `packages/api/__tests__/processor.test.ts` (create)

**Interfaces:**
- Consumes: repo methods `listPostsNeedingAi`, `setPostAi` (Task 3); `AiProvider` (Task 4).
- Produces: `createAiProcessor(deps: { repo: Repo; provider: AiProvider; batchSize?: number }): { processBatch(): Promise<number>; processAll(): Promise<void> }`. Classifies each pending post; translates only matches; sets `done`/`error`. `processBatch` returns the number of posts processed (0 when none pending). `processAll` loops until a batch processes 0.

- [ ] **Step 1: Write the failing test** — create `packages/api/__tests__/processor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/store/db.js';
import { createRepo } from '../src/store/repo.js';
import { createAiProcessor } from '../src/ai/processor.js';
import type { AiProvider } from '../src/ai/provider.js';
import type { Post } from '../src/types.js';

function makePost(id: string): Post {
  return { id, handle: 'h', text: `text ${id}`, url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z' };
}

function mockProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async (t: string) => ({ match: t.includes('1'), angles: t.includes('1') ? ['money'] : [] })),
    translate: vi.fn(async () => 'traduzido'),
    ...over,
  };
}

describe('aiProcessor', () => {
  it('translates matches and skips translation for non-matches', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1'), makePost('2')]);
    const provider = mockProvider();
    const proc = createAiProcessor({ repo, provider, batchSize: 10 });

    const n = await proc.processBatch();
    expect(n).toBe(2);
    expect(provider.translate).toHaveBeenCalledTimes(1); // only the match

    const posts = repo.listPosts({});
    const p1 = posts.find(p => p.id === '1')!;
    const p2 = posts.find(p => p.id === '2')!;
    expect(p1.angle_match).toBe(1);
    expect(p1.text_pt).toBe('traduzido');
    expect(p2.angle_match).toBe(0);
    expect(p2.text_pt).toBeNull();
    expect(repo.listPostsNeedingAi(10)).toHaveLength(0);
  });

  it('marks a post error when the provider throws', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts([makePost('1')]);
    const provider = mockProvider({ classify: vi.fn(async () => { throw new Error('ollama down'); }) });
    const proc = createAiProcessor({ repo, provider });
    await proc.processBatch();
    const [p] = repo.listPosts({});
    expect(p.ai_status).toBe('error');
  });

  it('processAll drains all pending posts', async () => {
    const repo = createRepo(openDb(':memory:'));
    repo.upsertPosts(Array.from({ length: 5 }, (_, i) => makePost(String(i))));
    const proc = createAiProcessor({ repo, provider: mockProvider(), batchSize: 2 });
    await proc.processAll();
    expect(repo.listPostsNeedingAi(99)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- processor`
Expected: FAIL — cannot find `../src/ai/processor.js`.

- [ ] **Step 3: Implement the processor** — `packages/api/src/ai/processor.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- processor`
Expected: PASS (3 tests).

> Note: in the error test, `processAll` would loop forever because errored posts re-queue; that test uses `processBatch` (single pass), which is correct. `processAll` callers accept that transient errors retry on the next poll, not within the same drain.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/ai/processor.ts packages/api/__tests__/processor.test.ts
git commit -m "feat(api): AI processor classifies posts and translates matches"
```

---

### Task 6: Wire provider + processor into scheduler and startup

**Files:**
- Modify: `packages/api/src/scheduler.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/__tests__/scheduler.test.ts` (create)

**Interfaces:**
- Consumes: `createAiProcessor` (Task 5), `createAiProvider` (Task 4).
- Produces: `createScheduler` deps gain optional `aiProcess?: () => Promise<void>`, invoked after each poll's upsert (covering both new posts and backfill of legacy `NULL` rows).

- [ ] **Step 1: Write the failing test** — create `packages/api/__tests__/scheduler.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- scheduler`
Expected: FAIL — `aiProcess` never called (param not supported).

- [ ] **Step 3: Add `aiProcess` to the scheduler** — in `packages/api/src/scheduler.ts`:

Change the deps type to add the field:

```ts
export function createScheduler(deps: { config: Config; repo: Repo; httpGet?: HttpGet; aiProcess?: () => Promise<void> }): { start(): void; stop(): void; triggerNow(): void } {
  const { config, repo } = deps;
  const httpGet = deps.httpGet ?? httpsGet;
  const aiProcess = deps.aiProcess;
```

Inside `pollOnce`, after the `logger.info({ accounts... }, 'poll complete')` line (still inside the `try`), add:

```ts
      if (aiProcess) {
        try { await aiProcess(); }
        catch (err) { logger.error({ err }, 'ai processing failed'); }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- scheduler`
Expected: PASS.

- [ ] **Step 5: Wire it in `index.ts`** — in `packages/api/src/index.ts`:

Add imports near the top:

```ts
import { createAiProvider } from './ai/factory.js';
import { createAiProcessor } from './ai/processor.js';
```

Replace the scheduler/app construction block with:

```ts
  const provider = createAiProvider(config);
  const processor = provider ? createAiProcessor({ repo, provider }) : null;
  const scheduler = createScheduler({
    config, repo,
    aiProcess: processor ? () => processor.processAll() : undefined,
  });

  // Built SPA lives next to dist/ at runtime: <app>/www
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(here, '..', 'www');

  const app = createApp({
    config, repo,
    triggerFetch: () => scheduler.triggerNow(),
    staticDir,
    aiAvailable: provider !== null,
  });
```

> `createApp` gains `aiAvailable` in Task 8; until then TypeScript will flag it. Implement Task 8 before building/running the server. Tests for this task don't compile `index.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/scheduler.ts packages/api/src/index.ts packages/api/__tests__/scheduler.test.ts
git commit -m "feat(api): drive AI processing from the scheduler and startup"
```

---

### Task 7: Excel workbook builder

**Files:**
- Modify: `packages/api/package.json` (add `exceljs`)
- Create: `packages/api/src/reports/excel.ts`
- Test: `packages/api/__tests__/excel.test.ts` (create)

**Interfaces:**
- Produces: `formatReportDate(iso: string, tz: string): string` → `YYYY-MM-DD HH:mm`; `buildWorkbookBuffer(posts: Post[], tz: string): Promise<Buffer>`.

- [ ] **Step 1: Add the dependency**

Run: `npm install exceljs --workspace @x-osint/api`
Expected: `exceljs` added to `packages/api/package.json` dependencies.

- [ ] **Step 2: Write the failing test** — create `packages/api/__tests__/excel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbookBuffer, formatReportDate } from '../src/reports/excel.js';
import type { Post } from '../src/types.js';

function post(over: Partial<Post>): Post {
  return { id: '1', handle: 'alice', text: 'orig', url: 'https://x.com/alice/status/1', media_url: null, posted_at: '2026-06-18T13:30:00.000Z', fetched_at: '2026-06-18T13:30:00.000Z', text_pt: 'traduzido', angle_match: 1, ...over };
}

describe('excel report', () => {
  it('formats a date in the given timezone', () => {
    // 2026-06-18T13:30Z is 14:30 in Europe/London (BST = UTC+1)
    expect(formatReportDate('2026-06-18T13:30:00.000Z', 'Europe/London')).toBe('2026-06-18 14:30');
    expect(formatReportDate('2026-06-18T13:30:00.000Z', 'UTC')).toBe('2026-06-18 13:30');
  });

  it('builds a workbook with the exact header row and translated text', async () => {
    const buf = await buildWorkbookBuffer([post({})], 'UTC');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Stories')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Date', 'X handle', 'Text (PT)', 'Post link']);
    const r = ws.getRow(2);
    expect(r.getCell(1).value).toBe('2026-06-18 13:30');
    expect(r.getCell(2).value).toBe('@alice');
    expect(r.getCell(3).value).toBe('traduzido');
    expect(r.getCell(4).value).toBe('https://x.com/alice/status/1');
  });

  it('falls back to original text when translation is missing', async () => {
    const buf = await buildWorkbookBuffer([post({ text_pt: null, text: 'fallback' })], 'UTC');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet('Stories')!.getRow(2).getCell(3).value).toBe('fallback');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- excel`
Expected: FAIL — cannot find `../src/reports/excel.js`.

- [ ] **Step 4: Implement the builder** — `packages/api/src/reports/excel.ts`:

```ts
import ExcelJS from 'exceljs';
import type { Post } from '../types.js';

export function formatReportDate(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl can emit "24" for midnight under hourCycle quirks; normalize.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

export async function buildWorkbookBuffer(posts: Post[], tz: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stories');
  ws.columns = [
    { header: 'Date', key: 'date', width: 18 },
    { header: 'X handle', key: 'handle', width: 18 },
    { header: 'Text (PT)', key: 'text', width: 80 },
    { header: 'Post link', key: 'link', width: 45 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of posts) {
    ws.addRow({
      date: formatReportDate(p.posted_at, tz),
      handle: `@${p.handle}`,
      text: p.text_pt ?? p.text,
      link: p.url ?? '',
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- excel`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/package.json packages/api/src/reports/excel.ts packages/api/__tests__/excel.test.ts ../../package-lock.json
git commit -m "feat(api): build xlsx report workbook with exceljs"
```

---

### Task 8: Report routes + angleOnly on /posts

**Files:**
- Modify: `packages/api/src/http/app.ts` (`AppDeps`, pass `aiAvailable` + `reportTz` to routes)
- Modify: `packages/api/src/http/routes.ts`
- Test: `packages/api/__tests__/routes.test.ts` (append)

**Interfaces:**
- Consumes: `repo.listExportablePosts`, `repo.recordExport`, `repo.getExportState`, `repo.listPosts({angleOnly})` (Task 3); `buildWorkbookBuffer` (Task 7).
- Produces: `AppDeps` gains `aiAvailable?: boolean`. `createRoutes(config, repo, triggerFetch, aiAvailable)`.
  - `GET /api/reports/summary?mode=&from=&to=` → `{ count, lastExportAt, aiAvailable }`
  - `POST /api/reports/export` body `{mode, from?, to?}` → xlsx binary, records export
  - `GET /api/posts?...&angleOnly=true` → angle filter

- [ ] **Step 1: Write the failing test** — append to `packages/api/__tests__/routes.test.ts`:

```ts
describe('reports routes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  async function seedMatch(id: string, postedAt: string) {
    ctx.repo.upsertPosts([{ id, handle: 'alice', text: `t${id}`, url: `https://x.com/alice/status/${id}`, media_url: null, posted_at: postedAt, fetched_at: postedAt }]);
    ctx.repo.setPostAi(id, { status: 'done', match: true, angles: ['money'], textPt: `pt${id}` });
  }

  it('summary counts matching posts and reports aiAvailable', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const res = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.lastExportAt).toBeNull();
    expect(typeof res.body.aiAvailable).toBe('boolean');
  });

  it('export returns an xlsx and advances since-last', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const res = await auth(request(ctx.app).post('/api/reports/export').send({ mode: 'since-last' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Buffer.isBuffer(res.body) || res.body.length > 0).toBeTruthy();
    // a second since-last summary now shows 0 (export advanced covered_upto)
    const after = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(after.body.count).toBe(0);
    expect(after.body.lastExportAt).not.toBeNull();
  });

  it('filters /posts by angleOnly', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    ctx.repo.upsertPosts([{ id: '2', handle: 'alice', text: 't2', url: null, media_url: null, posted_at: '2026-06-19T00:00:00.000Z', fetched_at: '2026-06-19T00:00:00.000Z' }]);
    ctx.repo.setPostAi('2', { status: 'done', match: false, angles: [] });
    const all = await auth(request(ctx.app).get('/api/posts'));
    expect(all.body).toHaveLength(2);
    const only = await auth(request(ctx.app).get('/api/posts?angleOnly=true'));
    expect(only.body.map((p: { id: string }) => p.id)).toEqual(['1']);
  });
});
```

> In `setup()` (top of this file) pass `aiAvailable: true` to `createApp` so the summary assertion is meaningful: change `createApp({ config, repo, triggerFetch })` to `createApp({ config, repo, triggerFetch, aiAvailable: true })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/api -- routes`
Expected: FAIL — `/api/reports/summary` returns 404.

- [ ] **Step 3: Thread `aiAvailable` through `app.ts`** — in `packages/api/src/http/app.ts`:

Add to `AppDeps`:

```ts
  aiAvailable?: boolean;
```

Change the routes mount line to pass it:

```ts
  app.use('/api', createRoutes(deps.config, deps.repo, deps.triggerFetch, deps.aiAvailable ?? false));
```

- [ ] **Step 4: Implement the routes** — in `packages/api/src/http/routes.ts`:

Add imports at the top:

```ts
import { buildWorkbookBuffer } from '../reports/excel.js';
```

Change the function signature:

```ts
export function createRoutes(config: Config, repo: Repo, triggerFetch: () => void, aiAvailable = false): Router {
```

Add an `angleOnly` flag to the existing `/posts` handler — inside `router.get('/posts', ...)`, extend the `repo.listPosts({...})` call with:

```ts
      angleOnly: q.angleOnly === 'true',
```

Add a zod schema near the other schemas:

```ts
const reportParamsSchema = z.object({
  mode: z.enum(['since-last', 'range']).default('since-last'),
  from: z.string().optional(),
  to: z.string().optional(),
});
```

Add the two report routes (before `return router;`):

```ts
  router.get('/reports/summary', auth, (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse({
      mode: req.query.mode, from: req.query.from, to: req.query.to,
    });
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const posts = repo.listExportablePosts(parsed.data);
    const { lastExportAt } = repo.getExportState();
    res.json({ count: posts.length, lastExportAt, aiAvailable });
  });

  router.post('/reports/export', auth, async (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const posts = repo.listExportablePosts(parsed.data);
    const buffer = await buildWorkbookBuffer(posts, config.reportTz);
    const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
    repo.recordExport({ coveredUpto, rowCount: posts.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="x-osint-report.xlsx"');
    res.send(buffer);
  });
```

> `listExportablePosts` returns posts in ascending `posted_at`, so the last element holds `MAX(posted_at)` — the correct `coveredUpto`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/api -- routes`
Expected: PASS.

- [ ] **Step 6: Typecheck and run the full API suite**

Run: `npm run typecheck --workspace @x-osint/api && npm test --workspace @x-osint/api`
Expected: no type errors; all tests pass. (This also confirms `index.ts` from Task 6 compiles now that `aiAvailable` exists.)

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/http/app.ts packages/api/src/http/routes.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): reports summary/export routes and angleOnly post filter"
```

---

### Task 9: Frontend API client

**Files:**
- Modify: `packages/www/src/services/api.ts`
- Test: `packages/www/__tests__/api.test.ts` (append)

**Interfaces:**
- Produces:
  - `Post` interface gains `angle_match?: number | null; angles?: string | null; text_pt?: string | null`.
  - `api.listPosts(params: { handle?; q?; limit?; angleOnly?: boolean })`
  - `api.reportsSummary(params: { mode: 'since-last' | 'range'; from?: string; to?: string }): Promise<{ count: number; lastExportAt: string | null; aiAvailable: boolean }>`
  - `api.exportReport(params): Promise<void>` — POSTs, reads the blob, triggers a browser download.

- [ ] **Step 1: Write the failing test** — append to `packages/www/__tests__/api.test.ts`:

```ts
describe('reports api', () => {
  beforeEach(() => { api.setToken('tok'); });

  it('reportsSummary builds the query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ count: 3, lastExportAt: null, aiAvailable: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await api.reportsSummary({ mode: 'range', from: '2026-06-01', to: '2026-06-30' });
    expect(r.count).toBe(3);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/reports/summary?');
    expect(url).toContain('mode=range');
    expect(url).toContain('from=2026-06-01');
    expect(url).toContain('to=2026-06-30');
  });

  it('listPosts passes angleOnly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listPosts({ angleOnly: true });
    expect(fetchMock.mock.calls[0][0]).toContain('angleOnly=true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @x-osint/www -- api`
Expected: FAIL — `api.reportsSummary is not a function`.

- [ ] **Step 3: Extend the `Post` interface** — in `packages/www/src/services/api.ts`, add to `interface Post` (after `fetched_at`):

```ts
  angle_match?: number | null;
  angles?: string | null;
  text_pt?: string | null;
```

- [ ] **Step 4: Add the report types + methods** — in `packages/www/src/services/api.ts`:

Add an interface near the top (after `Post`):

```ts
export interface ReportSummary {
  count: number;
  lastExportAt: string | null;
  aiAvailable: boolean;
}
export interface ReportParams {
  mode: 'since-last' | 'range';
  from?: string;
  to?: string;
}
```

Update `listPosts` to accept and forward `angleOnly`:

```ts
  listPosts(params: { handle?: string; q?: string; limit?: number; angleOnly?: boolean }): Promise<Post[]> {
    const qs = new URLSearchParams();
    if (params.handle) qs.set('handle', params.handle);
    if (params.q) qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.angleOnly) qs.set('angleOnly', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return call<Post[]>('GET', `/posts${suffix}`);
  },
```

Add two methods to the `api` object (after `triggerFetch`):

```ts
  reportsSummary(params: ReportParams): Promise<ReportSummary> {
    const qs = new URLSearchParams();
    qs.set('mode', params.mode);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return call<ReportSummary>('GET', `/reports/summary?${qs.toString()}`);
  },
  async exportReport(params: ReportParams): Promise<void> {
    const res = await fetch('/api/reports/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new ApiError(res.status, 'export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'x-osint-report.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @x-osint/www -- api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/__tests__/api.test.ts
git commit -m "feat(www): api client for reports summary/export and angleOnly"
```

---

### Task 10: Frontend data store + Feed angle toggle

**Files:**
- Modify: `packages/www/src/stores/data.ts`
- Modify: `packages/www/src/views/FeedView.vue`

**Interfaces:**
- Consumes: `api.listPosts({angleOnly})`, `api.reportsSummary`, `api.exportReport` (Task 9).
- Produces: store gains `angleOnly` ref + `loadPosts` honoring it; `reportSummary` ref, `loadReportSummary(params)`, `exportReport(params)` actions.

- [ ] **Step 1: Extend the data store** — replace the body of `packages/www/src/stores/data.ts` with:

```ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type Account, type Post, type ReportParams, type ReportSummary } from '../services/api';

export const useData = defineStore('data', () => {
  const accounts = ref<Account[]>([]);
  const posts = ref<Post[]>([]);
  const loading = ref(false);
  const angleOnly = ref(false);
  const reportSummary = ref<ReportSummary | null>(null);

  async function loadAccounts(): Promise<void> { accounts.value = await api.listAccounts(); }
  async function addAccount(handle: string): Promise<void> {
    await api.addAccount(handle);
    await loadAccounts();
  }
  async function toggle(handle: string, enabled: boolean): Promise<void> {
    await api.setEnabled(handle, enabled);
    await loadAccounts();
  }
  async function remove(handle: string): Promise<void> {
    await api.removeAccount(handle);
    await loadAccounts();
  }
  async function loadPosts(params: { handle?: string; q?: string } = {}): Promise<void> {
    loading.value = true;
    try { posts.value = await api.listPosts({ ...params, angleOnly: angleOnly.value, limit: 200 }); }
    finally { loading.value = false; }
  }
  async function refresh(): Promise<void> { await api.triggerFetch(); }
  async function loadReportSummary(params: ReportParams): Promise<void> {
    reportSummary.value = await api.reportsSummary(params);
  }
  async function exportReport(params: ReportParams): Promise<void> {
    await api.exportReport(params);
  }

  return {
    accounts, posts, loading, angleOnly, reportSummary,
    loadAccounts, addAccount, toggle, remove, loadPosts, refresh,
    loadReportSummary, exportReport,
  };
});
```

- [ ] **Step 2: Add the Feed toggle** — in `packages/www/src/views/FeedView.vue`, add a checkbox to the filter row. Inside the `<div class="flex gap-2 items-center">`, after the `<select ...>`, insert:

```html
      <label class="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
        <input type="checkbox" v-model="data.angleOnly" @change="applyFilters" />
        Money/business only
      </label>
```

The existing `applyFilters` already calls `data.loadPosts(...)`, which now reads `angleOnly` from the store — no script change needed.

- [ ] **Step 3: Verify www builds and tests pass**

Run: `npm test --workspace @x-osint/www && npm run build --workspace @x-osint/www`
Expected: tests pass; `vue-tsc` build succeeds (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/www/src/stores/data.ts packages/www/src/views/FeedView.vue
git commit -m "feat(www): feed angle-only toggle and report store actions"
```

---

### Task 11: Reports view + route + nav

**Files:**
- Create: `packages/www/src/views/ReportsView.vue`
- Modify: `packages/www/src/router.ts`
- Modify: `packages/www/src/App.vue`

**Interfaces:**
- Consumes: `useData().loadReportSummary`, `exportReport`, `reportSummary` (Task 10).

- [ ] **Step 1: Create the Reports view** — `packages/www/src/views/ReportsView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useData } from '../stores/data';
import type { ReportParams } from '../services/api';

const data = useData();
const mode = ref<'since-last' | 'range'>('since-last');
const from = ref('');
const to = ref('');
const error = ref('');
const busy = ref(false);

function params(): ReportParams {
  return mode.value === 'range'
    ? { mode: 'range', from: from.value || undefined, to: to.value || undefined }
    : { mode: 'since-last' };
}

async function refreshSummary(): Promise<void> {
  error.value = '';
  try { await data.loadReportSummary(params()); }
  catch (e) { error.value = e instanceof Error ? e.message : 'failed'; }
}

async function doExport(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    await data.exportReport(params());
    await refreshSummary();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'export failed';
  } finally {
    busy.value = false;
  }
}

onMounted(refreshSummary);
</script>

<template>
  <div class="flex flex-col gap-4">
    <h2 class="text-base font-semibold">Reports</h2>

    <p v-if="data.reportSummary && !data.reportSummary.aiAvailable" class="text-amber-400 text-xs">
      AI is disabled or unavailable — posts are not yet classified, so exports may be empty.
    </p>

    <div class="flex flex-col gap-3 bg-gray-800 rounded-lg p-4">
      <div class="flex gap-4 text-sm">
        <label class="flex items-center gap-1">
          <input type="radio" value="since-last" v-model="mode" @change="refreshSummary" /> Since last export
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="range" v-model="mode" @change="refreshSummary" /> Date range
        </label>
      </div>

      <div v-if="mode === 'range'" class="flex gap-2 items-center text-sm">
        <input type="date" v-model="from" @change="refreshSummary"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
        <span class="text-gray-500">to</span>
        <input type="date" v-model="to" @change="refreshSummary"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
      </div>

      <p class="text-sm text-gray-300">
        Matching posts to export:
        <span class="text-cyan-400 font-semibold">{{ data.reportSummary?.count ?? '—' }}</span>
      </p>
      <p class="text-xs text-gray-500">
        Last export:
        {{ data.reportSummary?.lastExportAt ? new Date(data.reportSummary.lastExportAt).toLocaleString() : 'never' }}
      </p>

      <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>

      <button :disabled="busy || (data.reportSummary?.count ?? 0) === 0"
        class="self-start bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 rounded px-4 py-2 text-sm"
        @click="doExport">
        {{ busy ? 'Exporting…' : 'Export to Excel' }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Register the route** — in `packages/www/src/router.ts`:

Add the import:

```ts
import ReportsView from './views/ReportsView.vue';
```

Add the route (after the `/accounts` route):

```ts
    { path: '/reports', component: ReportsView },
```

- [ ] **Step 3: Add the nav link** — in `packages/www/src/App.vue`, after the Accounts `RouterLink`:

```html
      <RouterLink to="/reports" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Reports</RouterLink>
```

- [ ] **Step 4: Verify www builds**

Run: `npm run build --workspace @x-osint/www`
Expected: `vue-tsc -b && vite build` succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/www/src/views/ReportsView.vue packages/www/src/router.ts packages/www/src/App.vue
git commit -m "feat(www): reports view with excel export and date filters"
```

---

### Task 12: Docker + README

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:** none (ops/docs).

- [ ] **Step 1: Add an optional Ollama service** — replace `docker-compose.yml` with (keeping the existing app service settings, adding `ollama` + wiring env):

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      X_OSINT_PASSWORD: ${X_OSINT_PASSWORD}
      OLLAMA_HOST: http://ollama:11434
      AI_MODEL: ${AI_MODEL:-gemma3:4b}
      REPORT_TZ: ${REPORT_TZ:-Europe/London}
    volumes:
      - x-data:/data
    depends_on:
      - ollama
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-models:/root/.ollama
    ports:
      - "11434:11434"

volumes:
  x-data:
  ollama-models:
```

> Preserve any existing app-service keys not shown here (e.g. `restart`) if present in the current file.

- [ ] **Step 2: Document it in the README** — in `README.md`:

Add rows to the env vars table:

```markdown
| `AI_PROVIDER` | ollama | `ollama` (classify+translate via Ollama) or `none` to disable |
| `OLLAMA_HOST` | http://localhost:11434 | Ollama base URL |
| `AI_MODEL` | gemma3:4b | Ollama model for classification + Portuguese translation |
| `REPORT_TZ` | Europe/London | IANA timezone for the Excel report's Date column |
```

Add a section after the API section:

```markdown
## AI & Reports

Posts are classified at collection time for **money / entrepreneurship / business / economy**
angles using a self-hosted Ollama model (`gemma3:4b` by default); matches are translated to
Portuguese. The **Reports** page exports matching stories to an Excel file
(`Date | X handle | Text (PT) | Post link`), either **since the last export** or for a
**date range**. The Feed has a "Money/business only" toggle.

First run, pull the model:

```bash
docker compose exec ollama ollama pull gemma3:4b
```

Ollama runs on CPU by default (fine for `gemma3:4b`); for GPU, see the Ollama Docker docs.
To turn AI off entirely, set `AI_PROVIDER=none` — posts are collected but not classified or
translated, and exports will be empty.
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "docs: document AI/Reports and add optional ollama compose service"
```

---

## Final verification

- [ ] **Run the full API suite:** `npm test --workspace @x-osint/api` — all pass.
- [ ] **Run the full www suite + build:** `npm test --workspace @x-osint/www && npm run build --workspace @x-osint/www` — pass + build clean.
- [ ] **Typecheck API:** `npm run typecheck --workspace @x-osint/api` — no errors.
- [ ] **Manual smoke (optional):** with Ollama running and `gemma3:4b` pulled, start the app, add an account, trigger a fetch, confirm posts get `angle_match` set, toggle the Feed filter, and export an Excel from Reports.

## Self-review notes (coverage check)

- Spec §1 AI provider layer → Tasks 1, 4. `none` returns `null` provider (Task 4/6), summary surfaces `aiAvailable` (Task 8/11).
- Spec §2 classify+translate at collection, schema, backfill → Tasks 2, 3, 5, 6 (backfill = legacy `NULL` rows picked up by `listPostsNeedingAi`, driven each poll).
- Spec §3 Reports view → Task 11. §4 Excel → Task 7. §5 export tracking/since-last → Tasks 3, 8.
- Spec §6 endpoints → Task 8. §7 frontend wiring → Tasks 9, 10, 11. §8 Docker → Task 12. Testing → every task is TDD; AI never hits real Ollama.
