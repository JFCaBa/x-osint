# Export-Contents Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose per export whether to include the Excel sheet, the analysis report, or both — generating only what's requested (Excel-only skips AI entirely) and downloading a bare file when one is picked, a zip when both.

**Architecture:** Add an `include` param to the export request. The export job builds conditionally and stores a typed artifact (buffer + filename + content-type) instead of a raw zip; the download route sends those. The Reports view gains three radios and the frontend download derives its filename from the response header.

**Tech Stack:** TypeScript, Express 5, Zod, ExcelJS, JSZip (API); Vue 3, Pinia (web); Vitest + supertest.

## Global Constraints

- `include: 'both' | 'excel' | 'report'`, default `'both'` (omitted/existing requests unchanged).
- Conditional generation: `excel` builds only the workbook and makes NO AI calls (no `buildMarkdown`); `report` builds only the markdown (no workbook); `both` builds both then zips.
- Output artifact per mode:
  - `excel` → filename `x-osint-report.xlsx`, content-type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `report` → filename `x-osint-analysis.md`, content-type `text/markdown; charset=utf-8`
  - `both` → filename `x-osint-report.zip`, content-type `application/zip`
- Bookkeeping (`recordExport`/`markExported`) runs once on completion regardless of `include`.
- Radios live on the Reports panel (per-export), labels "Both" (default) / "Excel only" / "Report only".
- No change to which posts are exportable, the analysis format, progress phases, or caps.

---

### Task 1: Backend — `include` param, conditional generation, typed download

**Files:**
- Modify: `packages/api/src/http/exportJobs.ts`
- Modify: `packages/api/src/http/routes.ts`
- Test: `packages/api/__tests__/exportJobs.test.ts`, `packages/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: existing `createExportManager` deps (`buildWorkbook`, `buildMarkdown`, `zip`, `repo`).
- Produces:
  - `ReportParams` gains `include?: 'both' | 'excel' | 'report'`.
  - `ExportManager.takeZip` is REPLACED by `takeFile(jobId): { buffer: Buffer; filename: string; contentType: string } | null`.
  - `reportParamsSchema` gains `include: z.enum(['both','excel','report']).default('both')`.

- [ ] **Step 1: Write the failing manager tests**

In `packages/api/__tests__/exportJobs.test.ts`:

(a) Update the FIRST test (`'runs a job to done and yields the zip once'`) to use `takeFile` — replace its `takeZip`/zip assertions with:
```ts
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('zipbytes'));
    expect(f!.filename).toBe('x-osint-report.zip');
    expect(f!.contentType).toBe('application/zip');
    expect(mgr.takeFile(id)).toBeNull(); // job removed after first take
    expect(mgr.get(id)).toBeUndefined();
