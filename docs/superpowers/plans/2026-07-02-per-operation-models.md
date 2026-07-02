# Per-Operation AI Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use a fast model for the per-post pipeline (classify + translate) and a separate quality model for summarize, configured via `AI_MODEL` / `AI_SUMMARIZE_MODEL`, with single-model behavior preserved by default.

**Architecture:** Add `summarizeModel` to config (falling back to `AI_MODEL`). `OllamaProvider` gains a `summarizeModel` and a per-call `model` param on its private `chat`; classify/translate use the primary model, summarize uses the summarize model. Docker pulls both models.

**Tech Stack:** TypeScript, Zod, Vitest (API); Docker Compose.

## Global Constraints

- `AI_MODEL` = fast model for classify + translate (default `gemma3:4b`).
- `AI_SUMMARIZE_MODEL` = model for summarize; falls back to the resolved `AI_MODEL` when unset.
- `ready()` / `/ai/status` unchanged (keyed on the primary model); missing summarize model degrades to the existing "AI summary unavailable" fallback.
- `ollama-pull` pulls BOTH models; second pull is a no-op when they're equal.
- No UI, no timeout changes, no change to which posts are processed.

---

### Task 1: Config — `AI_SUMMARIZE_MODEL`

**Files:**
- Modify: `packages/api/src/types.ts`
- Modify: `packages/api/src/config.ts`
- Test: `packages/api/__tests__/config.test.ts`

**Interfaces:**
- Produces: `Config.summarizeModel: string`; `loadConfig` reads `AI_SUMMARIZE_MODEL` (falls back to resolved `aiModel`).

- [ ] **Step 1: Write the failing tests**

In `packages/api/__tests__/config.test.ts`, add inside `describe('loadConfig', ...)`:
```ts
  it('defaults summarizeModel to aiModel when AI_SUMMARIZE_MODEL is unset', () => {
    const cfg = loadConfig({ X_OSINT_PASSWORD: 'pw' });
    expect(cfg.aiModel).toBe('gemma3:4b');
    expect(cfg.summarizeModel).toBe('gemma3:4b');
  });

  it('falls summarizeModel back to a custom AI_MODEL when AI_SUMMARIZE_MODEL is unset', () => {
    const cfg = loadConfig({ X_OSINT_PASSWORD: 'pw', AI_MODEL: 'gemma3:1b' });
    expect(cfg.aiModel).toBe('gemma3:1b');
    expect(cfg.summarizeModel).toBe('gemma3:1b');
  });

  it('uses AI_SUMMARIZE_MODEL when set, independent of AI_MODEL', () => {
    const cfg = loadConfig({ X_OSINT_PASSWORD: 'pw', AI_MODEL: 'gemma3:1b', AI_SUMMARIZE_MODEL: 'gemma3:4b' });
    expect(cfg.aiModel).toBe('gemma3:1b');
    expect(cfg.summarizeModel).toBe('gemma3:4b');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- config`
Expected: FAIL — `cfg.summarizeModel` is `undefined` (property does not exist).

- [ ] **Step 3: Add the type field**

In `packages/api/src/types.ts`, add `summarizeModel` right after `aiModel: string;`:
```ts
  aiModel: string;
  summarizeModel: string;
```

- [ ] **Step 4: Compute `summarizeModel` in `loadConfig`**

