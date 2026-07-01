# Per-Tag Analysis Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the report export to deliver a ZIP containing the existing spreadsheet plus a new bilingual (English + Portuguese) Markdown analysis document with a per-tag narrative summary, key stats, and key posts.

**Architecture:** A new AI `summarize` capability produces an English narrative per tag; the existing `translate` produces the Portuguese one. A new `analysis.ts` module groups the already-selected exportable posts by tag, computes stats in code, generates narratives, and renders the bilingual Markdown. A new `zip.ts` bundles the `.xlsx` and `.md` into one `.zip`. The export route is rewired to return the zip; the AI provider is threaded from `index.ts → app.ts → routes.ts`.

**Tech Stack:** TypeScript, Express 5, Zod, ExcelJS, JSZip, Vitest + supertest (API); Vue 3 (web).

## Global Constraints

- ZIP filename `x-osint-report.zip`; entries named exactly `x-osint-report.xlsx` and `x-osint-analysis.md`.
- Same post set as today feeds both files: `repo.listExportablePosts(mode/range)` (posts with `angle_match = 1`). No change to which posts are exportable.
- Analysis is bilingual in ONE `.md`: full English section, then `---`, then full Portuguese section.
- Per tag: stats line + AI narrative (3–5 sentences) + "Key posts" list (max 5, newest first).
- Stats and key posts are computed in code and never depend on AI. If the provider is null or a summarize/translate call fails, that tag's narrative is the localized unavailable note; the export never fails because of summarization.
- Localized scaffolding only — user-defined tag labels are NOT translated.
- English unavailable note: `_AI summary unavailable._` Portuguese: `_Resumo de IA indisponível._`
- Caps: max 5 key posts per tag; first 40 post texts per tag fed to `summarize`; ~200-char snippet in key-post lines (append `…` when truncated).
- Use the en-dash `–` (U+2013) in date ranges, matching the spec.
- Add `jszip` as an explicit dependency of `packages/api` (currently only transitive).
- Export bookkeeping (`recordExport`, `markExported`) is unchanged.

---

### Task 1: AI `summarize` capability

**Files:**
- Modify: `packages/api/src/ai/provider.ts` (add `summarize` to the interface)
- Modify: `packages/api/src/ai/ollama.ts` (implement `summarize`)
- Modify: `packages/api/__tests__/processor.test.ts` (add `summarize` to the `mockProvider` literal so it still satisfies `AiProvider`)
- Test: `packages/api/__tests__/ollama.test.ts`

**Interfaces:**
- Consumes: the existing private `OllamaProvider.chat(system, user, json)` helper.
- Produces: `AiProvider.summarize(posts: string[], tag: string): Promise<string>` (required method), implemented by `OllamaProvider`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/__tests__/ollama.test.ts` (the file already imports `OllamaProvider`, `type PostJson`, `type GetJson`, and has the `stub` helper that builds a `PostJson` returning `{ message: { content } }`):
```ts
describe('OllamaProvider.summarize', () => {
  it('summarizes posts, mentions the tag in the system prompt, and returns trimmed prose', async () => {
    const post = stub('  Rates dominated the week.  ');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    const out = await p.summarize(['post one', 'post two'], 'money');
    expect(out).toBe('Rates dominated the week.');
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).format).toBeUndefined(); // prose, not json mode
    const system = (body as any).messages[0].content as string;
    expect(system).toContain('money');
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.summarize(['x'], 'money')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- ollama`
Expected: FAIL — `p.summarize is not a function`.

- [ ] **Step 3: Add `summarize` to the interface**

In `packages/api/src/ai/provider.ts`, add the required method:
```ts
export interface AiProvider {
  classify(text: string, labels: string[]): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
  summarize(posts: string[], tag: string): Promise<string>;
  ready?(): Promise<boolean>;
}
```

- [ ] **Step 4: Implement `summarize` in `OllamaProvider`**

In `packages/api/src/ai/ollama.ts`, add a system-prompt builder next to `classifySystem` / `TRANSLATE_SYSTEM`:
```ts
function summarizeSystem(tag: string): string {
  return 'You are an analyst. Write a concise 3 to 5 sentence analytical summary of the following '
    + `social media posts related to "${tag}". Cover the main themes, notable developments, and overall `
    + 'sentiment. Output ONLY the summary as plain prose — no preamble, no bullet points, no markdown headings.';
}
```
Add the method to the class (after `translate`):
```ts
  async summarize(posts: string[], tag: string): Promise<string> {
    const user = posts.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const content = await this.chat(summarizeSystem(tag), user, false);
    return content.trim();
  }
```

- [ ] **Step 5: Fix the `AiProvider` mock in `processor.test.ts`**

In `packages/api/__tests__/processor.test.ts`, add a `summarize` stub to the `mockProvider` literal so it still satisfies `AiProvider`:
```ts
function mockProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async (t: string, _labels: string[]) => ({ match: t.includes('1'), angles: t.includes('1') ? ['money'] : [] })),
    translate: vi.fn(async () => 'traduzido'),
    summarize: vi.fn(async () => 'resumo'),
    ...over,
  };
}
```

- [ ] **Step 6: Run the api test suite + typecheck**

Run: `npm test -w @x-osint/api -- ollama` → Expected: PASS (the two new summarize tests plus existing classify/translate/ready tests).
Run: `npm test -w @x-osint/api` → Expected: all files pass (confirms `processor.test.ts` still compiles/passes).
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/ai/provider.ts packages/api/src/ai/ollama.ts packages/api/__tests__/ollama.test.ts packages/api/__tests__/processor.test.ts
git commit -m "feat(api): AiProvider.summarize() for per-tag narrative"
```

