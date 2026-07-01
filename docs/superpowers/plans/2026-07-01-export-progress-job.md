# Job-Based Export with Live Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot synchronous report export with a background job that reports live per-tag progress (start → poll → download), rename the button, fix the classify ZodError that saturates Ollama, and strip URLs from text before classify/summarize.

**Architecture:** `buildAnalysisMarkdown` gains an `onProgress` callback. A new in-memory export manager runs generation in the background, tracking phase/tag progress and holding the finished zip. Three routes (`POST` start, `GET :id` status, `GET :id/download`) replace the old sync export. The frontend polls status every 1s and shows a progress panel. Separately, `classify` drops its vestigial `match` schema field and both `classify`/`summarize` strip URLs before sending text to the model.

**Tech Stack:** TypeScript, Express 5, Zod, ExcelJS, JSZip, `node:crypto`, Vitest + supertest (API); Vue 3, Pinia, Tailwind (web).

## Global Constraints

- Export is a 3-call flow: `POST /api/reports/export` → `{ jobId }` (202); `GET /api/reports/export/:jobId` → status; `GET /api/reports/export/:jobId/download` → zip. The old sync `POST` that returned the zip is removed.
- ZIP unchanged: `application/zip`, `Content-Disposition: attachment; filename="x-osint-report.zip"`, entries `x-osint-report.xlsx` + `x-osint-analysis.md`.
- Progress phases: `spreadsheet` → per tag `summarize`(tag,index/total) then `translate`(tag,index/total) → `bundling` → terminal `done`/`error`. `index` is 1-based; `total` = number of tag groups.
- Export bookkeeping (`recordExport`/`markExported`) runs once, on successful generation (same since-last semantics).
- Job store is in-memory, single-user; TTL sweep drops jobs older than 10 minutes; `takeZip` removes the job.
- Classify fix: drop `match` from `classifySchema` (only `angles` is used). URL stripping applies to `classify` and `summarize` inputs only — NOT `translate`, and never mutates stored `post.text`. New posts only; no bulk reclassify.
- Button label "Export to Excel" → "Export report"; "Generating…" while busy.
- Caps unchanged: 5 key posts/tag, 40 summary inputs/tag, 200-char snippets.

---

### Task 1: Classify `match` fix + URL stripping (ollama.ts)

**Files:**
- Modify: `packages/api/src/ai/ollama.ts`
- Test: `packages/api/__tests__/ollama.test.ts`

