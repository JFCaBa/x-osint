# Export-contents selector (Excel / Report / Both)

**Date:** 2026-07-02
**Status:** Approved (pending spec review)

## Problem

The report export always produces both artifacts zipped together (`x-osint-report.xlsx`
+ `x-osint-analysis.md`). Users sometimes want only the spreadsheet (fast — no AI) or
only the analysis. The analysis stage is the slow part (per-tag LLM summarize +
translate), so forcing it on every export is wasteful when the user just wants the
sheet.

## Goal

Let the user choose, per export, whether to include the **Excel sheet**, the
**analysis report**, or **both**, via radio buttons on the Reports panel. Generate only
what's requested (Excel-only skips AI entirely), and download a bare file when a single
item is chosen, a zip when both.

## Scope decisions (from brainstorming)

- **Placement:** three radios on the Reports page, next to the existing since-last /
  date-range controls. Per-export choice (not a saved setting). Labels: **Both**
  (default) · **Excel only** · **Report only**.
- **Backend generation is conditional:** Excel-only builds only the workbook and makes
  **no AI calls**; Report-only builds only the markdown; Both is today's behavior.
- **Output shape:** bare file when one is selected, zip when both:
  - `excel` → `x-osint-report.xlsx`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `report` → `x-osint-analysis.md`, `text/markdown; charset=utf-8`
  - `both` → `x-osint-report.zip`, `application/zip`
- Default `both` keeps existing/omitted requests unchanged.
- Bookkeeping (`recordExport`/`markExported`) runs once on completion regardless of
  `include`.

Builds on the just-merged job-based export (`POST /reports/export` → poll
`GET /reports/export/:jobId` → `GET /reports/export/:jobId/download`).

## Architecture

### Param

`reportParamsSchema` (`packages/api/src/http/routes.ts`) gains:
```ts
include: z.enum(['both', 'excel', 'report']).default('both'),
```
This schema is shared with `GET /reports/summary`; summary ignores `include`, and the
default keeps summary requests unaffected.

`ReportParams` (`packages/api/src/http/exportJobs.ts`) gains
`include: 'both' | 'excel' | 'report'` (the parsed schema output flows straight into
`exportMgr.start(parsed.data)`).

### Job holds a typed file, not just a zip

Today `ExportJob` stores `zip: Buffer | null` and `takeZip` returns a `Buffer`. Generalize
to a named artifact:
- `ExportJob` fields `zip` → replaced by `file: Buffer | null`, plus
  `filename: string` and `contentType: string`.
- `PublicStatus` is unchanged (no buffer exposed).
- `takeZip(jobId): Buffer | null` → `takeFile(jobId): { buffer: Buffer; filename: string; contentType: string } | null` (returns only when `status === 'done'` and a file is present; deletes the job — same semantics as today).

### `run` builds conditionally (`exportJobs.ts`)

```
posts = repo.listExportablePosts(params)
if include !== 'report':
  phase = 'spreadsheet'; xlsx = await buildWorkbook(posts, tz)
if include !== 'excel':
  markdown = await buildMarkdown({ posts, filters, tz, provider, onProgress })   // emits per-tag progress
switch include:
  case 'excel':  file = xlsx;                       filename='x-osint-report.xlsx'; type=<xlsx>
  case 'report': file = Buffer.from(markdown,'utf8'); filename='x-osint-analysis.md'; type='text/markdown; charset=utf-8'
  case 'both':   phase='bundling'; file = await zip({ xlsx, markdown }); filename='x-osint-report.zip'; type='application/zip'
recordExport(...); markExported(...)          // unchanged, always runs
job.file = file; job.filename = filename; job.contentType = type; job.status='done'; job.phase='done'
```

Notes:
- Excel-only never calls `buildMarkdown`, so no `summarize`/`translate` and no progress
  events — phase goes `spreadsheet` → `done` (near-instant).
- Report-only skips `spreadsheet`; phase starts at the first `summarize` event.
- `bundling` only occurs for `both`.
- The `<xlsx>` content-type constant is
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (the value the old
  synchronous route used).

### Download route (`routes.ts`)

```ts
router.get('/reports/export/:jobId/download', auth, (req, res) => {
  const f = exportMgr.takeFile(req.params.jobId as string);
  if (!f) { res.status(404).json({ error: 'not ready' }); return; }
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.send(f.buffer);
});
```

### Frontend

- `ReportsView.vue`: add an `include` ref (default `'both'`) and a row of three radios
  ("Both" / "Excel only" / "Report only") near the mode controls; include it in the
  `params()` object passed to `startExport`.
- `services/api.ts`: `ReportParams`/`startExport` params carry the optional
  `include: 'both' | 'excel' | 'report'`.
- `downloadExport(jobId)`: instead of hardcoding `x-osint-report.zip`, derive the saved
  filename from the response `Content-Disposition` header (fallback to
  `x-osint-report.zip` if absent); the blob's own type is used for the object URL. So
  each mode saves under its correct name/extension.

## Testing

### `exportJobs.test.ts`
- `include: 'excel'` → after `whenDone`, `takeFile` returns `{ filename:
  'x-osint-report.xlsx', contentType: '…spreadsheetml.sheet' }`, buffer equals the
  stubbed workbook bytes; and the injected `buildMarkdown` was **not called** (spy
  asserts 0 calls) — proving no AI work.
- `include: 'report'` → `takeFile` filename `x-osint-analysis.md`, contentType
  `text/markdown; charset=utf-8`, buffer is the markdown bytes; `buildWorkbook` not
  called.
- `include: 'both'` (and default when omitted) → filename `x-osint-report.zip`,
  contentType `application/zip`, buffer equals the stubbed zip bytes.
- Bookkeeping (`recordExport`/`markExported`) called once in all three modes.

### `routes.test.ts`
- Download after an `excel` job → `Content-Type` contains `spreadsheetml`,
  `Content-Disposition` names `x-osint-report.xlsx`.
- Download after a `report` job → `Content-Type` `text/markdown…`, disposition
  `x-osint-analysis.md`, body contains `# Analysis (English)`.
- Download after a `both` job → `application/zip`, disposition `x-osint-report.zip`,
  unzips to both entries (existing assertion, retained).
- `POST /reports/export` with an invalid `include` value → 400.

(No frontend unit tests exist; the radios + filename-from-header change are covered by
the `www` build gate and manual/E2E check.)

## Out of scope

- Saving the choice as a persistent default.
- Any change to which posts are exportable, the analysis format, the progress phases
  themselves, or the caps.
- Per-file progress granularity beyond the existing phase reporting.
