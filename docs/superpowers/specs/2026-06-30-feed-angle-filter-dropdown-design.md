# Design: Feed angle-filter dropdown

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Background

The Feed currently has a binary checkbox **"Money/business only"** that toggles
`/api/posts?angleOnly=true` (posts with `angle_match = 1`). Now that the AI filters are an
editable list of `{label, color, emoji}`, the user wants to replace that checkbox with a
**dropdown** that can show all posts, posts matching any filter, or posts matching one
specific filter.

## Decision (locked in with the user)

Replace the checkbox with a `<select>` offering:
- **All posts** — no angle filter.
- **Matched (any filter)** — today's behavior (`angle_match = 1`).
- **One entry per configured filter** — shows `emoji + label`; selecting it shows only posts
  whose stored `angles` contains that exact label.

Feed only (Reports/Excel unchanged). Single-select.

## Architecture

### 1. Backend — `angle` filter on listPosts

`repo.listPosts` (`packages/api/src/store/repo.ts`) gains an optional `angle?: string`.
When present, it adds an **exact CSV-membership** check against the stored `angles` column
(which holds a comma-joined list of canonical labels, e.g. `"money,business"`):

```sql
(',' || angles || ',') LIKE @anglePat       -- params.anglePat = `%,${angle},%`
```

This is parameterized (no injection) and avoids substring false-positives (`eco` would not
match `economy`). The existing `angleOnly` clause (`angle_match = 1`) is unchanged; `angle`
and `angleOnly` are independent options (the UI sends at most one).

The `angle` value is used only as a bound parameter — never interpolated into SQL.

### 2. API — `/api/posts?angle=`

`packages/api/src/http/routes.ts`: the `/posts` handler reads `angle` from the query
(`typeof q.angle === 'string' ? q.angle : undefined`) and passes it into `repo.listPosts`.
Route stays behind the existing `auth` middleware. The existing `angleOnly` handling stays.

### 3. Frontend API client

`packages/www/src/services/api.ts`: `listPosts` gains `angle?: string`; when set it adds
`qs.set('angle', angle)`. The existing `angleOnly` param is retained.

### 4. Store

`packages/www/src/stores/data.ts`: replace the `angleOnly` boolean ref with a string ref
`angleFilter` (default `''`). `loadPosts` maps it to the API call:

- `''` → no angle param (all posts)
- `'__any__'` → `{ angleOnly: true }`
- any other value (a filter label) → `{ angle: <value> }`

```ts
const angleFilter = ref('');
async function loadPosts(params: { handle?: string; q?: string } = {}): Promise<void> {
  loading.value = true;
  const sel = angleFilter.value;
  const extra = sel === '' ? {} : sel === '__any__' ? { angleOnly: true } : { angle: sel };
  try { posts.value = await api.listPosts({ ...params, ...extra, limit: 200 }); }
  finally { loading.value = false; }
}
```

`angleFilter` (replacing `angleOnly`) is added to the store's returned object. The reserved
sentinel `'__any__'` could in theory collide with a real filter label, but only if the user
deliberately named a filter `__any__`; that edge is accepted and no guard is added (YAGNI).

### 5. Feed view

`packages/www/src/views/FeedView.vue`: replace the checkbox `<label>` with a `<select>` bound
to `data.angleFilter` with `@change="applyFilters"`, styled like the existing `handleFilter`
select:

```html
<select v-model="data.angleFilter" @change="applyFilters"
  class="bg-gray-900 border border-gray-700 rounded px-2 py-2 text-sm">
  <option value="">All posts</option>
  <option value="__any__">Matched (any filter)</option>
  <option v-for="f in data.filters" :key="f.label" :value="f.label">
    {{ f.emoji }} {{ f.label }}
  </option>
</select>
```

Filters are already loaded into the store on Feed mount (`data.loadFilters()` from the badges
work), so the options populate without additional wiring.

## Testing

- **repo** (`__tests__/repo.test.ts`): with posts carrying `angles` `"money,business"` and
  `"economy"`, `listPosts({ angle: 'money' })` returns only the first; `listPosts({ angle:
  'eco' })` returns none (no substring match); `listPosts({ angle: 'economy' })` returns the
  second.
- **www api** (`__tests__/api.test.ts`): `listPosts({ angle: 'money' })` builds a URL
  containing `angle=money`; the existing `angleOnly` test stays.
- **routes** (`__tests__/routes.test.ts`): `/api/posts?angle=money` returns only posts whose
  angles include `money`; the existing `angleOnly` route test stays.
- The `<select>` wiring is covered by the `vue-tsc` build gate, consistent with the existing
  Feed `handleFilter` select (no component-mount test infra is introduced).

## Out of scope (YAGNI)

- Multi-select / multiple simultaneous angle filters.
- Angle filtering in Reports or the Excel export (Feed only).
- A guard against a user naming a filter the literal `__any__`.

## Risks / notes

- Posts collected before the AI ran (or while Ollama was down) have `angles = NULL`; the
  `(',' || angles || ',')` expression is NULL for them, so they are correctly excluded from
  any specific-angle or matched-any view and only appear under "All posts".
- Removing the `angleOnly` store boolean is a breaking rename within the SPA only; no API
  contract changes (the `angleOnly` query param and behavior remain).
