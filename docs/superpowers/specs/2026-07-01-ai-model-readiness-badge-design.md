# AI model readiness badge

**Date:** 2026-07-01
**Status:** Approved

## Problem

When the stack first comes up, the Ollama model (`gemma3:4b` by default) is pulled by a
separate one-shot `ollama-pull` container (`docker-compose.yml`). The model download takes
minutes. During that window the app still reports AI as available and tries to classify
posts, Ollama returns errors, and every post is marked `ai_status = 'error'`.

The result: a new user sees no classified/translated posts and concludes "it doesn't work",
when in fact the model simply hasn't finished downloading. There is no signal anywhere in the
UI that a download is in progress.

Root cause: `index.ts` sets `aiAvailable = provider !== null`, which is `true` as soon as
Ollama is *configured*, regardless of whether the model has actually been pulled.

## What already works (no change needed)

- `listPostsNeedingAi` (repo.ts) already re-selects posts with `ai_status = 'error'`.
- `scheduler.ts` runs `aiProcess` on every poll cycle.

Together these mean the system **self-heals**: once the model finishes downloading, the next
poll cycle (~5 min) re-classifies the previously errored posts. So the only thing missing is
**visibility** — the user needs to know a download is in progress. No retry logic is required.

## Scope

A readiness signal only — ready vs not-ready. No byte-level percentage. No changes to
`docker-compose.yml` or the `ollama-pull` container. The app reads readiness from Ollama; it
does not own the pull.

## Design

### Backend

1. **`OllamaProvider.ready()`**
   - Add an optional method to the `AiProvider` interface:
     `ready?(): Promise<boolean>`.
   - Implement in `OllamaProvider`:
     - `GET {host}/api/tags`, parse `{ models: [{ name: string }] }`.
     - Return `true` if the configured model is present: exact match against a `name`
       entry, or — when the configured model has no `:tag` — a match on the part before
       the `:` of any entry (`gemma3` matches `gemma3:4b`).
     - Any error / Ollama unreachable / unparseable response → `false`.
     - Memoize a `true` result: once ready, cache and short-circuit without hitting Ollama
       again (a downloaded model cannot un-download). A `false` result is not cached.
   - Add an injectable `getJson` dependency mirroring the existing injectable `postJson`
     (defaulted to a `fetch`-based implementation), so `ready()` is unit-testable the same
     way `classify`/`translate` are.

2. **`GET /api/ai/status`** (auth-protected, consistent with other routes)
   - Response shape: `{ configured: boolean, model: string | null, ready: boolean }`.
     - `configured`: whether an AI provider is set (the current `aiAvailable` value).
     - `model`: `config.aiModel` when configured, else `null`.
     - `ready`: `configured ? await checkAiReady() : false`.
   - Plumb a `checkAiReady?: () => Promise<boolean>` callback from
     `index.ts → app.ts → routes.ts`, alongside the existing `aiAvailable`. In `index.ts` it
     is `provider?.ready ? () => provider.ready!() : async () => false`. The model name comes
     from `config.aiModel`.

### Frontend

3. **`api.aiStatus()`** in `services/api.ts`
   - `GET /api/ai/status`, typed as `{ configured: boolean; model: string | null; ready: boolean }`.

4. **`stores/ai.ts`** (new Pinia store)
   - Holds the latest status and owns a polling interval.
   - `start()`: fetch immediately, then poll every 5s while `configured && !ready`. Stop
     polling once `ready` is `true` or `configured` is `false`. Errors during polling are
     swallowed (treated as not-ready; keep polling).
   - `stop()`: clear the interval (called on logout).
   - Exposes a `downloading` getter = `configured && !ready`.

5. **Global banner in `App.vue`**
   - Shown on all authed views (hidden on `/login`), above `<RouterView />`.
   - Visible while `ai.downloading`. Copy:
     *"⏳ AI model still downloading — filtering & translation start automatically once it's
     ready."*
   - Amber styling consistent with the existing dark theme (e.g. amber text on a subtle
     amber/gray background), matching the Tailwind utility style already used in the app.
   - Start polling when a token is present (on mount if already logged in, and after login);
     stop on logout.

## Testing

- **`ollama.test.ts`** — `ready()`:
  - model present in `/api/tags` → `true`.
  - model absent → `false`.
  - Ollama unreachable (`getJson` returns not-ok / throws) → `false`.
  - memoization: after a `true`, a second call does not call `getJson`.
  - tag-less configured model matches a tagged entry.
- **`routes.test.ts`** — `GET /api/ai/status`:
  - configured + ready → `{ configured: true, model, ready: true }`.
  - configured + not-ready → `{ configured: true, model, ready: false }`.
  - not configured → `{ configured: false, model: null, ready: false }`.
  - requires auth (401 without token).

## Out of scope

- Byte-level download percentage / progress bar.
- Changes to `docker-compose.yml` or the `ollama-pull` container.
- Retry logic for errored posts (already handled by the existing poll + `listPostsNeedingAi`).
