# Per-tag analysis document bundled with the Excel export

**Date:** 2026-07-01
**Status:** Approved

## Problem

The report export currently produces a single `.xlsx` listing matching posts. It
answers "what was collected" but not "what does it mean". Users want an analytical
digest: for each configured filter/tag (money, entrepreneurship, business, economy,
or whatever the user has set), a short summary of the period's posts, delivered
alongside the spreadsheet, and available in both English and Portuguese.

## Goal

Change the export to deliver a ZIP containing the existing spreadsheet plus a new
bilingual Markdown analysis document with a per-tag narrative summary and key stats.

## Scope decisions (from brainstorming)

- **Packaging:** the existing "Export to Excel" action returns one
  `x-osint-report.zip` containing `x-osint-report.xlsx` (unchanged) and
  `x-osint-analysis.md`. One click.
- **Analysis depth:** per tag — an AI-written narrative (3–5 sentences) + a stats
  line + a "Key posts" list.
- **Bilingual layout:** one `.md`, full English report first, then the full
  Portuguese mirror, separated by `---`.
- **AI-off / failure:** the `.md` is always generated and bundled. Stats and key
  posts are computed in code (no AI). If AI is unavailable or a summarize/translate
  call fails, the narrative for that tag is replaced by a short
  "AI summary unavailable" note; the export never fails because of summarization.
- **Latency:** export stays synchronous. Up to 2N sequential LLM calls (N = tags
  with ≥1 matching post): N `summarize` + N `translate`. Acceptable for a manual
  button; no async/streaming (YAGNI).

## Architecture

Data flow for `POST /api/reports/export`:

1. `listExportablePosts(mode/range)` — unchanged; the same post set feeds both files.
2. `buildWorkbookBuffer(posts, tz)` — unchanged; produces the `.xlsx` buffer.
3. `buildAnalysisMarkdown({ posts, filters, tz, provider })` (new) — groups posts by
   tag, computes stats, generates narratives, renders the bilingual Markdown string.
4. `zipReport({ xlsx, markdown })` (new) — bundles the two buffers into a `.zip`
   buffer.
5. Route responds with `application/zip`, `Content-Disposition: attachment;
   filename="x-osint-report.zip"`.

Export bookkeeping (`recordExport`, `markExported`) is unchanged and still runs.

### New dependency

Add `jszip` (pure-JS, no native build) to `packages/api` for ZIP creation — Node has
no built-in ZIP archive writer.

### New / changed files

- Create `packages/api/src/reports/analysis.ts` — grouping, stats, Markdown rendering.
- Create `packages/api/src/reports/zip.ts` — `zipReport({ xlsx, markdown })`.
- Modify `packages/api/src/ai/provider.ts` — add `summarize` to the interface.
- Modify `packages/api/src/ai/ollama.ts` — implement `summarize`.
- Modify `packages/api/src/http/routes.ts` — export handler returns a zip; inject the
  provider so the handler can build the analysis.
- Modify `packages/api/src/http/app.ts` and `packages/api/src/index.ts` — pass the AI
  provider (or a `summarize` callback) through to the routes.
- Tests: `packages/api/__tests__/analysis.test.ts` (new), additions to `ollama.test.ts`
  and `routes.test.ts`.

Frontend (`ReportsView.vue` / `services/api.ts` / `stores/data.ts`): the export
download helper changes the downloaded filename to `x-osint-report.zip` and the blob
type to `application/zip`. The button label and flow are otherwise unchanged.

## Component detail

### AI: `summarize`

Interface addition:
```ts
summarize(posts: string[], tag: string): Promise<string>;
```
- `OllamaProvider.summarize` sends a system prompt instructing a concise
  (3–5 sentence) analytical summary of the supplied posts for the given `tag`,
  in English, prose only (no preamble/markdown headings). `posts` is the list of
  post texts for that tag (original English source text, i.e. `post.text`).
- Reuses the existing `chat(system, user, json=false)` helper with `json=false`.
- Input volume is bounded: pass at most the first 40 post texts per tag to keep the
  prompt within limits (log/ignore beyond that — stats still count all posts).

The Portuguese narrative is `provider.translate(englishSummary)` — no separate
Portuguese summarize call.

### Analysis builder: `buildAnalysisMarkdown`

```ts
export interface AnalysisDeps {
  posts: Post[];
  filters: Filter[];        // from repo.getFilters()
  tz: string;               // config.reportTz
  provider: AiProvider | null;
}
export async function buildAnalysisMarkdown(deps: AnalysisDeps): Promise<string>;
```

Behavior:
- **Grouping:** for each filter label, select posts whose `angles` (comma-joined,
  case-insensitive) contains that label. A post matching multiple tags appears under
  each. Tags with zero matching posts are omitted entirely.
- **Fallback grouping:** if `filters` is empty OR no post matches any filter label but
  `posts` is non-empty, produce a single group titled "All posts" containing every
  post. (Keeps the document useful even with odd data.)
- **Stats line per tag:** `<N> posts · <M> accounts · <from>–<to>` where N = posts in
  group, M = distinct handles, and from/to are the min/max `posted_at` formatted as
  dates (`YYYY-MM-DD`) in `tz`. For a single-day range, show one date.