```

(b) In the OTHER existing tests, replace every `mgr.takeZip(` with `mgr.takeFile(` (the error test and unknown-id test both assert `.toBeNull()`, which still holds).

(c) Append two new tests:
```ts
  it('include=excel builds only the workbook, skips AI, and yields the xlsx', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last', include: 'excel' });
    await mgr.whenDone(id);
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('xlsx'));
    expect(f!.filename).toBe('x-osint-report.xlsx');
    expect(f!.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(d.buildMarkdown).not.toHaveBeenCalled(); // no AI work
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
  });

  it('include=report builds only the markdown and yields the .md', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last', include: 'report' });
    await mgr.whenDone(id);
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('# md', 'utf8'));
    expect(f!.filename).toBe('x-osint-analysis.md');
    expect(f!.contentType).toBe('text/markdown; charset=utf-8');
    expect(d.buildWorkbook).not.toHaveBeenCalled();
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run the manager tests to verify they fail**

Run: `npm test -w @x-osint/api -- exportJobs`
Expected: FAIL — `mgr.takeFile` is not a function; include modes not handled.

- [ ] **Step 3: Implement the typed-file + conditional generation in `exportJobs.ts`**

(a) Add the content-type constant near `TTL_MS`:
```ts
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
```

(b) Widen `ReportParams`:
```ts
export type ReportParams = { mode: 'since-last' | 'range'; from?: string; to?: string; include?: 'both' | 'excel' | 'report' };
```

(c) In `ExportJob`, replace the `zip: Buffer | null;` field with:
```ts
  file: Buffer | null;
  filename: string;
  contentType: string;
```

(d) In `ExportManager`, replace the `takeZip` signature with:
```ts
  takeFile(jobId: string): { buffer: Buffer; filename: string; contentType: string } | null;
```

(e) Replace the body of `run` (the try block) with conditional generation:
```ts
  async function run(job: ExportJob, params: ReportParams): Promise<void> {
    try {
      const include = params.include ?? 'both';
      const posts = deps.repo.listExportablePosts(params);
      let xlsx: Buffer | undefined;
      let markdown: string | undefined;
      if (include !== 'report') {
        job.phase = 'spreadsheet';
        xlsx = await deps.buildWorkbook(posts, deps.tz);
      }
      if (include !== 'excel') {
        markdown = await deps.buildMarkdown({
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
      }
      let file: Buffer;
      if (include === 'excel') {
        file = xlsx!;
        job.filename = 'x-osint-report.xlsx';
        job.contentType = XLSX_TYPE;
      } else if (include === 'report') {
        file = Buffer.from(markdown!, 'utf8');
        job.filename = 'x-osint-analysis.md';
        job.contentType = 'text/markdown; charset=utf-8';
      } else {
        job.phase = 'bundling';
        job.tag = null;
        file = await deps.zip({ xlsx: xlsx!, markdown: markdown! });
        job.filename = 'x-osint-report.zip';
        job.contentType = 'application/zip';
      }
      const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
      deps.repo.recordExport({ coveredUpto, rowCount: posts.length });
      deps.repo.markExported(posts.map(p => p.id), new Date().toISOString());
      job.file = file;
      job.status = 'done';
      job.phase = 'done';
    } catch (err) {
      job.status = 'error';
      job.phase = 'error';
      job.error = err instanceof Error ? err.message : 'export failed';
    }
  }
```

(f) In `start`, initialize the new fields (replace `zip: null,` in the job literal):
```ts
        file: null,
        filename: '',
        contentType: '',
```

(g) Replace the `takeZip` method with `takeFile`:
```ts
    takeFile(jobId: string): { buffer: Buffer; filename: string; contentType: string } | null {
      const j = jobs.get(jobId);
      if (!j || j.status !== 'done' || !j.file) return null;
      jobs.delete(jobId);
      return { buffer: j.file, filename: j.filename, contentType: j.contentType };
    },
```

- [ ] **Step 4: Run the manager tests to verify they pass**

Run: `npm test -w @x-osint/api -- exportJobs`
Expected: PASS (updated existing tests + 2 new include-mode tests).

- [ ] **Step 5: Write the failing route tests**

In `packages/api/__tests__/routes.test.ts`, inside the `reports routes` describe (which already has the `runExport` poll helper and a "both" download test), append:
```ts
  it('include=excel downloads a bare xlsx', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const { jobId, status } = await runExport(ctx.app, token, { mode: 'since-last', include: 'excel' });
    expect(status.status).toBe('done');
    const dl = await auth(request(ctx.app).get(`/api/reports/export/${jobId}/download`));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('spreadsheetml');
    expect(dl.headers['content-disposition']).toContain('x-osint-report.xlsx');
  });

  it('include=report downloads a bare markdown file', async () => {
    const token = await tokenFor(ctx.app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await seedMatch('1', '2026-06-18T00:00:00.000Z');
    const { jobId, status } = await runExport(ctx.app, token, { mode: 'since-last', include: 'report' });
    expect(status.status).toBe('done');
    const dl = await auth(request(ctx.app).get(`/api/reports/export/${jobId}/download`));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/markdown');
    expect(dl.headers['content-disposition']).toContain('x-osint-analysis.md');
    expect(dl.text).toContain('# Analysis (English)');
  });

  it('rejects an invalid include value', async () => {
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).post('/api/reports/export')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'since-last', include: 'nonsense' });
    expect(res.status).toBe(400);
  });
```
(The existing "both" download test — which unzips and checks both entries — stays as-is and still asserts `application/zip` + `x-osint-report.zip`.)

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `npm test -w @x-osint/api -- routes`
Expected: FAIL — download returns `application/zip` for all modes (route still uses `takeZip`); invalid include is accepted (schema has no `include`).

- [ ] **Step 7: Add `include` to the schema and switch the download route to `takeFile` in `routes.ts`**

(a) Extend `reportParamsSchema`:
```ts
const reportParamsSchema = z.object({
  mode: z.enum(['since-last', 'range']).default('since-last'),
  from: z.string().optional(),
  to: z.string().optional(),
  include: z.enum(['both', 'excel', 'report']).default('both'),
});
```

(b) Replace the download handler body:
```ts
  router.get('/reports/export/:jobId/download', auth, (req: Request, res: Response) => {
    const f = exportMgr.takeFile(req.params.jobId as string);
    if (!f) { res.status(404).json({ error: 'not ready' }); return; }
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.send(f.buffer);
  });
```

- [ ] **Step 8: Run route tests + full suite + typecheck**

Run: `npm test -w @x-osint/api -- routes` → Expected: PASS (excel/report/both downloads + invalid-include 400 + all existing).
Run: `npm test -w @x-osint/api` → Expected: all files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/http/exportJobs.ts packages/api/src/http/routes.ts packages/api/__tests__/exportJobs.test.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): export include=excel|report|both with typed single-file download"
```

---

### Task 2: Frontend — include radios + filename-from-header download

**Files:**
- Modify: `packages/www/src/services/api.ts`
- Modify: `packages/www/src/views/ReportsView.vue`

**Interfaces:**
- Consumes: the `include` param and the per-mode download headers (Task 1).
- Produces: `ReportParams` gains `include?: 'both' | 'excel' | 'report'`; the Reports view sends it and saves the download under the server-provided filename.

- [ ] **Step 1: Add `include` to `ReportParams` and derive the download filename in `api.ts`**

(a) Extend the interface:
```ts
export interface ReportParams {
  mode: 'since-last' | 'range';
  from?: string;
  to?: string;
  include?: 'both' | 'excel' | 'report';
}
```

(b) In `downloadExport`, derive the filename from the `Content-Disposition` header (replace the hardcoded `a.download = 'x-osint-report.zip';` and the lines around it):
```ts
    if (!res.ok) throw new ApiError(res.status, 'download failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="([^"]+)"/);
    const filename = match ? match[1]! : 'x-osint-report.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
```

- [ ] **Step 2: Add the include radios in `ReportsView.vue`**

(a) In `<script setup>`, add the ref after `to`:
```ts
const include = ref<'both' | 'excel' | 'report'>('both');
```

(b) Replace `params()` so it carries `include`:
```ts
function params(): ReportParams {
  const base: ReportParams = mode.value === 'range'
    ? { mode: 'range', from: from.value || undefined, to: to.value || undefined }
    : { mode: 'since-last' };
  return { ...base, include: include.value };
}
```

(c) In the template, add an include row right after the existing mode radios block (the `<div class="flex gap-4 text-sm">` … `</div>` that holds "Since last export / Date range"). Insert after that closing `</div>`:
```html
      <div class="flex gap-4 text-sm">
        <span class="text-gray-400">Include:</span>
        <label class="flex items-center gap-1">
          <input type="radio" value="both" v-model="include" name="report-include" /> Both
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="excel" v-model="include" name="report-include" /> Excel only
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="report" v-model="include" name="report-include" /> Report only
        </label>
      </div>
```

- [ ] **Step 3: Build the web package**

Run: `npm run build -w @x-osint/www`
Expected: `vue-tsc` passes (no type errors) and `vite build` completes.

- [ ] **Step 4: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/src/views/ReportsView.vue
git commit -m "feat(www): Include selector (Excel/Report/Both) + filename from response"
```

---

### Task 3: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api suite + web build**

Run: `npm test -w @x-osint/api` → Expected: all pass.
Run: `npm run build -w @x-osint/www` → Expected: clean.

- [ ] **Step 2: Rebuild the image and bring the stack up**

Run: `docker compose up -d --build`
Expected: containers start; app listens on 8080.

- [ ] **Step 3: Verify each include mode over the job API**

`excel` should be fast (no AI) and download an `.xlsx`; `report` a `.md`; `both` a `.zip`.
```bash
TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
run() {  # $1 = include
  JOB=$(curl -s -X POST localhost:8080/api/reports/export -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"mode\":\"range\",\"from\":\"2020-01-01\",\"to\":\"2030-01-01\",\"include\":\"$1\"}" | sed 's/.*"jobId":"\([^"]*\)".*/\1/')
  for i in $(seq 1 90); do S=$(curl -s localhost:8080/api/reports/export/$JOB -H "Authorization: Bearer $TOKEN"); echo "$S" | grep -qE '"status":"(done|error)"' && break; sleep 3; done
  echo "[$1] final: $S"
  curl -s -D - -o /dev/null localhost:8080/api/reports/export/$JOB/download -H "Authorization: Bearer $TOKEN" | grep -iE "content-type|content-disposition"
}
run excel
run report
run both
```
Expected: `excel` reaches `done` almost immediately (phase `spreadsheet`→`done`, no summarize/translate) and the download headers show `spreadsheetml` + `x-osint-report.xlsx`; `report` headers show `text/markdown` + `x-osint-analysis.md`; `both` headers show `application/zip` + `x-osint-report.zip`. Also confirm in the browser that the Reports page shows the three "Include" radios and each downloads the right file type.

---

## Self-Review

**Spec coverage:**
- `include` param + default `both` on the shared schema → Task 1 step 7. ✓
- Conditional generation; excel skips AI (no `buildMarkdown`); report skips workbook → Task 1 step 3(e) + tests asserting `buildMarkdown`/`buildWorkbook` not called. ✓
- Typed artifact (buffer+filename+content-type), per-mode filenames/types → Task 1 step 3. ✓
- `takeZip`→`takeFile` and download route sends stored type/filename → Task 1 steps 3(g), 7(b). ✓
- Bookkeeping once regardless of mode → run() calls recordExport/markExported after the switch; tests assert `recordExport` once in excel/report modes. ✓
- Radios on Reports panel (Both default) + send `include` → Task 2 step 2. ✓
- Download saves under server filename → Task 2 step 1(b). ✓
- Tests: manager per-mode + no-AI/no-workbook, route per-mode download headers + invalid-include 400 → Tasks 1. ✓
- Out-of-scope (persistent default, format/caps/phases unchanged) respected. ✓

**Placeholder scan:** No TBD/vague steps; complete code in every code step. ✓

**Type consistency:** `ReportParams.include?: 'both'|'excel'|'report'` identical in `exportJobs.ts` and `api.ts`. `takeFile(): { buffer, filename, contentType } | null` identical in the `ExportManager` interface, the implementation, and the download route consuming `f.buffer/f.filename/f.contentType`. Content-type strings (`…spreadsheetml.sheet`, `text/markdown; charset=utf-8`, `application/zip`) and filenames identical across run(), tests, and route assertions. `reportParamsSchema` include enum matches the `ReportParams` union. ✓