---

### Task 2: `buildAnalysisMarkdown` module

**Files:**
- Create: `packages/api/src/reports/analysis.ts`
- Test: `packages/api/__tests__/analysis.test.ts`

**Interfaces:**
- Consumes: `Post`, `Filter` from `../types.js`; `AiProvider` from `../ai/provider.js` (`summarize`, `translate` from Task 1).
- Produces:
  ```ts
  export interface AnalysisDeps { posts: Post[]; filters: Filter[]; tz: string; provider: AiProvider | null; }
  export function buildAnalysisMarkdown(deps: AnalysisDeps): Promise<string>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/api/__tests__/analysis.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildAnalysisMarkdown } from '../src/reports/analysis.js';
import type { Post } from '../src/types.js';
import type { AiProvider } from '../src/ai/provider.js';

function post(over: Partial<Post>): Post {
  return {
    id: '1', handle: 'alice', text: 'orig text', url: 'https://x.com/alice/status/1',
    media_url: null, posted_at: '2026-06-18T13:30:00.000Z', fetched_at: '2026-06-18T13:30:00.000Z',
    text_pt: 'texto traduzido', angle_match: 1, angles: 'money', ...over,
  };
}

function stubProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    classify: vi.fn(async () => ({ match: false, angles: [] })),
    translate: vi.fn(async (t: string) => `PT(${t})`),
    summarize: vi.fn(async () => 'English summary.'),
    ...over,
  };
}

const FILTERS = [
  { label: 'money', color: '#111111', emoji: '' },
  { label: 'business', color: '#222222', emoji: '' },
];

describe('buildAnalysisMarkdown', () => {
  it('renders EN then PT sections with per-tag narrative and stats', async () => {
    const posts = [
      post({ id: '1', handle: 'alice', angles: 'money', posted_at: '2026-06-18T00:00:00.000Z' }),
      post({ id: '2', handle: 'bob', angles: 'money', posted_at: '2026-06-20T00:00:00.000Z' }),
    ];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    const enIdx = md.indexOf('# Analysis (English)');
    const ptIdx = md.indexOf('# Análise (Português)');
    expect(enIdx).toBeGreaterThanOrEqual(0);
    expect(ptIdx).toBeGreaterThan(enIdx);
    expect(md).toContain('## money');
    expect(md).toContain('2 posts · 2 accounts · 2026-06-18–2026-06-20');
    expect(md).toContain('English summary.');
    expect(md).toContain('PT(English summary.)');
    expect(md).toContain('2 posts · 2 contas · 2026-06-18–2026-06-20');
  });

  it('groups a multi-angle post under each matching tag and omits empty tags', async () => {
    const posts = [post({ id: '1', angles: 'money,business' })];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('## money');
    expect(md).toContain('## business');
    // a filter with no posts would not appear; both here have the one post
  });

  it('caps key posts at 5 newest-first, truncates snippets, and handles null url', async () => {
    const long = 'x'.repeat(250);
    const posts = Array.from({ length: 6 }, (_, i) => post({
      id: String(i), handle: `u${i}`, angles: 'money',
      posted_at: `2026-06-1${i}T00:00:00.000Z`, url: i === 0 ? null : `https://x.com/u/${i}`,
      text: i === 5 ? long : `t${i}`,
    }));
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    const keyLines = md.split('\n').filter(l => l.startsWith('- @'));
    // 5 EN + 5 PT = 10 lines total
    expect(keyLines.length).toBe(10);
    // newest (id 5, posted 2026-06-15) is first and its long text is truncated with an ellipsis
    expect(md).toContain('@u5: "' + 'x'.repeat(200) + '…"');
  });

  it('uses the localized unavailable note when provider is null', async () => {
    const md = await buildAnalysisMarkdown({ posts: [post({})], filters: FILTERS, tz: 'UTC', provider: null });
    expect(md).toContain('_AI summary unavailable._');
    expect(md).toContain('_Resumo de IA indisponível._');
    expect(md).toContain('## money'); // stats/keyposts still render
  });

  it('shows the note for a tag whose summarize call throws', async () => {
    const provider = stubProvider({ summarize: vi.fn(async () => { throw new Error('down'); }) });
    const md = await buildAnalysisMarkdown({ posts: [post({})], filters: FILTERS, tz: 'UTC', provider });
    expect(md).toContain('_AI summary unavailable._');
    expect(md).toContain('_Resumo de IA indisponível._');
  });

  it('returns a minimal document when there are no posts', async () => {
    const md = await buildAnalysisMarkdown({ posts: [], filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('# Analysis (English)');
    expect(md).toContain('No matching posts for this period.');
    expect(md).toContain('# Análise (Português)');
    expect(md).toContain('Sem posts correspondentes para este período.');
    expect(md).not.toContain('## ');
  });

  it('falls back to a single "All posts" group when no filter matches', async () => {
    const posts = [post({ angles: 'sports' })];
    const md = await buildAnalysisMarkdown({ posts, filters: FILTERS, tz: 'UTC', provider: stubProvider() });
    expect(md).toContain('## All posts');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- analysis`
Expected: FAIL — cannot find module `../src/reports/analysis.js`.

- [ ] **Step 3: Implement `analysis.ts`**

Create `packages/api/src/reports/analysis.ts`:
```ts
import type { Post, Filter } from '../types.js';
import type { AiProvider } from '../ai/provider.js';

export interface AnalysisDeps {
  posts: Post[];
  filters: Filter[];
  tz: string;
  provider: AiProvider | null;
}

const MAX_KEY_POSTS = 5;
const MAX_SUMMARY_INPUT = 40;
const SNIPPET_LEN = 200;
const EN_UNAVAIL = '_AI summary unavailable._';
const PT_UNAVAIL = '_Resumo de IA indisponível._';

function dateOnly(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function rangeLabel(group: Post[], tz: string): string {
  const sorted = group.map(p => p.posted_at).sort();
  const from = dateOnly(sorted[0]!, tz);
  const to = dateOnly(sorted[sorted.length - 1]!, tz);
  return from === to ? from : `${from}–${to}`;
}

function angleSet(p: Post): string[] {
  return (p.angles ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function groupFor(posts: Post[], label: string): Post[] {
  const want = label.toLowerCase();
  return posts.filter(p => angleSet(p).some(a => a.toLowerCase() === want));
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_LEN ? `${t.slice(0, SNIPPET_LEN)}…` : t;
}

function keyPostLine(p: Post, usePt: boolean): string {
  const text = usePt ? (p.text_pt ?? p.text) : p.text;
  const base = `- @${p.handle}: "${snippet(text)}"`;
  return p.url ? `${base} (${p.url})` : base;
}

function keyPosts(group: Post[], usePt: boolean): string[] {
  return [...group]
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at))
    .slice(0, MAX_KEY_POSTS)
    .map(p => keyPostLine(p, usePt));
}

function statsLine(group: Post[], tz: string, accountsWord: string): string {
  const accounts = new Set(group.map(p => p.handle)).size;
  return `${group.length} posts · ${accounts} ${accountsWord} · ${rangeLabel(group, tz)}`;
}

async function narratives(
  provider: AiProvider | null, texts: string[], label: string,
): Promise<{ en: string; pt: string }> {
  if (!provider) return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  let en: string;
  try {
    en = (await provider.summarize(texts.slice(0, MAX_SUMMARY_INPUT), label)).trim() || EN_UNAVAIL;
  } catch {
    return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  }
  if (en === EN_UNAVAIL) return { en, pt: PT_UNAVAIL };
  let pt: string;
  try {
    pt = (await provider.translate(en)).trim() || PT_UNAVAIL;
  } catch {
    pt = PT_UNAVAIL;
  }
  return { en, pt };
}

interface TagBlock { label: string; group: Post[]; en: string; pt: string; }

export async function buildAnalysisMarkdown(deps: AnalysisDeps): Promise<string> {
  const { posts, filters, tz, provider } = deps;

  if (posts.length === 0) {
    return [
      '# Analysis (English)', '',
      'No matching posts for this period.', '',
      '---', '',
      '# Análise (Português)', '',
      'Sem posts correspondentes para este período.', '',
    ].join('\n');
  }

  let tags: { label: string; group: Post[] }[] = [];
  for (const f of filters) {
    const group = groupFor(posts, f.label);
    if (group.length) tags.push({ label: f.label, group });
  }
  if (tags.length === 0) tags = [{ label: 'All posts', group: posts }];

  const blocks: TagBlock[] = [];
  for (const t of tags) {
    const { en, pt } = await narratives(provider, t.group.map(p => p.text), t.label);
    blocks.push({ label: t.label, group: t.group, en, pt });
  }

  const period = rangeLabel(posts, tz);
  const lines: string[] = [];

  lines.push('# Analysis (English)', '', `_Period: ${period} · ${posts.length} posts_`, '');
  for (const b of blocks) {
    lines.push(`## ${b.label}`, statsLine(b.group, tz, 'accounts'), '', b.en, '', '**Key posts**', ...keyPosts(b.group, false), '');
  }

  lines.push('---', '');

  lines.push('# Análise (Português)', '', `_Período: ${period} · ${posts.length} posts_`, '');
  for (const b of blocks) {
    lines.push(`## ${b.label}`, statsLine(b.group, tz, 'contas'), '', b.pt, '', '**Posts principais**', ...keyPosts(b.group, true), '');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- analysis`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @x-osint/api`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/reports/analysis.ts packages/api/__tests__/analysis.test.ts
git commit -m "feat(api): buildAnalysisMarkdown renders bilingual per-tag analysis"
```

---

### Task 3: ZIP bundling + export route + provider plumbing

**Files:**
- Create: `packages/api/src/reports/zip.ts`
- Modify: `packages/api/package.json` (declare `jszip` dependency)
- Modify: `packages/api/src/http/routes.ts` (export handler returns a zip; new `aiProvider` param)
- Modify: `packages/api/src/http/app.ts` (`AppDeps.aiProvider`, thread through)
- Modify: `packages/api/src/index.ts` (pass `provider` to `createApp`)
- Test: `packages/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `buildAnalysisMarkdown` (Task 2); `buildWorkbookBuffer` (existing); `AiProvider` (Task 1).
- Produces: `zipReport(files: { xlsx: Buffer; markdown: string }): Promise<Buffer>`; `createRoutes(..., aiProvider: AiProvider | null = null)`; `AppDeps.aiProvider?: AiProvider | null`.

- [ ] **Step 1: Declare the `jszip` dependency**

In `packages/api/package.json`, add `jszip` to `dependencies` (keep the list alphabetical; version matches what is already resolved in the workspace):
```json
    "fast-xml-parser": "^4.5.0",
    "jszip": "^3.10.0",
    "pino": "^9.4.0",
```
Then run: `npm install`
Expected: `jszip` appears under `packages/api` in the lockfile; no errors.

- [ ] **Step 2: Write the failing route tests**

In `packages/api/__tests__/routes.test.ts`:

(a) Add the JSZip import at the top (after the existing imports) and register the zip content-type with the binary parser so supertest returns a Buffer:
```ts
import JSZip from 'jszip';
(superagent as any).parse['application/zip'] = (superagent as any).parse.image;
```

(b) In the `reports routes` describe block, REPLACE the existing test `it('export returns an xlsx and advances since-last', ...)` with:
```ts
  it('export returns a zip with the workbook + analysis and advances since-last', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const res = await auth(request(ctx.app).post('/api/reports/export').send({ mode: 'since-last' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('x-osint-report.zip');
    const zip = await JSZip.loadAsync(res.body);
    expect(zip.file('x-osint-report.xlsx')).not.toBeNull();
    const md = await zip.file('x-osint-analysis.md')!.async('string');
    expect(md).toContain('# Analysis (English)');
    expect(md).toContain('## money');
    expect(md).toContain('# Análise (Português)');
    // a second since-last summary now shows 0 (export advanced covered_upto)
    const after = await auth(request(ctx.app).get('/api/reports/summary?mode=since-last'));
    expect(after.body.count).toBe(0);
    expect(after.body.lastExportAt).not.toBeNull();
  });
```
(This ctx uses the default `setup()` which passes no `aiProvider`, so the analysis renders with the unavailable-note path — stats/headings/key posts still present, which is what we assert.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- routes`
Expected: FAIL — response is still `spreadsheetml`, not `application/zip` (route not yet changed).

- [ ] **Step 4: Implement `zip.ts`**

Create `packages/api/src/reports/zip.ts`:
```ts
import JSZip from 'jszip';

export async function zipReport(files: { xlsx: Buffer; markdown: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('x-osint-report.xlsx', files.xlsx);
  zip.file('x-osint-analysis.md', files.markdown);
  return zip.generateAsync({ type: 'nodebuffer' });
}
```

- [ ] **Step 5: Rewire the export route**

In `packages/api/src/http/routes.ts`:

(a) Add imports near the top (next to the existing `buildWorkbookBuffer` import):
```ts
import { buildWorkbookBuffer } from '../reports/excel.js';
import { buildAnalysisMarkdown } from '../reports/analysis.js';
import { zipReport } from '../reports/zip.js';
import type { AiProvider } from '../ai/provider.js';
```
(Keep the existing `buildWorkbookBuffer` import line — do not duplicate it; add the three new lines.)

(b) Change the `createRoutes` signature to add the `aiProvider` parameter after `checkAiReady`:
```ts
export function createRoutes(
  config: Config,
  repo: Repo,
  triggerFetch: () => void,
  aiAvailable = false,
  checkAiReady: () => Promise<boolean> = async () => false,
  aiProvider: AiProvider | null = null,
): Router {
```

(c) Replace the body of the `POST /reports/export` handler with:
```ts
  router.post('/reports/export', auth, async (req: Request, res: Response) => {
    const parsed = reportParamsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'invalid params' }); return; }
    const posts = repo.listExportablePosts(parsed.data);
    const xlsx = await buildWorkbookBuffer(posts, config.reportTz);
    const markdown = await buildAnalysisMarkdown({
      posts, filters: repo.getFilters(), tz: config.reportTz, provider: aiProvider,
    });
    const zip = await zipReport({ xlsx, markdown });
    const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
    repo.recordExport({ coveredUpto, rowCount: posts.length });
    repo.markExported(posts.map(p => p.id), new Date().toISOString());
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="x-osint-report.zip"');
    res.send(zip);
  });
```

- [ ] **Step 6: Thread `aiProvider` through `app.ts`**

In `packages/api/src/http/app.ts`:

(a) Add the import and the `AppDeps` field:
```ts
import type { AiProvider } from '../ai/provider.js';
```
```ts
export interface AppDeps {
  config: Config;
  repo: Repo;
  triggerFetch: () => void;
  staticDir?: string;
  aiAvailable?: boolean;
  checkAiReady?: () => Promise<boolean>;
  aiProvider?: AiProvider | null;
}
```
(b) Update the `createRoutes` call to pass it:
```ts
  app.use('/api', createRoutes(deps.config, deps.repo, deps.triggerFetch, deps.aiAvailable ?? false, deps.checkAiReady, deps.aiProvider ?? null));
```

- [ ] **Step 7: Pass the provider in `index.ts`**

In `packages/api/src/index.ts`, add `aiProvider: provider` to the `createApp({...})` call (the `provider` const already exists in `main()`):
```ts
  const app = createApp({
    config, repo,
    triggerFetch: () => scheduler.triggerNow(),
    staticDir,
    aiAvailable: provider !== null,
    checkAiReady,
    aiProvider: provider,
  });
```

- [ ] **Step 8: Run the route tests + full suite + typecheck**

Run: `npm test -w @x-osint/api -- routes` → Expected: PASS (the rewritten export test + all other route/report/settings tests).
Run: `npm test -w @x-osint/api` → Expected: all 15 files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api/package.json package-lock.json packages/api/src/reports/zip.ts packages/api/src/http/routes.ts packages/api/src/http/app.ts packages/api/src/index.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): export returns a zip of workbook + bilingual analysis"
```

---

### Task 4: Frontend download filename

**Files:**
- Modify: `packages/www/src/services/api.ts` (change downloaded filename to `.zip`)

**Interfaces:**
- Consumes: the export endpoint now returns `application/zip` (Task 3).
- Produces: nothing new (behavioral change to the download only).

- [ ] **Step 1: Update the download filename**

In `packages/www/src/services/api.ts`, inside `exportReport`, change the anchor download name:
```ts
    a.download = 'x-osint-report.zip';
```
(Replace the existing `a.download = 'x-osint-report.xlsx';` line. Leave the rest of the blob/anchor logic unchanged — the browser saves whatever bytes the server sends under this name.)

- [ ] **Step 2: Build the web package**

Run: `npm run build -w @x-osint/www`
Expected: `vue-tsc` passes with no type errors and `vite build` completes.

- [ ] **Step 3: Commit**

```bash
git add packages/www/src/services/api.ts
git commit -m "feat(www): report export downloads as x-osint-report.zip"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api suite + web build**

Run: `npm test -w @x-osint/api` → Expected: all pass.
Run: `npm run build -w @x-osint/www` → Expected: clean.

- [ ] **Step 2: Rebuild the image and bring the stack up**

Run: `docker compose up -d --build`
Expected: containers start; the app listens on 8080.

- [ ] **Step 3: Export a report and inspect the zip**

Ensure at least one classified/matching post exists (the running instance already has posts; if the since-last count is 0, use a wide date range). Then:
```bash
TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X POST localhost:8080/api/reports/export -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode":"range","from":"2020-01-01","to":"2030-01-01"}' \
  -o /private/tmp/claude-502/-Users-jose-Projects-x-osint/ab6c3694-c961-4cd7-a68b-41a52a077357/scratchpad/report.zip
cd /private/tmp/claude-502/-Users-jose-Projects-x-osint/ab6c3694-c961-4cd7-a68b-41a52a077357/scratchpad && unzip -l report.zip
```
Expected: the zip lists `x-osint-report.xlsx` and `x-osint-analysis.md`. Optionally `unzip -p report.zip x-osint-analysis.md | head -40` to confirm the English section, a `##` tag heading with a stats line, a narrative (real AI text if the model is ready, otherwise the unavailable note), and the Portuguese section below the `---`.

---

## Self-Review

**Spec coverage:**
- ZIP packaging (`x-osint-report.zip` with both entries) → Task 3. ✓
- `summarize` AI capability (EN narrative) + PT via `translate` → Task 1 (capability), Task 2 (`narratives`). ✓
- `buildAnalysisMarkdown`: grouping by tag, multi-angle, omit-empty, fallback "All posts", stats line, key posts (cap 5, newest-first, snippet truncation, null-url), bilingual EN→`---`→PT, unavailable note (null provider + failure), empty-posts document → Task 2. ✓
- `zipReport` → Task 3. ✓
- Route returns zip; bookkeeping unchanged; provider plumbed index→app→routes → Task 3. ✓
- Frontend filename → Task 4. ✓
- `jszip` explicit dependency → Task 3 step 1. ✓
- Tests: `summarize` (ollama), `analysis` (new), route zip (routes) → Tasks 1-3. ✓
- Localized notes/units exact strings, en-dash, caps (5/40/200) → Global Constraints + Task 2 code. ✓
- Out-of-scope items (charts/PDF, async, translating labels, separate button) respected. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step is complete. ✓

**Type consistency:** `buildAnalysisMarkdown(deps: AnalysisDeps)` and `AnalysisDeps { posts, filters, tz, provider }` identical across Task 2 definition, Task 3 route call, and tests. `zipReport({ xlsx, markdown })` identical in Task 3 def + route call. `summarize(posts: string[], tag: string)` identical across interface (Task 1), `OllamaProvider`, `narratives` call (Task 2), and all mocks. `createRoutes` 6th param `aiProvider: AiProvider | null` matches `AppDeps.aiProvider` and the `index.ts` pass-through. Entry names `x-osint-report.xlsx` / `x-osint-analysis.md` identical in `zip.ts` and the route test assertions. ✓
