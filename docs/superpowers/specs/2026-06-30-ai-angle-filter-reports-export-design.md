# Design: AI angle-filtering + Reports/Excel export

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Background

`x-osint` is a self-hosted X/Twitter collector: it pulls posts from a watchlist via
Nitter RSS, stores them in SQLite, and serves a Vue SPA (Feed / Accounts) plus a JSON API.

Eduardo Neto requested four improvements to the collector:

1. AI scans each post and keeps only those with at least one of these angles: **money,
   entrepreneurship, business, or economy**.
2. Export stories to an **Excel** file with columns: **Date, X handle, Text (translated to
   Portuguese), Post link**.
3. Export only posts **newer than the last exported date/time** (his most-wanted option).
4. Export only posts from a **specific date** if available.

## Decisions (locked in with Jose)

- **AI provider:** pluggable interface, **Ollama as the default implementation**. Keeps
  everything self-hosted — no API keys, no per-token cost, nothing leaves the box.
- **Model:** a single `gemma3:4b` for both classification and translation (configurable).
- **When to classify:** at **collection time**; store results in the DB so export/Feed are
  instant and AI runs once per post.
- **Export filters:** both **since-last-export** (default) and **specific date range**.
- **Filter scope:** Reports export **and** an optional Feed toggle to show only
  angle-matching posts.
- **Date column timezone:** default **`Europe/London`** (Eduardo lives in the UK),
  configurable via `REPORT_TZ`.

## Architecture

### 1. AI provider layer

A small interface so the AI backend is swappable:

```ts
export interface AiProvider {
  // angles is a subset of: 'money' | 'entrepreneurship' | 'business' | 'economy'
  classify(text: string): Promise<{ match: boolean; angles: string[] }>;
  translate(text: string, target?: string): Promise<string>; // default target 'pt'
}
```

- **`OllamaProvider`** (default) calls `${OLLAMA_HOST}/api/chat`:
  - `classify`: a system prompt instructing strict JSON output
    `{ "match": boolean, "angles": string[] }`, with `format: 'json'` requested from Ollama.
    Response is parsed and validated with zod; unknown angles are dropped; parse failure →
    throw (treated as an `error`, retried later).
  - `translate`: plain-text completion, "translate to European Portuguese, output only the
    translation".
- **`NoneProvider`** (when `AI_PROVIDER=none`): a no-op used to disable AI cleanly.
- Selection in a small `createAiProvider(config)` factory based on `AI_PROVIDER`.

**Config (env vars), added to `config.ts` / `Config`:**

| Var | Default | Purpose |
|-----|---------|---------|
| `AI_PROVIDER` | `ollama` | `ollama` or `none` |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama base URL (`http://ollama:11434` in compose) |
| `AI_MODEL` | `gemma3:4b` | model tag used for both tasks |
| `REPORT_TZ` | `Europe/London` | IANA timezone for the Excel Date column |

If `AI_PROVIDER=ollama` but Ollama is unreachable, classification fails per-post and is
retried on the next poll; the app never crashes.

### 2. Classify + translate at collection time