In `packages/api/src/config.ts`, just BEFORE the `return {` statement, add two locals:
```ts
  const aiModel = env.AI_MODEL?.trim() || 'gemma3:4b';
  const summarizeModel = env.AI_SUMMARIZE_MODEL?.trim() || aiModel;
```
Then in the returned object, replace the inline `aiModel:` line and add `summarizeModel`:
```ts
    aiModel,
    summarizeModel,
```
(Remove the old `aiModel: env.AI_MODEL?.trim() || 'gemma3:4b',` line so `aiModel` is not computed twice.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- config` → Expected: PASS.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/types.ts packages/api/src/config.ts packages/api/__tests__/config.test.ts
git commit -m "feat(api): AI_SUMMARIZE_MODEL config (falls back to AI_MODEL)"
```

---

### Task 2: Provider — per-operation model selection

**Files:**
- Modify: `packages/api/src/ai/ollama.ts`
- Modify: `packages/api/src/ai/factory.ts`
- Test: `packages/api/__tests__/ollama.test.ts`

**Interfaces:**
- Consumes: `config.summarizeModel` (Task 1).
- Produces: `OllamaProvider` constructor deps gain optional `summarizeModel?: string` (defaults to `deps.model`); `classify`/`translate` post `body.model === model` (primary), `summarize` posts `body.model === summarizeModel`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/__tests__/ollama.test.ts` (the file has a `stub(content)` helper returning a `PostJson` mock and imports `OllamaProvider`, `vi`):
```ts
describe('OllamaProvider per-operation model', () => {
  it('summarize uses the summarize model in the request body', async () => {
    const post = stub('a summary');
    const p = new OllamaProvider({ host: 'http://x', model: 'fast', summarizeModel: 'quality', postJson: post });
    await p.summarize(['post one'], 'money');
    expect((post as any).mock.calls[0][1].model).toBe('quality');
  });

  it('classify and translate use the primary (fast) model, not the summarize model', async () => {
    const post = stub(JSON.stringify({ angles: [] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'fast', summarizeModel: 'quality', postJson: post });
    await p.classify('text', ['money']);
    expect((post as any).mock.calls[0][1].model).toBe('fast');

    const post2 = stub('olá');
    const p2 = new OllamaProvider({ host: 'http://x', model: 'fast', summarizeModel: 'quality', postJson: post2 });
    await p2.translate('hello');
    expect((post2 as any).mock.calls[0][1].model).toBe('fast');
  });

  it('summarizeModel defaults to the primary model when omitted', async () => {
    const post = stub('a summary');
    const p = new OllamaProvider({ host: 'http://x', model: 'only', postJson: post });
    await p.summarize(['x'], 'money');
    expect((post as any).mock.calls[0][1].model).toBe('only');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- ollama`
Expected: FAIL — `summarize` still posts `model: 'fast'` (the summarize test expects `'quality'`); `summarizeModel` not accepted by the constructor.

- [ ] **Step 3: Add `summarizeModel` to the provider**

In `packages/api/src/ai/ollama.ts`:

(a) Add the field (after `private model: string;`):
```ts
  private model: string;
  private summarizeModel: string;
```

(b) Extend the constructor deps and assignment:
```ts
  constructor(deps: { host: string; model: string; summarizeModel?: string; postJson?: PostJson; getJson?: GetJson }) {
    this.host = deps.host.replace(/\/$/, '');
    this.model = deps.model;
    this.summarizeModel = deps.summarizeModel ?? deps.model;
    this.postJson = deps.postJson ?? defaultPostJson;
    this.getJson = deps.getJson ?? defaultGetJson;
  }
```

(c) Add a per-call `model` param to `chat` and use it in the body:
```ts
  private async chat(system: string, user: string, json: boolean, timeoutMs: number = TIMEOUT_MS, model: string = this.model): Promise<string> {
    const res = await this.postJson(`${this.host}/api/chat`, {
      model,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, timeoutMs);
    if (!res.ok) throw new Error(`ollama request failed: ${res.status}`);
    return messageSchema.parse(res.json).message.content;
  }
```
(`classify` and `translate` call `chat(...)` without the `model` arg, so they keep using `this.model`.)

(d) In `summarize`, pass the summarize model as the 5th arg:
```ts
    const content = await this.chat(summarizeSystem(tag), user, false, SUMMARIZE_TIMEOUT_MS, this.summarizeModel);
```

- [ ] **Step 4: Wire the factory**

In `packages/api/src/ai/factory.ts`, pass `summarizeModel`:
```ts
  return new OllamaProvider({
    host: config.ollamaHost,
    model: config.aiModel,
    summarizeModel: config.summarizeModel,
  });
```

- [ ] **Step 5: Run the tests + full suite + typecheck**

Run: `npm test -w @x-osint/api -- ollama` → Expected: PASS (new per-operation-model tests + all existing classify/translate/summarize/ready tests).
Run: `npm test -w @x-osint/api` → Expected: all files pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/ai/ollama.ts packages/api/src/ai/factory.ts packages/api/__tests__/ollama.test.ts
git commit -m "feat(api): summarize uses AI_SUMMARIZE_MODEL; classify/translate use AI_MODEL"
```

---

### Task 3: Docker — pull and pass both models

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `AI_MODEL`, `AI_SUMMARIZE_MODEL` env.
- Produces: the app receives `AI_SUMMARIZE_MODEL`; `ollama-pull` pulls both models.

- [ ] **Step 1: Add `AI_SUMMARIZE_MODEL` to the app service**

In `docker-compose.yml`, under the `x-osint` service `environment:` block, add the line right after `AI_MODEL`:
```yaml
      AI_MODEL: ${AI_MODEL:-gemma3:4b}
      AI_SUMMARIZE_MODEL: ${AI_SUMMARIZE_MODEL:-gemma3:4b}
```

- [ ] **Step 2: Make `ollama-pull` pull both models**

In `docker-compose.yml`, update the `ollama-pull` service `environment` and `entrypoint`:
```yaml
    environment:
      OLLAMA_HOST: http://ollama:11434
      AI_MODEL: ${AI_MODEL:-gemma3:4b}
      AI_SUMMARIZE_MODEL: ${AI_SUMMARIZE_MODEL:-gemma3:4b}
    entrypoint: ["/bin/sh", "-c", "ollama pull \"$AI_MODEL\" && ollama pull \"$AI_SUMMARIZE_MODEL\""]
```

- [ ] **Step 3: Validate the compose file**

Run: `docker compose config >/dev/null && echo "compose OK"`
Expected: `compose OK` (no YAML/interpolation errors). With defaults, both resolve to `gemma3:4b`; with `AI_MODEL=gemma3:1b docker compose config`, the app env shows `AI_MODEL=gemma3:1b` and `AI_SUMMARIZE_MODEL=gemma3:4b`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(docker): pass AI_SUMMARIZE_MODEL and pull both models"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api suite + typecheck**

Run: `npm test -w @x-osint/api` → Expected: all pass.
Run: `npm run typecheck -w @x-osint/api` → Expected: clean.

- [ ] **Step 2: Rebuild with a fast classify model and confirm the split**

Bring the stack up with a small fast model for the per-post pipeline while summaries stay on the larger model:
```bash
AI_MODEL=gemma3:1b docker compose up -d --build
```
Expected: `ollama-pull` pulls both `gemma3:1b` and `gemma3:4b` (`docker compose logs ollama-pull`); the app comes up (`curl -s localhost:8080/api/health` → `{"status":"ok"}`).

- [ ] **Step 3: Confirm per-operation model use at runtime**

- Readiness reflects the primary model:
  ```bash
  TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
  curl -s localhost:8080/api/ai/status -H "Authorization: Bearer $TOKEN"   # model: gemma3:1b
  ```
- Watch the AI queue drain far faster than before now that classify/translate run on `gemma3:1b`:
  ```bash
  curl -s -X POST localhost:8080/api/settings/reclassify -H "Authorization: Bearer $TOKEN"; echo
  for i in $(seq 1 12); do curl -s localhost:8080/api/ai/queue -H "Authorization: Bearer $TOKEN"; echo; sleep 5; done
  ```
  Expected: `pending` now drops steadily (small model classifies in seconds), and `current.phase` cycles through `classify`/`translate` reaching completions. Then run an export (`include: report`) and confirm the analysis narrative is produced by the `gemma3:4b` summarize model (real prose, not the fallback note).

---

## Self-Review

**Spec coverage:**
- `AI_SUMMARIZE_MODEL` → `config.summarizeModel`, fallback to resolved `aiModel` → Task 1. ✓
- `OllamaProvider` `summarizeModel` + per-call `model` on `chat`; classify/translate → primary, summarize → summarize model → Task 2. ✓
- Factory wires `summarizeModel` → Task 2 step 4. ✓
- `ready()` unchanged (still `this.model`) → not modified in any task. ✓
- docker-compose: app env `AI_SUMMARIZE_MODEL`; `ollama-pull` pulls both → Task 3. ✓
- Tests: config default/fallback/override; provider posts correct `body.model` per op → Tasks 1, 2. ✓
- Out-of-scope (UI, per-model badge, timeouts) respected. ✓

**Placeholder scan:** No TBD/vague steps; complete code in every code step. ✓

**Type consistency:** `Config.summarizeModel: string` defined in Task 1, consumed by the factory in Task 2. `OllamaProvider` deps `summarizeModel?: string` (optional, defaults to `deps.model`) — existing tests that omit it still compile and `summarize` posts the primary model (covered by the "defaults" test). `chat(..., model: string = this.model)` param name/type consistent; `summarize` passes `this.summarizeModel`. Env names `AI_MODEL`/`AI_SUMMARIZE_MODEL` identical across config, compose app env, and `ollama-pull`. ✓