- **Narrative:**
  - If `provider` is non-null: `en = await provider.summarize(texts, tag)`, then
    `pt = await provider.translate(en)`. Each call is wrapped in try/catch; on
    failure that language's narrative becomes the unavailable note.
  - If `provider` is null: both narratives are the unavailable note.
  - English note: `_AI summary unavailable._`
    Portuguese note: `_Resumo de IA indisponível._`
- **Key posts (per tag, max 5):** the 5 most recent posts in the group
  (by `posted_at` desc). Each rendered as
  `- @<handle>: "<snippet>" (<url>)` where snippet is the post text truncated to
  ~200 chars (append `…` if truncated) and `<url>` is omitted (no parentheses) when
  `post.url` is null. The English section uses `post.text`; the Portuguese section
  uses `post.text_pt ?? post.text`.
- **Document shape:**
  ```
  # Analysis (English)

  _Period: <from>–<to> · <total> posts_

  ## <Tag label>
  <N> posts · <M> accounts · <from>–<to>

  <english narrative>

  **Key posts**
  - @handle: "text…" (link)

  ---

  # Análise (Português)

  _Período: <from>–<to> · <total> posts_

  ## <Tag label>
  <N> posts · <M> contas · <from>–<to>

  <portuguese narrative>

  **Posts principais**
  - @handle: "texto…" (link)
  ```
  The top `_Period_` line uses the min/max across all exported posts. Tag labels are
  the user's own filter labels (not translated — they are user-defined and may be in
  any language); only the fixed scaffolding (headings, stats units, "Key posts") is
  localized.
- **Empty export:** if `posts` is empty, return a minimal document with the two
  headings and a "No matching posts for this period." / "Sem posts correspondentes
  para este período." line and no tag sections. (The route still zips and returns it,
  though the frontend button is disabled at count 0, so this is a safety net.)

### ZIP: `zipReport`

```ts
export async function zipReport(files: { xlsx: Buffer; markdown: string }): Promise<Buffer>;
```
Uses `jszip`: adds `x-osint-report.xlsx` (the buffer) and `x-osint-analysis.md`
(the string), returns a nodebuffer.

### Route change

`POST /api/reports/export` (in `routes.ts`):
- Build `posts`, `xlsx` buffer (as today).
- `const markdown = await buildAnalysisMarkdown({ posts, filters: repo.getFilters(), tz: config.reportTz, provider });`
- `const zip = await zipReport({ xlsx, markdown });`
- `recordExport` / `markExported` unchanged.
- Headers: `Content-Type: application/zip`,
  `Content-Disposition: attachment; filename="x-osint-report.zip"`.
- Send `zip`.

`provider` reaches the route via a new optional dep threaded
`index.ts → app.ts → routes.ts` (mirroring how `aiAvailable`/`checkAiReady` were
plumbed for the readiness badge). `createRoutes` gains an optional
`aiProvider: AiProvider | null = null` parameter; `AppDeps` gains
`aiProvider?: AiProvider | null`. When null (e.g. AI off, or existing tests that
don't pass it), `buildAnalysisMarkdown` uses the unavailable-note path.

### Frontend change

`services/api.ts` `exportReport`: change the downloaded file name to
`x-osint-report.zip`. The response is already handled as a blob; set the anchor
`download` attribute accordingly. No new endpoint, no UI copy change required beyond
the filename. (Optionally note in the Reports view that the export now includes an
analysis document — small helper text; nice-to-have, not required.)

## Testing

### `analysis.test.ts` (new) — `buildAnalysisMarkdown` with a stub provider
- Groups posts by angle; a post with `angles = "money,business"` appears under both
  tags.
- Tags with zero matching posts are omitted.
- Stats line: correct post count, distinct-account count, and date range for a group.
- Key posts capped at 5, newest first; snippet truncation adds `…`; null url renders
  without parentheses; Portuguese section uses `text_pt` when present.
- Bilingual structure: English section then `---` then Portuguese section; the
  Portuguese narrative equals the stubbed `translate` output.
- AI-off (provider null): both narratives show the localized unavailable note; stats
  and key posts still present.
- Summarize failure (stub throws): English narrative shows the note, document still
  renders.
- Empty posts: minimal document with both headings and the no-posts lines.
- Fallback grouping: empty filters + non-empty posts → single "All posts" group.

### `ollama.test.ts` (additions) — `summarize`
- Sends a non-JSON chat to `/api/chat`, returns trimmed content, and the system
  prompt mentions the tag.
- Throws when Ollama returns non-ok (consistent with `classify`/`translate`).

### `routes.test.ts` (additions) — export returns a zip
- `POST /api/reports/export` responds with `Content-Type: application/zip` and
  `Content-Disposition` naming `x-osint-report.zip`.
- The returned buffer is a valid zip containing both `x-osint-report.xlsx` and
  `x-osint-analysis.md` (unzip with `jszip` in the test and assert both entries
  exist; assert the `.md` contains an expected tag heading).
- Existing since-last advancement assertions still hold (export bookkeeping
  unchanged).

## Out of scope

- Charts/graphs in the analysis; PDF output.
- Asynchronous / streamed generation or progress reporting for the summary.
- Translating user-defined tag labels.
- Any change to which posts are exportable (still `angle_match = 1` + mode/range).
- A separate download button or endpoint for the `.md`.
