# Design: editable AI filters with colored/emoji badges (Settings page)

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Background

The collector now classifies each post at collection time for fixed angles
(money / entrepreneurship / business / economy) via an Ollama model, translates matches to
Portuguese, and exports matches to Excel. The angle list and the classify prompt are
**hardcoded** in `packages/api/src/ai/ollama.ts`, so changing what counts as "relevant"
requires a code change and redeploy.

The user wants to **tune the AI filter criteria at runtime** from the UI (no new version),
and to **see which filter(s) each post matched** via per-filter visual badges
(emoji + color).

## Decisions (locked in with the user)

- **Editable unit:** a structured **list of filters**, each `{ label, color, emoji }` —
  not a free-form prompt. The AI is constrained to the configured labels, so badges map 1:1.
- **Re-classify:** saving applies to new posts automatically; a separate **"Re-classify all
  posts"** button re-runs existing posts on demand.
- **Location:** a new **Settings** top-nav item.
- **Badges:** rendered on the **Feed only**. The Excel export keeps its existing four columns
  (no "Matched filters" column).
- **Mechanism (unchanged):** the AI reads each post's full text and decides whether it *is
  related to* at least one configured filter. `match` (boolean) is the keep/drop decision;
  `angles` lists which configured labels it matched (for badges).

## Architecture

### 1. Settings storage

New table (added to `store/schema.ts`, created by the existing idempotent `openDb`):

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

One key today: `classify_filters` → a JSON array of `{ label, color, emoji }`.

**Default** (seeded on read when the key is absent — identical to current behavior):

```json
[ {"label":"money","color":"#22c55e","emoji":"💰"},
  {"label":"entrepreneurship","color":"#3b82f6","emoji":"🚀"},
  {"label":"business","color":"#a855f7","emoji":"🏢"},
  {"label":"economy","color":"#f59e0b","emoji":"📈"} ]
```

Repo methods:
- `getSetting(key): string | null` / `setSetting(key, value): void` (generic key-value).
- `getFilters(): Filter[]` — parses `classify_filters`, returns the default array if unset or
  unparseable.
- `setFilters(filters: Filter[]): void` — stores as JSON.
- `resetAiStatus(): number` — `UPDATE posts SET ai_status='pending'`; returns rows affected.
  Does NOT touch `exported_at`, `angle_match`, `angles`, or `text_pt` (those get overwritten
  when reprocessed).

`Filter` type (shared shape): `{ label: string; color: string; emoji: string }`.

### 2. AI classification — constrained to configured labels

Change the provider interface:

```ts
export interface AiProvider {
  classify(text: string, labels: string[]): Promise<{ match: boolean; angles: string[] }>;
  translate(text: string, target?: string): Promise<string>;
}
```

`OllamaProvider.classify(text, labels)`:
- System prompt is a fixed template with the labels injected:
  *"You are a strict text classifier. Decide which of these topics the post is related to:
  `<labels joined by ', '>`. Respond ONLY with JSON `{"match": boolean, "angles": string[]}`
  where `angles` is the subset of those exact labels the post matches. No prose."*
- Still requests Ollama `format: 'json'`.
- Parse with the existing lenient zod schema, then **intersect** the returned angles with
  `labels` (case-insensitive compare, output the canonical configured label). Replaces the
  old hardcoded 4-angle whitelist.
- `match = (intersected angles).length > 0`. (A post is kept iff it matched ≥1 configured
  label; the model's separate `match` flag is no longer trusted on its own, which keeps the
  badge set and the keep/drop decision perfectly consistent.)

If `labels` is empty, `classify` returns `{ match: false, angles: [] }` without calling the
model (nothing to match against).

`DEFAULT_CLASSIFY_FILTERS` (the default array) lives in one place the repo imports for its
fallback; the four-label default is no longer special-cased in the provider.

### 3. Processor passes current labels

`createAiProcessor` reads the current filter labels from the repo once per `processBatch`
(`repo.getFilters().map(f => f.label)`) and passes them to `provider.classify(text, labels)`.
Edits to filters therefore take effect on the next poll with no restart. Translate-only-on-
match is unchanged.

### 4. API (all behind existing Bearer auth)

- `GET  /api/settings` → `{ filters: Filter[] }`
- `PUT  /api/settings` body `{ filters: Filter[] }` → validates, saves, returns `{ filters }`
- `POST /api/settings/reclassify` → `repo.resetAiStatus()`, then `triggerFetch()`, returns
  `{ queued: number }` (rows reset)

