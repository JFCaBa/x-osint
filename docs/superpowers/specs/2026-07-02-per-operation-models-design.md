# Per-operation AI models (fast classify/translate, quality summarize)

**Date:** 2026-07-02
**Status:** Approved (pending spec review)

## Problem

All three AI operations (classify, translate, summarize) run on a single model
(`AI_MODEL`, default `gemma3:4b`). On CPU-only hosts the per-post pipeline
(classify on every post, translate on matched posts) is the throughput bottleneck —
it needs to be fast — while summarize runs only at export time and benefits from a
larger, higher-quality model. A single model can't be both.

## Goal

Allow a fast model for the per-post pipeline (classify + translate) and a separate,
higher-quality model for summarize, configured via environment variables, with the
single-model behavior preserved by default.

## Scope decisions (from brainstorming)

- **Fast model** (`AI_MODEL`): classify + translate.
- **Quality model** (`AI_SUMMARIZE_MODEL`): summarize; defaults to `AI_MODEL` when unset
  (so existing single-model setups are unchanged — you opt in by setting `AI_MODEL`
  to a small model and leaving summarize on the larger default).
- Readiness (`/ai/status.ready`) stays keyed on the primary/fast model only. If the
  summarize model isn't pulled yet, export summaries use the existing "AI summary
  unavailable" fallback — no failure, no blocked badge.
- Env-only configuration (no UI to pick models). Timeouts unchanged.

## Architecture

### Config (`packages/api/src/config.ts`, `packages/api/src/types.ts`)

- `Config` gains `summarizeModel: string`.
- In `loadConfig`, after `aiModel` is computed:
  ```ts
  summarizeModel: env.AI_SUMMARIZE_MODEL?.trim() || aiModel,
  ```
  where `aiModel = env.AI_MODEL?.trim() || 'gemma3:4b'` (unchanged). So:
  - neither set → both `gemma3:4b`;
  - only `AI_MODEL` set → summarize falls back to it;
  - both set → each used as given.

### Provider (`packages/api/src/ai/ollama.ts`)

- `OllamaProvider` constructor deps gain `summarizeModel: string`; store `this.summarizeModel`.
- The private `chat` gains a trailing `model` param defaulting to the primary model, and
  uses it in the request body:
  ```ts
  private async chat(system: string, user: string, json: boolean,
    timeoutMs: number = TIMEOUT_MS, model: string = this.model): Promise<string> {
    const res = await this.postJson(`${this.host}/api/chat`, {
      model,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
    }, timeoutMs);
    ...
  }
  ```
- `classify` and `translate` call `chat(...)` with no `model` arg → use `this.model`.
- `summarize` passes the summarize model:
  ```ts
  const content = await this.chat(summarizeSystem(tag), user, false, SUMMARIZE_TIMEOUT_MS, this.summarizeModel);
  ```
- `ready()` is unchanged (still checks `this.model` via `/api/tags`).

### Factory (`packages/api/src/ai/factory.ts`)

```ts
return new OllamaProvider({
  host: config.ollamaHost,
  model: config.aiModel,
  summarizeModel: config.summarizeModel,
});
```

### Docker (`docker-compose.yml`)

- Add to the `x-osint` service `environment`:
  ```yaml
  AI_SUMMARIZE_MODEL: ${AI_SUMMARIZE_MODEL:-gemma3:4b}
  ```
- The `ollama-pull` one-shot pulls **both** models (add the env var and update the
  entrypoint):
  ```yaml
    environment:
      OLLAMA_HOST: http://ollama:11434
      AI_MODEL: ${AI_MODEL:-gemma3:4b}
      AI_SUMMARIZE_MODEL: ${AI_SUMMARIZE_MODEL:-gemma3:4b}
    entrypoint: ["/bin/sh", "-c", "ollama pull \"$AI_MODEL\" && ollama pull \"$AI_SUMMARIZE_MODEL\""]
  ```
  When the two resolve to the same name the second pull is a no-op. The app-side
  fallback (`AI_SUMMARIZE_MODEL || AI_MODEL`) and the compose default (`gemma3:4b`)
  agree for the default case; when the user sets `AI_MODEL=gemma3:1b` and leaves
  summarize unset, compose passes `AI_SUMMARIZE_MODEL=gemma3:4b`, which the app reads
  directly — so both layers use the same summarize model.

## Testing

### `config.test.ts`
- `AI_SUMMARIZE_MODEL` set → `config.summarizeModel` equals it.
- `AI_MODEL` set, `AI_SUMMARIZE_MODEL` unset → `summarizeModel` equals `aiModel`.
- neither set → `aiModel` and `summarizeModel` both `gemma3:4b`.

### `ollama.test.ts`
- `summarize` sends `body.model === summarizeModel` (construct provider with distinct
  `model` and `summarizeModel`, assert the posted body's `model`).
- `classify` and `translate` send `body.model === model` (the primary), not the
  summarize model.

## Out of scope

- A UI to choose models.
- Per-model readiness reporting in the badge / `/ai/status`.
- Changing timeouts or which posts are processed.
- Non-Ollama providers.