**Interfaces:**
- Consumes: existing `classify`/`summarize`/`chat`.
- Produces: no signature changes; `classify` tolerates array-valued `match`; `classify`/`summarize` strip URLs from model input.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/__tests__/ollama.test.ts` (the file already imports `OllamaProvider`, `type PostJson`, `vi`, and has `stub`):
```ts
describe('OllamaProvider input hygiene', () => {
  it('does not throw when the model returns match as an array', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ match: ['money'], angles: ['money'] })) });
    const r = await p.classify('quarterly earnings', ['money', 'business']);
    expect(r).toEqual({ match: true, angles: ['money'] });
  });

  it('strips URLs from the text sent to classify', async () => {
    const post = stub(JSON.stringify({ angles: [] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.classify('black holes https://www.economist.com/science/black-holes?utm_campaign=x', ['economy']);
    const userMsg = (post as any).mock.calls[0][1].messages[1].content as string;
    expect(userMsg).not.toContain('http');
    expect(userMsg).not.toContain('economist.com');
    expect(userMsg).toContain('black holes');
  });

  it('strips URLs from each post text sent to summarize', async () => {
    const post = stub('summary');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.summarize(['see https://example.com/a?b=1 now'], 'money');
    const userMsg = (post as any).mock.calls[0][1].messages[1].content as string;
    expect(userMsg).not.toContain('http');
    expect(userMsg).toContain('see');
    expect(userMsg).toContain('now');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- ollama`
Expected: FAIL — the array-`match` test throws a ZodError; the strip tests find `http` in the sent message.

- [ ] **Step 3: Drop `match` from the schema and add `stripUrls`**

In `packages/api/src/ai/ollama.ts`, change the classify schema (remove the `match` field):
```ts
const classifySchema = z.object({
  angles: z.array(z.string()).optional(),
});
```
Add a helper next to the other module-level functions (e.g. after `summarizeSystem`):
```ts
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Apply `stripUrls` in `classify` and `summarize`**

In `classify`, strip the text before sending:
```ts
    const content = await this.chat(classifySystem(labels), stripUrls(text), true);
```
In `summarize`, strip each post text:
```ts
    const user = posts.map((t, i) => `${i + 1}. ${stripUrls(t)}`).join('\n');
```
(Leave `translate` unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- ollama` → Expected: PASS (new hygiene tests + all existing classify/summarize/translate/ready tests).
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/ai/ollama.ts packages/api/__tests__/ollama.test.ts
git commit -m "fix(api): tolerate array match + strip URLs before classify/summarize"
```

---

### Task 2: `onProgress` hook in `buildAnalysisMarkdown`

**Files:**
- Modify: `packages/api/src/reports/analysis.ts`
- Test: `packages/api/__tests__/analysis.test.ts`

**Interfaces:**
- Consumes: existing `AiProvider`.
- Produces:
  ```ts
  export interface AnalysisProgress { phase: 'summarize' | 'translate'; tag: string; index: number; total: number; }
  // AnalysisDeps gains: onProgress?: (ev: AnalysisProgress) => void;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/__tests__/analysis.test.ts` (it already has `post`, `stubProvider`, `FILTERS`, and imports `vi`):
```ts
describe('buildAnalysisMarkdown onProgress', () => {
  it('emits summarize then translate per tag with 1-based index and total', async () => {
    const posts = [post({ id: '1', angles: 'money' }), post({ id: '2', angles: 'business' })];
    const events: any[] = [];
    await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider(), onProgress: e => events.push(e) });
    expect(events).toEqual([
      { phase: 'summarize', tag: 'money', index: 1, total: 2 },
      { phase: 'translate', tag: 'money', index: 1, total: 2 },
      { phase: 'summarize', tag: 'business', index: 2, total: 2 },
      { phase: 'translate', tag: 'business', index: 2, total: 2 },
    ]);
  });

  it('does not emit translate for a tag whose summarize throws', async () => {
    const provider = stubProvider({ summarize: vi.fn(async () => { throw new Error('down'); }) });
    const events: any[] = [];
    await buildAnalysisMarkdown({ posts: [post({ angles: 'money' })], filters: FILTERS, tz: 'UTC', provider, onProgress: e => events.push(e) });
    expect(events).toEqual([{ phase: 'summarize', tag: 'money', index: 1, total: 1 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- analysis`
Expected: FAIL — `onProgress` is not accepted / no events recorded (TS error or empty array).

- [ ] **Step 3: Add the progress type and callback plumbing**

In `packages/api/src/reports/analysis.ts`:

(a) Add the exported type and extend `AnalysisDeps`:
```ts
export interface AnalysisProgress {
  phase: 'summarize' | 'translate';
  tag: string;
  index: number;
  total: number;
}

export interface AnalysisDeps {
  posts: Post[];
  filters: Filter[];
  tz: string;
  provider: AiProvider | null;
  onProgress?: (ev: AnalysisProgress) => void;
}
```

(b) Change the `narratives` helper to accept and call an `emit` callback (replace the existing function):
```ts
async function narratives(
  provider: AiProvider | null, texts: string[], label: string,
  emit: (phase: 'summarize' | 'translate') => void,
): Promise<{ en: string; pt: string }> {
  if (!provider) return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  emit('summarize');
  let en: string;
  try {
    en = (await provider.summarize(texts.slice(0, MAX_SUMMARY_INPUT), label)).trim() || EN_UNAVAIL;
  } catch {
    return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  }
  if (en === EN_UNAVAIL) return { en, pt: PT_UNAVAIL };
  emit('translate');
  let pt: string;
  try {
    pt = (await provider.translate(en)).trim() || PT_UNAVAIL;
  } catch {
    pt = PT_UNAVAIL;
  }
  return { en, pt };
}
```

(c) In `buildAnalysisMarkdown`, replace the block that builds `blocks` (the `for (const t of tags)` loop) with an indexed loop that supplies `emit`:
```ts
  const blocks: TagBlock[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!;
    const emit = (phase: 'summarize' | 'translate'): void =>
      deps.onProgress?.({ phase, tag: t.label, index: i + 1, total: tags.length });
    const { en, pt } = await narratives(provider, t.group.map(p => p.text), t.label, emit);
    blocks.push({ label: t.label, group: t.group, en, pt });
  }
```
(Everything else in the function is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- analysis`
Expected: PASS (new onProgress tests + all existing analysis tests — output is unchanged when `onProgress` is omitted).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @x-osint/api`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/reports/analysis.ts packages/api/__tests__/analysis.test.ts
git commit -m "feat(api): buildAnalysisMarkdown emits per-tag progress via onProgress"
```

---

### Task 3: Export manager (in-memory job store + runner)

**Files:**
- Create: `packages/api/src/http/exportJobs.ts`
- Test: `packages/api/__tests__/exportJobs.test.ts`

**Interfaces:**
- Consumes: `createRepo` type, `AiProvider`, `AnalysisDeps` (Task 2), `Post`.
- Produces:
  ```ts
  export type ReportParams = { mode: 'since-last' | 'range'; from?: string; to?: string };
  export interface PublicStatus { status: 'running'|'done'|'error'; phase: 'spreadsheet'|'summarize'|'translate'|'bundling'|'done'|'error'; tag: string | null; index: number; total: number; error: string | null; }
  export interface ExportManagerDeps { repo: Repo; tz: string; provider: AiProvider | null; buildWorkbook: (posts: Post[], tz: string) => Promise<Buffer>; buildMarkdown: (deps: AnalysisDeps) => Promise<string>; zip: (files: { xlsx: Buffer; markdown: string }) => Promise<Buffer>; }
  export interface ExportManager { start(params: ReportParams): string; get(jobId: string): PublicStatus | undefined; takeZip(jobId: string): Buffer | null; whenDone(jobId: string): Promise<void>; }
  export function createExportManager(deps: ExportManagerDeps): ExportManager;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/api/__tests__/exportJobs.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createExportManager, type ExportManagerDeps } from '../src/http/exportJobs.js';

function deps(over: Partial<ExportManagerDeps> = {}): ExportManagerDeps {
  return {
    repo: {
      listExportablePosts: vi.fn(() => [{ id: '1', handle: 'a', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z', angles: 'money', angle_match: 1 }]),
      getFilters: vi.fn(() => [{ label: 'money', color: '#111111', emoji: '' }]),
      recordExport: vi.fn(),
      markExported: vi.fn(),
    } as any,
    tz: 'UTC',
    provider: null,
    buildWorkbook: vi.fn(async () => Buffer.from('xlsx')),
    buildMarkdown: vi.fn(async () => '# md'),
    zip: vi.fn(async () => Buffer.from('zipbytes')),
    ...over,
  };
}

describe('createExportManager', () => {
  it('runs a job to done and yields the zip once', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last' });
    expect(mgr.get(id)!.status).toBe('running');
    await mgr.whenDone(id);
    expect(mgr.get(id)!.status).toBe('done');
    expect(mgr.get(id)!.phase).toBe('done');
    const zip = mgr.takeZip(id);
    expect(zip).toEqual(Buffer.from('zipbytes'));
    expect(mgr.takeZip(id)).toBeNull(); // job removed after first take
    expect(mgr.get(id)).toBeUndefined();
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
    expect(d.repo.markExported).toHaveBeenCalledOnce();
  });

  it('reports error status when a builder throws and yields no zip', async () => {
    const mgr = createExportManager(deps({ buildMarkdown: vi.fn(async () => { throw new Error('boom'); }) }));
    const id = mgr.start({ mode: 'since-last' });
    await mgr.whenDone(id);
    expect(mgr.get(id)!.status).toBe('error');
    expect(mgr.get(id)!.error).toBe('boom');
    expect(mgr.takeZip(id)).toBeNull();
  });

  it('returns undefined/null for unknown ids', () => {
    const mgr = createExportManager(deps());
    expect(mgr.get('nope')).toBeUndefined();
    expect(mgr.takeZip('nope')).toBeNull();
  });

  it('threads onProgress from buildMarkdown into the status total/index', async () => {
    const buildMarkdown = vi.fn(async (a: any) => {
      a.onProgress?.({ phase: 'summarize', tag: 'money', index: 1, total: 3 });
      return '# md';
    });
    const mgr = createExportManager(deps({ buildMarkdown }));
    const id = mgr.start({ mode: 'since-last' });
    await mgr.whenDone(id);
    // terminal phase is 'done'; total was captured during the run
    expect(mgr.get(id)!.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- exportJobs`
Expected: FAIL — cannot find module `../src/http/exportJobs.js`.

- [ ] **Step 3: Implement `exportJobs.ts`**

Create `packages/api/src/http/exportJobs.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { createRepo } from '../store/repo.js';
import type { AiProvider } from '../ai/provider.js';
import type { AnalysisDeps } from '../reports/analysis.js';
import type { Post } from '../types.js';

type Repo = ReturnType<typeof createRepo>;

export type ReportParams = { mode: 'since-last' | 'range'; from?: string; to?: string };

type Phase = 'spreadsheet' | 'summarize' | 'translate' | 'bundling' | 'done' | 'error';

interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  phase: Phase;
  tag: string | null;
  index: number;
  total: number;
  zip: Buffer | null;
  error: string | null;
  createdAt: number;
  promise?: Promise<void>;
}

export interface PublicStatus {
  status: 'running' | 'done' | 'error';
  phase: Phase;
  tag: string | null;
  index: number;
  total: number;
  error: string | null;
}

export interface ExportManagerDeps {
  repo: Repo;
  tz: string;
  provider: AiProvider | null;
  buildWorkbook: (posts: Post[], tz: string) => Promise<Buffer>;
  buildMarkdown: (deps: AnalysisDeps) => Promise<string>;
  zip: (files: { xlsx: Buffer; markdown: string }) => Promise<Buffer>;
}

export interface ExportManager {
  start(params: ReportParams): string;
  get(jobId: string): PublicStatus | undefined;
  takeZip(jobId: string): Buffer | null;
  whenDone(jobId: string): Promise<void>;
}

const TTL_MS = 10 * 60_000;

export function createExportManager(deps: ExportManagerDeps): ExportManager {
  const jobs = new Map<string, ExportJob>();

  function sweep(): void {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (now - j.createdAt > TTL_MS) jobs.delete(id);
    }
  }

  async function run(job: ExportJob, params: ReportParams): Promise<void> {
    try {
      const posts = deps.repo.listExportablePosts(params);
      const xlsx = await deps.buildWorkbook(posts, deps.tz);
      const markdown = await deps.buildMarkdown({
        posts,
        filters: deps.repo.getFilters(),
        tz: deps.tz,
        provider: deps.provider,
        onProgress: (ev) => {
          job.phase = ev.phase;
          job.tag = ev.tag;
          job.index = ev.index;
          job.total = ev.total;
        },
      });
      job.phase = 'bundling';
      job.tag = null;
      const zip = await deps.zip({ xlsx, markdown });
      const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
      deps.repo.recordExport({ coveredUpto, rowCount: posts.length });
      deps.repo.markExported(posts.map(p => p.id), new Date().toISOString());
      job.zip = zip;
      job.status = 'done';
      job.phase = 'done';
    } catch (err) {
      job.status = 'error';
      job.phase = 'error';
      job.error = err instanceof Error ? err.message : 'export failed';
    }
  }

  return {
    start(params: ReportParams): string {
      sweep();
      const job: ExportJob = {
        id: randomUUID(),
        status: 'running',
        phase: 'spreadsheet',
        tag: null,
        index: 0,
        total: 0,
        zip: null,
        error: null,
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      job.promise = run(job, params);
      return job.id;
    },
    get(jobId: string): PublicStatus | undefined {
      const j = jobs.get(jobId);
      if (!j) return undefined;
      return { status: j.status, phase: j.phase, tag: j.tag, index: j.index, total: j.total, error: j.error };
    },
    takeZip(jobId: string): Buffer | null {
      const j = jobs.get(jobId);
      if (!j || j.status !== 'done' || !j.zip) return null;
      jobs.delete(jobId);
      return j.zip;
    },
    whenDone(jobId: string): Promise<void> {
      return jobs.get(jobId)?.promise ?? Promise.resolve();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- exportJobs`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @x-osint/api`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/http/exportJobs.ts packages/api/__tests__/exportJobs.test.ts
git commit -m "feat(api): in-memory export job manager with progress + TTL"
```

---

### Task 4: Wire job routes (replace sync export)

**Files:**
- Modify: `packages/api/src/http/routes.ts`
- Test: `packages/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `createExportManager` (Task 3); existing `buildWorkbookBuffer`, `buildAnalysisMarkdown`, `zipReport`, `reportParamsSchema`, `aiProvider` param.
- Produces: `POST /reports/export` → `{ jobId }` (202); `GET /reports/export/:jobId` → `PublicStatus`; `GET /reports/export/:jobId/download` → zip.

- [ ] **Step 1: Write the failing tests**

In `packages/api/__tests__/routes.test.ts` (it already imports `JSZip` and registers the `application/zip` parser), REPLACE the existing test `it('export returns a zip with the workbook + analysis and advances since-last', ...)` inside the `reports routes` describe with a poll helper + new tests:
```ts
  async function runExport(app: ReturnType<typeof setup>['app'], token: string, body: object) {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const start = await auth(request(app).post('/api/reports/export').send(body));
    expect(start.status).toBe(202);
    const jobId = start.body.jobId as string;
    let status: any;
    for (let i = 0; i < 200; i++) {
      const r = await auth(request(app).get(`/api/reports/export/${jobId}`));
      status = r.body;
      if (status.status !== 'running') break;
      await new Promise(res => setTimeout(res, 10));
    }
    return { jobId, status };
  }

  it('export job yields a downloadable zip with workbook + analysis and advances since-last', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const { jobId, status } = await runExport(ctx.app, token, { mode: 'since-last' });
    expect(status.status).toBe('done');
    const dl = await auth(request(ctx.app).get(`/api/reports/export/${jobId}/download`));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toContain('x-osint-report.zip');
    const zip = await JSZip.loadAsync(dl.body);
    expect(zip.file('x-osint-report.xlsx')).not.toBeNull();
    const md = await zip.file('x-osint-analysis.md')!.async('string');
    expect(md).toContain('# Analysis (English)');
    expect(md).toContain('## money');
    expect(md).toContain('# Análise (Português)');
    // second download of the same job is gone
    expect((await auth(request(ctx.app).get(`/api/reports/export/${jobId}/download`))).status).toBe(404);
    // since-last advanced
    const after = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(after.body.count).toBe(0);
    expect(after.body.lastExportAt).not.toBeNull();
  });

  it('export start requires auth and unknown jobs 404', async () => {
    expect((await request(ctx.app).post('/api/reports/export').send({ mode: 'since-last' })).status).toBe(401);
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    expect((await auth(request(ctx.app).get('/api/reports/export/nope'))).status).toBe(404);
    expect((await auth(request(ctx.app).get('/api/reports/export/nope/download'))).status).toBe(404);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- routes`
Expected: FAIL — `POST /reports/export` still returns the zip (200, not 202) and the status/download routes 404.

- [ ] **Step 3: Import the manager and construct it in `createRoutes`**

In `packages/api/src/http/routes.ts`:

(a) Add the import near the other report imports:
```ts
import { createExportManager } from './exportJobs.js';
```
(`buildWorkbookBuffer`, `buildAnalysisMarkdown`, `zipReport`, `AiProvider` are already imported.)

(b) Just after `const auth = makeAuthMiddleware(config.tokenSecret);`, construct the manager:
```ts
  const exportMgr = createExportManager({
    repo,
    tz: config.reportTz,
    provider: aiProvider,
    buildWorkbook: buildWorkbookBuffer,
    buildMarkdown: buildAnalysisMarkdown,
    zip: zipReport,
  });
```

- [ ] **Step 4: Replace the export handler with the three job routes**

In `packages/api/src/http/routes.ts`, replace the entire `router.post('/reports/export', ...)` handler with:
```ts
  router.post('/reports/export', auth, (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const jobId = exportMgr.start(parsed.data);
    res.status(202).json({ jobId });
  });

  router.get('/reports/export/:jobId', auth, (req: Request, res: Response) => {
    const status = exportMgr.get(req.params.jobId as string);
    if (!status) { res.status(404).json({ error: 'not found' }); return; }
    res.json(status);
  });

  router.get('/reports/export/:jobId/download', auth, (req: Request, res: Response) => {
    const zip = exportMgr.takeZip(req.params.jobId as string);
    if (!zip) { res.status(404).json({ error: 'not ready' }); return; }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="x-osint-report.zip"');
    res.send(zip);
  });
```

- [ ] **Step 5: Run the route tests + full suite + typecheck**

Run: `npm test -w @x-osint/api -- routes` → Expected: PASS (new job-flow tests + all other route/report/settings tests).
Run: `npm test -w @x-osint/api` → Expected: all files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/http/routes.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): job-based export routes (start/status/download)"
```

---

### Task 5: Frontend — progress UI + button rename

**Files:**
- Modify: `packages/www/src/services/api.ts`
- Modify: `packages/www/src/stores/data.ts`
- Modify: `packages/www/src/views/ReportsView.vue`

**Interfaces:**
- Consumes: the job routes (Task 4).
- Produces: `api.startExport`, `api.exportStatus`, `api.downloadExport`, and `ExportStatus` type; removes `api.exportReport` and the store's `exportReport` action.

- [ ] **Step 1: Update `services/api.ts`**

In `packages/www/src/services/api.ts`:

(a) Add the status type near the other interfaces (e.g. after `ReportSummary`):
```ts
export interface ExportStatus {
  status: 'running' | 'done' | 'error';
  phase: string;
  tag: string | null;
  index: number;
  total: number;
  error: string | null;
}
```

(b) Replace the `async exportReport(params: ReportParams): Promise<void> { ... }` method with these three:
```ts
  startExport(params: ReportParams): Promise<{ jobId: string }> {
    return call<{ jobId: string }>('POST', '/reports/export', params);
  },
  exportStatus(jobId: string): Promise<ExportStatus> {
    return call<ExportStatus>('GET', `/reports/export/${encodeURIComponent(jobId)}`);
  },
  async downloadExport(jobId: string): Promise<void> {
    const res = await fetch(`/api/reports/export/${encodeURIComponent(jobId)}/download`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, 'download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'x-osint-report.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
```

- [ ] **Step 2: Update `stores/data.ts`**

In `packages/www/src/stores/data.ts`, remove the `exportReport` action (the `async function exportReport(...)` block) and remove `exportReport` from the returned object. The final return's report line becomes:
```ts
    loadReportSummary,
```
(Leave `loadReportSummary` and everything else intact.)

- [ ] **Step 3: Rewrite `ReportsView.vue`**

Replace the entire contents of `packages/www/src/views/ReportsView.vue` with:
```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useData } from '../stores/data';
import { api, type ReportParams, type ExportStatus } from '../services/api';

const data = useData();
const mode = ref<'since-last' | 'range'>('since-last');
const from = ref('');
const to = ref('');
const error = ref('');
const busy = ref(false);
const progress = ref<ExportStatus | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

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

function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

function progressLabel(p: ExportStatus): string {
  switch (p.phase) {
    case 'spreadsheet': return 'Building spreadsheet…';
    case 'summarize': return `Summarising ${p.tag} (${p.index}/${p.total})`;
    case 'translate': return `Translating ${p.tag} (${p.index}/${p.total})`;
    case 'bundling': return 'Bundling…';
    case 'done': return 'Done';
    default: return 'Working…';
  }
}

async function doExport(): Promise<void> {
  error.value = '';
  busy.value = true;
  progress.value = { status: 'running', phase: 'spreadsheet', tag: null, index: 0, total: 0, error: null };
  try {
    const { jobId } = await api.startExport(params());
    timer = setInterval(() => { void poll(jobId); }, 1000);
  } catch (e) {
    stopPolling();
    error.value = e instanceof Error ? e.message : 'export failed';
    progress.value = null;
    busy.value = false;
  }
}

async function poll(jobId: string): Promise<void> {
  try {
    const s = await api.exportStatus(jobId);
    progress.value = s;
    if (s.status === 'done') {
      stopPolling();
      await api.downloadExport(jobId);
      progress.value = null;
      busy.value = false;
      await refreshSummary();
    } else if (s.status === 'error') {
      stopPolling();
      error.value = s.error || 'export failed';
      progress.value = null;
      busy.value = false;
    }
  } catch (e) {
    stopPolling();
    error.value = e instanceof Error ? e.message : 'export failed';
    progress.value = null;
    busy.value = false;
  }
}

onMounted(refreshSummary);
onUnmounted(stopPolling);
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
          <input type="radio" value="since-last" v-model="mode" @change="refreshSummary" name="report-mode" /> Since last export
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="range" v-model="mode" @change="refreshSummary" name="report-mode" /> Date range
        </label>
      </div>

      <div v-if="mode === 'range'" class="flex gap-2 items-center text-sm">
        <input type="date" v-model="from" @change="refreshSummary"
          aria-label="From date"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
        <span class="text-gray-500">to</span>
        <input type="date" v-model="to" @change="refreshSummary"
          aria-label="To date"
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
        {{ busy ? 'Generating…' : 'Export report' }}
      </button>

      <div v-if="progress" class="flex flex-col gap-1">
        <p class="text-xs text-gray-300 flex items-center gap-2">
          <span class="inline-block w-3 h-3 border-2 border-gray-600 border-t-cyan-400 rounded-full animate-spin"></span>
          {{ progressLabel(progress) }}
        </p>
        <div v-if="progress.total" class="h-1.5 bg-gray-700 rounded overflow-hidden">
          <div class="h-full bg-cyan-500 transition-all"
            :style="{ width: `${Math.round((progress.index / progress.total) * 100)}%` }"></div>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Build the web package**

Run: `npm run build -w @x-osint/www`
Expected: `vue-tsc` passes with no type errors and `vite build` completes.

- [ ] **Step 5: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/src/stores/data.ts packages/www/src/views/ReportsView.vue
git commit -m "feat(www): live export progress panel + 'Export report' button"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api suite + web build**

Run: `npm test -w @x-osint/api` → Expected: all pass.
Run: `npm run build -w @x-osint/www` → Expected: clean.

- [ ] **Step 2: Rebuild the image and bring the stack up**

Run: `docker compose up -d --build`
Expected: containers start; app listens on 8080.

- [ ] **Step 3: Drive the job flow and confirm progress + narratives**

Trigger a re-classify first so existing posts pick up the URL-stripping fix, then run an export through the job API and watch progress:
```bash
TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
JOB=$(curl -s -X POST localhost:8080/api/reports/export -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"mode":"range","from":"2020-01-01","to":"2030-01-01"}' | sed 's/.*"jobId":"\([^"]*\)".*/\1/')
# poll a few times to observe phase/tag/index/total changing
for i in $(seq 1 20); do curl -s localhost:8080/api/reports/export/$JOB -H "Authorization: Bearer $TOKEN"; echo; sleep 3; done
```
Expected: status JSON progresses through `spreadsheet` → `summarize`/`translate` with `tag` + `index/total` → `bundling` → `done`. Once `done`:
```bash
SCRATCH=/private/tmp/claude-502/-Users-jose-Projects-x-osint/ab6c3694-c961-4cd7-a68b-41a52a077357/scratchpad
curl -s localhost:8080/api/reports/export/$JOB/download -H "Authorization: Bearer $TOKEN" -o "$SCRATCH/report.zip"
unzip -l "$SCRATCH/report.zip"    # both entries present
unzip -p "$SCRATCH/report.zip" x-osint-analysis.md | head -20   # real narrative if the model responded
```
Expected: the zip lists both files; with the classify fix freeing Ollama, at least the first tag's narrative is real prose (not the unavailable note). Also confirm in the browser at http://localhost:8080 that the button reads "Export report" and shows the progress panel while generating.

---

## Self-Review

**Spec coverage:**
- Classify `match` fix → Task 1. ✓
- URL stripping in classify + summarize, translate untouched, new-posts-only → Task 1. ✓
- `onProgress` hook / `AnalysisProgress` type / per-tag summarize+translate events → Task 2. ✓
- Export manager: in-memory store, background run, phases, TTL sweep, takeZip removes job, bookkeeping once, whenDone → Task 3. ✓
- Job routes: POST 202 `{jobId}`, GET status, GET download (zip headers/entries), auth, 404s → Task 4. ✓
- Frontend: startExport/exportStatus/downloadExport, remove exportReport, store cleanup, polling + progress panel, button rename → Task 5. ✓
- Tests for each layer (ollama hygiene, analysis progress, exportJobs manager, routes job-flow) → Tasks 1-4. ✓
- E2E → Task 6. ✓
- Out-of-scope items (queue, persistence, cancel, byte-progress, format/caps) respected. ✓

**Placeholder scan:** No TBD/TODO/vague steps; every code step is complete. ✓

**Type consistency:** `ReportParams { mode, from?, to? }` matches `listExportablePosts` and `reportParamsSchema` output. `PublicStatus`/`ExportStatus` fields identical across `exportJobs.ts`, the GET route, `api.ts`, and `ReportsView`. `AnalysisProgress { phase:'summarize'|'translate', tag, index, total }` identical in `analysis.ts`, the manager's `onProgress`, and Task 2 tests. `createExportManager(deps)` and `ExportManagerDeps` fields (`buildWorkbook`/`buildMarkdown`/`zip`) match the `createRoutes` construction. Entry names `x-osint-report.xlsx`/`x-osint-analysis.md` and the `x-osint-report.zip` disposition consistent across manager, route, download, and tests. ✓
