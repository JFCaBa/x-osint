# Job-based report export with live per-tag progress

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

## Problem

The report export now builds an Excel workbook plus an AI-generated bilingual
analysis document, zipped together. Generating the analysis makes several LLM calls
(one `summarize` + one `translate` per tag), which is slow on the local model — the
export can take from tens of seconds to minutes. The UI gives no sense of progress
(just a "Exporting…" button), and the button still reads "Export to Excel" even
though it now produces a zip. Users can't tell whether the export is working or hung.

A second, compounding cause of slowness is a pre-existing classification bug that
keeps the local model saturated (see "Classify robustness fix" below).

## Goal

1. Replace the one-shot synchronous export with a **job model** that reports live
   per-tag progress, and show that progress in the UI.
2. Rename the button to reflect that it exports a full report (zip), not just Excel.
3. Fix the classify bug so the model isn't perpetually saturated, letting summaries
   complete quickly.

## Why a job model

A single HTTP response cannot both stream progress events and deliver a binary zip
download. So "generate" and "download" are split, with progress polled in between:

1. `POST /api/reports/export` → starts a job, returns `{ jobId }` (202). Generation
   runs in the background on the server.
2. `GET /api/reports/export/:jobId` → current status/progress (polled ~every 1s).
3. `GET /api/reports/export/:jobId/download` → the finished zip; streaming it frees
   the job.

**Polling, not SSE:** auth is a Bearer header (EventSource can't send custom
headers), progress changes only every few seconds, and plain-JSON polling needs no
streaming machinery on server or client.

## Architecture

### Classify robustness fix (`packages/api/src/ai/ollama.ts`)

`classifySchema` currently requires `match: z.boolean().optional()`, but gemma3:4b
sometimes returns `match` as an array → `classifySchema.parse` throws → the post is
marked `ai_status = 'error'` → `repo.listPostsNeedingAi` re-selects it every poll →
permanent retry loop saturating the single Ollama instance.

`classify()` only uses `parsed.angles` (it derives `match` from `angles ∩ labels`), so
`match` in the schema is vestigial. Fix: drop `match` from the schema entirely —
`z.object` strips unknown keys, so an array-valued `match` is simply ignored:

```ts
const classifySchema = z.object({ angles: z.array(z.string()).optional() });
```

This is a targeted fix for the observed ZodError. No behavior change for well-formed
responses.

### Progress hook in `buildAnalysisMarkdown` (`packages/api/src/reports/analysis.ts`)

`AnalysisDeps` gains an optional callback; a new exported progress type:

```ts
export interface AnalysisProgress {
  phase: 'summarize' | 'translate';
  tag: string;
  index: number;   // 1-based position of this tag
  total: number;   // number of tags being summarized
}
export interface AnalysisDeps {
  posts: Post[];
  filters: Filter[];
  tz: string;
  provider: AiProvider | null;
  onProgress?: (ev: AnalysisProgress) => void;
}
```

The per-tag loop (currently in a `narratives` helper) is inlined so it can emit
progress: before each tag's `summarize` call, emit `{ phase: 'summarize', tag,
index, total }`; if summarize succeeds, before `translate` emit `{ phase:
'translate', tag, index, total }`. `total` = number of tag groups (after
grouping/fallback). The narrative fallback semantics are unchanged and must stay
identical: provider null → both notes; summarize throws → both notes; empty summarize
→ skip translate, pt = note; translate throws → en kept, pt = note. `onProgress` is
optional — when omitted, output is byte-for-byte what it is today (all existing
`analysis.test.ts` cases still pass).

### Export manager (`packages/api/src/http/exportJobs.ts`, new)

An in-memory job store + background runner. A job is single-user-scale; the store is a
`Map<string, ExportJob>`.

```ts
interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  phase: 'spreadsheet' | 'summarize' | 'translate' | 'bundling' | 'done' | 'error';
  tag: string | null;
  index: number;      // current tag (0 until first summarize)
  total: number;      // number of tags (0 until known)
  zip: Buffer | null;
  error: string | null;
  createdAt: number;  // Date.now(); used for TTL sweep
  promise?: Promise<void>;  // internal; runner completion (for deterministic tests)
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
  start(params: ReportParams): string;                 // returns jobId
  get(jobId: string): PublicStatus | undefined;        // status without the buffer
  takeZip(jobId: string): Buffer | null;               // zip if done; removes job
  whenDone(jobId: string): Promise<void>;              // resolves when job leaves 'running'
}
```

`PublicStatus = { status, phase, tag, index, total, error }` (no `zip`).

`start(params)`:
- Sweep jobs with `Date.now() - createdAt > 10 * 60_000` (drop abandoned buffers).
- Create a job (`status: 'running'`, `phase: 'spreadsheet'`, `index: 0`, `total: 0`),
  id via `crypto.randomUUID()`, store it, kick off `job.promise = run(job, params)`
  (unawaited), return the id.

`run(job, params)` (never rejects — catches internally):
```
try:
  phase = 'spreadsheet'
  posts = repo.listExportablePosts(params)
  xlsx = await buildWorkbook(posts, tz)
  markdown = await buildMarkdown({ posts, filters: repo.getFilters(), tz, provider,
    onProgress: ev => { job.phase = ev.phase; job.tag = ev.tag; job.index = ev.index; job.total = ev.total } })
  phase = 'bundling'; tag = null
  zipBuf = await zip({ xlsx, markdown })
  coveredUpto = posts.length ? last.posted_at : null
  repo.recordExport({ coveredUpto, rowCount: posts.length })
  repo.markExported(posts.map(p => p.id), new Date().toISOString())
  job.zip = zipBuf; job.status = 'done'; job.phase = 'done'
catch e:
  job.status = 'error'; job.phase = 'error'; job.error = message(e)