**Schema changes** (additive, in `store/schema.ts`; applied with `ALTER TABLE ... ADD COLUMN`
guarded for idempotency since `CREATE TABLE IF NOT EXISTS` won't add columns to an existing DB):

```sql
ALTER TABLE posts ADD COLUMN ai_status   TEXT;     -- 'pending' | 'done' | 'error' (NULL legacy => pending)
ALTER TABLE posts ADD COLUMN angle_match INTEGER;  -- 0 | 1
ALTER TABLE posts ADD COLUMN angles      TEXT;     -- comma-separated, e.g. 'money,business'
ALTER TABLE posts ADD COLUMN text_pt     TEXT;     -- Portuguese translation, only when matched
```

A migration helper checks `PRAGMA table_info(posts)` and adds any missing column on startup.

**Worker flow** (new `ai/processor.ts`, invoked by the scheduler after `upsertPosts`, and on
startup for backfill):

1. Select a batch of posts where `ai_status IS NULL OR ai_status='pending' OR ai_status='error'`
   (bounded `LIMIT`, e.g. 25 per pass).
2. For each (small concurrency limit, e.g. 3):
   - `classify(text)` → set `angle_match`, `angles`.
   - **Only if `match`**: `translate(text)` → set `text_pt` (saves compute on irrelevant posts).
   - Set `ai_status='done'`. On any provider error, set `ai_status='error'` (retried next pass).
3. New repo methods: `listPostsNeedingAi(limit)`, `setPostAi(id, {status, match, angles, textPt})`.

New posts are inserted with `ai_status='pending'` (via the upsert default / immediate update).
Backfill: existing rows have `ai_status NULL`, so the same query picks them up — processed in
the background after startup without blocking the HTTP server.

### 3. Reports view (new nav item)

New `ReportsView.vue` + route `/reports`, added to the `App.vue` nav between Feed and Accounts.

- **Mode selector:** `Since last export` (default) | `Date range` (from/to `<input type="date">`).
- Shows the **matching-post count** for the current selection and the **last export timestamp**.
- **Export to Excel** button downloads an `.xlsx`.
- If AI is unavailable / no posts processed yet, shows an informational notice instead of a count.

### 4. Excel generation

- Library: **`exceljs`** (mature, streams, good styling) added to `@x-osint/api`.
- One worksheet "Stories", header row bolded, columns:

  | Column | Source |
  |--------|--------|
  | Date | `posted_at` formatted `YYYY-MM-DD HH:mm` in `REPORT_TZ` (via `Intl.DateTimeFormat`) |
  | X handle | `@${handle}` |
  | Text (PT) | `text_pt` (falls back to original `text` only if translation missing) |
  | Post link | `url` |

- Only rows with `angle_match=1` are exported.
- A `reports/excel.ts` module builds the workbook from a `Post[]`; unit-testable without HTTP.

### 5. Export tracking & "since last export"

New table:

```sql
CREATE TABLE IF NOT EXISTS exports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exported_at   TEXT NOT NULL,   -- when the export ran (ISO 8601)
  covered_upto  TEXT,            -- max posted_at included in this export (ISO 8601), NULL if empty
  row_count     INTEGER NOT NULL
);
```

- **Since last export** = posts with `angle_match=1 AND posted_at > (SELECT MAX(covered_upto) FROM exports)`.
  If no prior export, returns all matching posts.
- On a successful export, insert a row with `exported_at=now`, `covered_upto=max(posted_at)` of
  the exported set, `row_count`.
- `lastExportAt` = `MAX(exported_at)`.

Repo methods: `listExportablePosts({mode, from, to})`, `recordExport({coveredUpto, rowCount})`,
`getLastExport()`.

### 6. API endpoints (in `http/routes.ts`, all behind existing Bearer auth)

- `GET  /api/reports/summary?mode=since-last|range&from=&to=` → `{ count, lastExportAt, aiAvailable }`
- `POST /api/reports/export` (body: `{mode, from, to}`) → responds with the `.xlsx` binary
  (`Content-Type` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `Content-Disposition: attachment`) and records the export as a side effect.
- `GET  /api/posts?...&angleOnly=true` → existing posts route gains an `angleOnly` flag that
  adds `angle_match=1` to the query.

Validation with zod; `from`/`to` parsed as dates; `range` requires at least one bound.

### 7. Frontend wiring

- `services/api.ts`: add `reportsSummary(params)`, `exportReport(params)` (uses `fetch` →
  `res.blob()` → trigger download via an object URL), and an `angleOnly` param on `listPosts`.
- `stores/data.ts`: Feed `angleOnly` toggle state + reload; Reports state.
- `FeedView.vue`: add the "Only money/business angle" checkbox.
- New `ReportsView.vue` as above.

### 8. Docker

- Add an **optional** `ollama` service to `docker-compose.yml` with a named volume for pulled
  models; set `OLLAMA_HOST=http://ollama:11434` on the app service and `depends_on`.
- README: new env vars table entries, a "Reports" usage section, and instructions to
  `ollama pull gemma3:4b` (plus a CPU-vs-GPU note and how to disable AI with `AI_PROVIDER=none`).

## Testing

All AI tests use a **mock `AiProvider`** — no real Ollama in CI.

- `ai/processor`: matched post → translated + `done`; non-matched → not translated + `done`;
  provider throw → `error` status; backfill picks up `NULL` rows.
- `OllamaProvider`: with a stubbed `httpGet`, asserts the request shape and JSON parsing/validation
  (valid JSON, malformed JSON, unknown angle dropped).
- `reports/excel`: header row + cell values correct; date formatted in `REPORT_TZ`; PT fallback.
- repo: `listExportablePosts` for `since-last` (respects `covered_upto`) and `range`;
  `recordExport` / `getLastExport`; `angleOnly` filter on `listPosts`.
- routes: `/reports/summary` shape, `/reports/export` content-type + records an export,
  `angleOnly` on `/posts`.

## Out of scope (YAGNI)

- Per-account AI rules, custom angle definitions in the UI.
- Scheduled/automatic exports or emailing the file.
- CSV/Google Sheets export (Excel only, as requested).
- Multi-user export histories (single-password app → one global export log).

## Risks / notes

- A light Gemma's Portuguese is "good enough", not professional. The model is swappable via
  `AI_MODEL` if quality needs to improve.
- First run must `ollama pull gemma3:4b`; until then classification errors and retries — no crash.
- "Since last export" keys off `posted_at`, not fetch time; appropriate because Nitter RSS only
  surfaces recent posts.