**Validation (zod)** for `PUT`:
- `filters`: array, length 1–20.
- `label`: non-empty string, ≤ 40 chars (trimmed); labels must be unique (case-insensitive).
- `color`: matches `^#[0-9a-fA-F]{6}$`.
- `emoji`: optional string, ≤ 8 chars (defaults to `''`).

Invalid input → `400 { error }`.

### 5. Frontend

`services/api.ts`:
- `Filter` interface; `Post` already carries `angles`.
- `getSettings(): Promise<{ filters: Filter[] }>`
- `saveSettings(filters): Promise<{ filters: Filter[] }>`
- `reclassifyAll(): Promise<{ queued: number }>`

`stores/data.ts`:
- `filters` ref (Filter[]), `loadFilters()`, `saveFilters(filters)`, `reclassifyAll()`.
- A `filterFor(label)` helper / computed map `label → Filter` for badge lookup.

`views/FeedView.vue`:
- For each post, split `p.angles` on `,` and render a badge per label: emoji + label, tinted
  with the filter's `color` (inline `style` for background/border/text since Tailwind can't do
  dynamic colors). A label not found in the current config renders as a neutral grey chip.
- Load filters on mount (alongside accounts/posts).

`views/SettingsView.vue` (new) + `/settings` route + **Settings** nav link in `App.vue`:
- A row-based editor: each filter row = label text input, `<input type="color">`, emoji text
  input, and a remove button. An "Add filter" button appends a blank row. A **Save** button
  (calls `saveFilters`, shows success/error). A **"Re-classify all posts"** button behind a
  confirm dialog (calls `reclassifyAll`, reports the queued count, notes it runs in the
  background over the next poll).
- Client-side mirror of the server validation (1–20 rows, non-empty unique labels, valid hex,
  emoji ≤ 8 chars) with inline error messaging; the server remains the source of truth.

### 6. Color rendering note

Badge colors are user-chosen hex values, so they're applied via inline `:style` bindings
(e.g. `border-color`, a low-alpha background, and the text color), not Tailwind classes.

## Testing

All AI tests use a mock `AiProvider` or a stubbed `postJson` — no real Ollama.

- **repo:** `getSetting`/`setSetting`; `getFilters` returns default when unset and parsed value
  when set; `getFilters` falls back to default on malformed JSON; `setFilters` round-trips;
  `resetAiStatus` sets all posts to `pending` and returns the count without clearing
  `exported_at`.
- **ollama:** `classify(text, labels)` includes the labels in the request; returned angles are
  intersected with `labels` case-insensitively to the canonical label (e.g. model returns
  `["Business","sports"]` with labels `["business","economy"]` → `["business"]`,
  `match=true`); empty `labels` short-circuits to `{match:false,angles:[]}` with no HTTP call;
  translate unchanged.
- **processor:** reads filters from the repo and passes the labels to `classify`; a post
  matching a configured label is translated and stored with `angle_match=1` and the label in
  `angles`.
- **routes:** `GET /settings` returns defaults initially; `PUT /settings` validates (rejects
  empty list, >20, blank/duplicate label, bad hex, oversized emoji) and persists; reclassify
  resets posts and returns the queued count.
- **www:** api client methods build the right calls; Settings editor add/remove/save flow;
  badge rendering maps a label to its color+emoji and falls back to neutral for unknown labels.

## Out of scope (YAGNI)

- Per-filter icons beyond emoji (no SVG upload/icon library).
- Editing the translation prompt or target language.
- A "Matched filters" column in the Excel export.
- Multiple named filter *sets*/profiles (one active list only).
- Reordering filters by drag-and-drop (add/remove is enough).

## Risks / notes

- Changing filters does not auto-reprocess; stale `angles` on old posts persist until the user
  clicks "Re-classify all". The Settings copy makes this explicit.
- "Re-classify all" re-runs classification AND re-translates every match — on a large DB with
  a slow model this is a long background job. It is user-initiated and drains over successive
  polls; the existing `processAll` cannot infinite-loop (each post attempted once per drain).
- Emoji are stored/validated by length, not by Unicode validity; a non-emoji string is
  rendered as-is (acceptable — it's the user's own label decoration).