```

Bookkeeping (`recordExport`/`markExported`) runs once, on successful generation —
same "since-last advances" semantics as today (marking happens at build, not at client
download).

`takeZip(jobId)`: if job exists and `status === 'done'` and `zip`, delete the job and
return the buffer; otherwise `null`.

### Routes (`packages/api/src/http/routes.ts`)

The manager is created inside `createRoutes` from existing deps (`config`, `repo`,
`aiProvider`) wired to `buildWorkbookBuffer` / `buildAnalysisMarkdown` / `zipReport`.
The old synchronous `POST /reports/export` handler is **replaced** by three
auth-protected routes:

- `POST /reports/export` — validate `reportParamsSchema` (as today). `const jobId =
  exportMgr.start(parsed.data); res.status(202).json({ jobId })`.
- `GET /reports/export/:jobId` — `const s = exportMgr.get(req.params.jobId); if (!s)
  { 404 }; res.json(s)`.
- `GET /reports/export/:jobId/download` — `const zip = exportMgr.takeZip(...); if
  (!zip) { res.status(404).json({ error: 'not ready' }); return; }` then the existing
  zip headers (`application/zip`, `Content-Disposition: attachment;
  filename="x-osint-report.zip"`) and `res.send(zip)`.

No change to `GET /reports/summary`.

### Frontend

`services/api.ts` — replace `exportReport` with three methods:
- `startExport(params): Promise<{ jobId: string }>` → `POST /reports/export`.
- `exportStatus(jobId): Promise<ExportStatus>` → `GET /reports/export/:jobId`, where
  `ExportStatus = { status: 'running'|'done'|'error'; phase: string; tag: string|null;
  index: number; total: number; error: string|null }`.
- `downloadExport(jobId): Promise<void>` → `GET /reports/export/:jobId/download` via
  `fetch` with the Bearer header, then blob → anchor download named
  `x-osint-report.zip` (same download mechanics as the current `exportReport`).

`views/ReportsView.vue`:
- Button label "Export to Excel" → **"Export report"**; while a job runs it shows
  "Generating…" and is disabled.
- On click: `startExport(params())` → store `jobId`, then poll `exportStatus(jobId)`
  every 1000ms.
- Progress panel (visible while a job is active): a current-status line derived from
  the phase —
  - `spreadsheet` → "Building spreadsheet…"
  - `summarize` → "Summarising {tag} ({index}/{total})"
  - `translate` → "Translating {tag} ({index}/{total})"
  - `bundling` → "Bundling…"
  with a small spinner, plus a progress bar for the AI stage at
  `total ? index/total` (0 during spreadsheet, full at bundling/done).
- On `status === 'done'`: stop polling, call `downloadExport(jobId)`, clear job state.
- On `status === 'error'`: stop polling, show `error` (fallback "export failed").
- Clear the interval on completion and in `onUnmounted` (view can be navigated away).

The reports store (`stores/data.ts`): remove the old `exportReport` action (it wrapped
the now-deleted one-shot `api.exportReport`). The view drives the three new `api`
methods directly — polling and progress state are view-local (`ReportsView`), matching
how the view already owns `busy`/`error` local refs. No new store state is needed.

## Testing

### `ollama.test.ts` (classify fix)
- A classify response where `match` is an array (previously threw) no longer throws and
  returns angles-based result (e.g. `{ match: true, angles: ['money'] }` for
  `angles: ['money']`).

### `analysis.test.ts` (progress hook)
- `onProgress` is called once per tag with `phase: 'summarize'` then `phase:
  'translate'`, correct `tag`, 1-based `index`, and `total` = number of tags.
- When a tag's summarize throws, no `translate` event is emitted for that tag (still
  progresses to the next tag).
- Output with `onProgress` omitted is unchanged (existing cases still pass).

### `exportJobs.test.ts` (new — manager)
- `start` returns an id; polling `get` shows `running` then, after `await
  whenDone(id)`, `done`. Use a stub provider (or null) so `run` completes fast.
- `takeZip` returns a Buffer after done; a second `takeZip` returns `null` (job
  removed); `get`/`takeZip` for an unknown id return `undefined`/`null`.
- On a builder that throws (inject a `buildWorkbook`/`buildMarkdown` that rejects),
  after `whenDone` the status is `error` with a message, and `takeZip` is `null`.
- Progress: with a stub provider and a couple of tags, after `whenDone` the terminal
  phase is `done`; intermediate `total` reflects the tag count (assert via a provider
  whose `summarize` records the job's observed `index/total`, or assert final state).

### `routes.test.ts` (job endpoints)
- `POST /reports/export` → 202 with `{ jobId }`; requires auth (401 without token).
- Poll `GET /reports/export/:jobId` until `status !== 'running'` (bounded async loop;
  null provider makes generation near-instant) → `done`.
- `GET /reports/export/:jobId/download` → `application/zip`,
  `x-osint-report.zip` disposition; unzip (JSZip) → both `x-osint-report.xlsx` and
  `x-osint-analysis.md` present; the `.md` contains `# Analysis (English)`, `## money`,
  `# Análise (Português)`.
- A second download of the same job → 404; an unknown job id → 404.
- After a completed+downloaded export, `GET /reports/summary?mode=since-last` count is
  0 and `lastExportAt` is set (bookkeeping still advances).

## Out of scope

- A job queue / concurrency limits (single-user; concurrent exports just contend on
  Ollama).
- Persisting jobs across server restarts (in-memory; a lost job is re-run by the user).
- Cancelling an in-flight export.
- Real byte-level download progress (the download itself is fast; progress is about
  the generation stage).
- Changing which posts are exportable, the analysis document format, or the caps
  (5 key posts / 40 summary inputs / 200-char snippets).
