# AI Model Readiness Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a UI banner while the Ollama model is still downloading, so users know classification/translation will start automatically rather than assuming the app is broken.

**Architecture:** Add a `ready()` capability to `OllamaProvider` that queries Ollama's `/api/tags` to detect whether the configured model is present. Expose it via a new auth-protected `GET /api/ai/status` route. The Vue frontend polls this route and shows a global amber banner while the model is downloading.

**Tech Stack:** TypeScript, Express 5, Zod, Vitest + supertest (API); Vue 3, Pinia, Tailwind, vue-tsc (web).

## Global Constraints

- Readiness is a boolean signal only — no byte-level percentage / progress bar.
- No changes to `docker-compose.yml` or the `ollama-pull` container. The app reads readiness from Ollama; it does not own the pull.
- No retry logic — errored posts already re-run each poll (`repo.listPostsNeedingAi` includes `ai_status = 'error'`; `scheduler.ts` runs `aiProcess` every cycle).
- The default AI model is `gemma3:4b` (`config.aiModel`).
- Follow existing patterns: injectable HTTP deps for unit-testing the provider (mirror the existing `postJson`), auth-protected routes returning JSON, Pinia setup-stores.

---

### Task 1: `OllamaProvider.ready()`

**Files:**
- Modify: `packages/api/src/ai/provider.ts` (add optional interface method)
- Modify: `packages/api/src/ai/ollama.ts` (add `GetJson` type, default impl, `ready()`)
- Test: `packages/api/__tests__/ollama.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AiProvider.ready?(): Promise<boolean>`
  - `OllamaProvider` gains a `getJson?: GetJson` constructor dep and a `ready(): Promise<boolean>` method.
  - `export type GetJson = (url: string, timeoutMs: number) => Promise<{ ok: boolean; status: number; json: unknown }>;`

- [ ] **Step 1: Write the failing tests**

Add to `packages/api/__tests__/ollama.test.ts` (append a new `describe` block; keep the existing `stub`/`import` at the top and add `GetJson` to the import):

Change the import line at the top of the file to:
```ts
import { OllamaProvider, type PostJson, type GetJson } from '../src/ai/ollama.js';
```

Append this block at the end of the file:
```ts
function tagsStub(names: string[]): GetJson {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: { models: names.map(name => ({ name })) },
  }));
}

describe('OllamaProvider.ready', () => {
  it('is true when the configured model is present', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson: tagsStub(['gemma3:4b', 'llama3:8b']) });
    expect(await p.ready()).toBe(true);
  });

  it('is false when the configured model is absent', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson: tagsStub(['llama3:8b']) });
    expect(await p.ready()).toBe(false);
  });

  it('matches a tag-less configured model against a tagged entry', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3', getJson: tagsStub(['gemma3:4b']) });
    expect(await p.ready()).toBe(true);
  });

  it('is false when ollama is unreachable', async () => {
    const getJson: GetJson = vi.fn(async () => ({ ok: false, status: 0, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson });
    expect(await p.ready()).toBe(false);
  });

  it('memoizes a true result and does not call ollama again', async () => {
    const getJson = tagsStub(['gemma3:4b']);
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson });
    expect(await p.ready()).toBe(true);
    expect(await p.ready()).toBe(true);
    expect((getJson as any).mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- ollama`
Expected: FAIL — `ready` is not a function / `getJson` not a known constructor option (type error or runtime failure).

- [ ] **Step 3: Add the optional interface method**

In `packages/api/src/ai/provider.ts`, add `ready` to the interface:
```ts
export interface AiProvider {
  classify(text: string, labels: string[]): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
  ready?(): Promise<boolean>;
}
```

- [ ] **Step 4: Implement `GetJson`, the default impl, and `ready()`**

In `packages/api/src/ai/ollama.ts`:

Add the `GetJson` type next to the existing `PostJson` type (after line 7):
```ts
export type GetJson = (url: string, timeoutMs: number)
  => Promise<{ ok: boolean; status: number; json: unknown }>;
```

Add the default GET implementation after `defaultPostJson`:
```ts
const defaultGetJson: GetJson = async (url, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
};
```

Add a tags schema next to the other zod schemas:
```ts
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
```

Update the class: add the `getJson` field, accept it in the constructor, add a `ready` memo flag, and implement `ready()`. Replace the class field/constructor region so it reads:
```ts
export class OllamaProvider implements AiProvider {
  private host: string;
  private model: string;
  private postJson: PostJson;
  private getJson: GetJson;
  private readyCache = false;

  constructor(deps: { host: string; model: string; postJson?: PostJson; getJson?: GetJson }) {
    this.host = deps.host.replace(/\/$/, '');
    this.model = deps.model;
    this.postJson = deps.postJson ?? defaultPostJson;
    this.getJson = deps.getJson ?? defaultGetJson;
  }

  async ready(): Promise<boolean> {
    if (this.readyCache) return true;
    const res = await this.getJson(`${this.host}/api/tags`, TIMEOUT_MS);
    if (!res.ok) return false;
    const parsed = tagsSchema.safeParse(res.json);
    if (!parsed.success) return false;
    const want = this.model.toLowerCase();
    const wantBase = want.split(':')[0];
    const hasTag = want.includes(':');
    const found = parsed.data.models.some(m => {
      const name = m.name.toLowerCase();
      return name === want || (!hasTag && name.split(':')[0] === wantBase);
    });
    if (found) this.readyCache = true;
    return found;
  }
```

(Leave the existing `chat`, `classify`, and `translate` methods unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- ollama`
Expected: PASS (all `OllamaProvider.classify`, `.ready`, and translate tests green).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @x-osint/api`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/ai/provider.ts packages/api/src/ai/ollama.ts packages/api/__tests__/ollama.test.ts
git commit -m "feat(api): OllamaProvider.ready() checks model presence via /api/tags"
```

---

### Task 2: `GET /api/ai/status` route

**Files:**
- Modify: `packages/api/src/http/routes.ts` (new route + `checkAiReady` param)
- Modify: `packages/api/src/http/app.ts` (thread `checkAiReady` through `AppDeps`)
- Modify: `packages/api/src/index.ts` (wire `provider.ready` into `checkAiReady`)
- Test: `packages/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `OllamaProvider.ready()` from Task 1; existing `aiAvailable` boolean; `config.aiModel`.
- Produces:
  - `createRoutes(config, repo, triggerFetch, aiAvailable?, checkAiReady?)` — new optional 5th arg `checkAiReady: () => Promise<boolean>` defaulting to `async () => false`.
  - `AppDeps.checkAiReady?: () => Promise<boolean>`.
  - Route `GET /api/ai/status` → `{ configured: boolean, model: string | null, ready: boolean }`.

- [ ] **Step 1: Write the failing tests**

In `packages/api/__tests__/routes.test.ts`, extend `setup` to accept overrides and add a new `describe`. Replace the existing `setup` function (lines 15-21) with:
```ts
function setup(opts: { aiAvailable?: boolean; checkAiReady?: () => Promise<boolean> } = {}) {
  const config = loadConfig({ X_OSINT_PASSWORD: 'pw' });
  const repo = createRepo(openDb(':memory:'));
  const triggerFetch = vi.fn();
  const app = createApp({
    config, repo, triggerFetch,
    aiAvailable: opts.aiAvailable ?? true,
    checkAiReady: opts.checkAiReady,
  });
  return { app, repo, triggerFetch };
}
```

Append this new describe block at the end of the file:
```ts
describe('ai status route', () => {
  it('requires auth', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/ai/status')).status).toBe(401);
  });

  it('reports configured + ready when the model is present', async () => {
    const ctx = setup({ aiAvailable: true, checkAiReady: async () => true });
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/ai/status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, model: 'gemma3:4b', ready: true });
  });

  it('reports configured but not ready while the model is downloading', async () => {
    const ctx = setup({ aiAvailable: true, checkAiReady: async () => false });
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/ai/status').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ configured: true, model: 'gemma3:4b', ready: false });
  });

  it('reports not-configured with a null model when AI is off', async () => {
    const ctx = setup({ aiAvailable: false });
    const token = await tokenFor(ctx.app);
    const res = await request(ctx.app).get('/api/ai/status').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ configured: false, model: null, ready: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @x-osint/api -- routes`
Expected: FAIL — `/api/ai/status` returns 404 (route missing) / `checkAiReady` not accepted by `createApp` types.

- [ ] **Step 3: Add the route + param in `routes.ts`**

In `packages/api/src/http/routes.ts`, change the `createRoutes` signature to add the 5th parameter:
```ts
export function createRoutes(
  config: Config,
  repo: Repo,
  triggerFetch: () => void,
  aiAvailable = false,
  checkAiReady: () => Promise<boolean> = async () => false,
): Router {
```

Add this route immediately after the `/health` route (after line 40):
```ts
  router.get('/ai/status', auth, async (_req: Request, res: Response) => {
    const configured = aiAvailable;
    const model = configured ? config.aiModel : null;
    const ready = configured ? await checkAiReady() : false;
    res.json({ configured, model, ready });
  });
```

- [ ] **Step 4: Thread `checkAiReady` through `app.ts`**

In `packages/api/src/http/app.ts`, add the field to `AppDeps` and pass it through:
```ts
export interface AppDeps {
  config: Config;
  repo: Repo;
  triggerFetch: () => void;
  staticDir?: string;
  aiAvailable?: boolean;
  checkAiReady?: () => Promise<boolean>;
}
```
And update the `createRoutes` call:
```ts
  app.use('/api', createRoutes(deps.config, deps.repo, deps.triggerFetch, deps.aiAvailable ?? false, deps.checkAiReady));
```

- [ ] **Step 5: Wire the provider in `index.ts`**

In `packages/api/src/index.ts`, build a `checkAiReady` from the provider and pass it to `createApp`. Replace the `createApp({...})` call (lines 29-34) with:
```ts
  const checkAiReady = async (): Promise<boolean> =>
    provider && provider.ready ? provider.ready() : false;

  const app = createApp({
    config, repo,
    triggerFetch: () => scheduler.triggerNow(),
    staticDir,
    aiAvailable: provider !== null,
    checkAiReady,
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @x-osint/api -- routes`
Expected: PASS (new ai-status tests plus all existing routes/reports/settings tests green).

- [ ] **Step 7: Typecheck the whole api package**

Run: `npm run typecheck -w @x-osint/api`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/http/routes.ts packages/api/src/http/app.ts packages/api/src/index.ts packages/api/__tests__/routes.test.ts
git commit -m "feat(api): GET /api/ai/status reports model readiness"
```

---

### Task 3: Frontend readiness banner

**Files:**
- Modify: `packages/www/src/services/api.ts` (add `AiStatus` type + `aiStatus()`)
- Create: `packages/www/src/stores/ai.ts` (polling store)
- Modify: `packages/www/src/App.vue` (global banner + start/stop polling)

**Interfaces:**
- Consumes: `GET /api/ai/status` from Task 2.
- Produces:
  - `api.aiStatus(): Promise<AiStatus>` where `AiStatus = { configured: boolean; model: string | null; ready: boolean }`.
  - `useAi()` Pinia store exposing `configured`, `ready`, `downloading` (computed `configured && !ready`), `start()`, `stop()`.

- [ ] **Step 1: Add the API method**

In `packages/www/src/services/api.ts`, add the type near the other interfaces (e.g. after the `Filter` interface, before `ApiError`):
```ts
export interface AiStatus {
  configured: boolean;
  model: string | null;
  ready: boolean;
}
```
Add the method inside the `api` object (e.g. after `reclassifyAll`):
```ts
  aiStatus(): Promise<AiStatus> { return call<AiStatus>('GET', '/ai/status'); },
```

- [ ] **Step 2: Create the polling store**

Create `packages/www/src/stores/ai.ts`:
```ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '../services/api';

export const useAi = defineStore('ai', () => {
  const configured = ref(false);
  const ready = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  const downloading = computed(() => configured.value && !ready.value);

  async function refresh(): Promise<void> {
    try {
      const s = await api.aiStatus();
      configured.value = s.configured;
      ready.value = s.ready;
      if (!s.configured || s.ready) stop();
    } catch {
      /* transient error — keep polling, treat as not-ready */
    }
  }

  function start(): void {
    if (timer) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, 5000);
  }

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { configured, ready, downloading, start, stop };
});
```

- [ ] **Step 3: Add the banner and lifecycle wiring in `App.vue`**

Replace the entire contents of `packages/www/src/App.vue` with:
```vue
<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView, RouterLink, useRoute } from 'vue-router';
import { useAuth } from './stores/auth';
import { useAi } from './stores/ai';
const auth = useAuth();
const ai = useAi();
const route = useRoute();

onMounted(() => { if (auth.token) ai.start(); });
watch(() => auth.token, (t) => { if (t) ai.start(); else ai.stop(); });
</script>

<template>
  <div class="min-h-screen">
    <nav v-if="route.path !== '/login'" class="flex items-center gap-4 px-4 py-3 bg-gray-800 border-b border-gray-700">
      <span class="font-semibold text-cyan-400">x-osint</span>
      <RouterLink to="/" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Feed</RouterLink>
      <RouterLink to="/accounts" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Accounts</RouterLink>
      <RouterLink to="/reports" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Reports</RouterLink>
      <RouterLink to="/settings" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Settings</RouterLink>
      <button class="ml-auto text-sm text-gray-400 hover:text-gray-200" @click="auth.logout(); $router.push('/login')">Logout</button>
    </nav>
    <div v-if="ai.downloading && route.path !== '/login'"
      class="bg-amber-900/40 border-b border-amber-700/50 text-amber-200 text-sm px-4 py-2">
      ⏳ AI model still downloading — filtering &amp; translation start automatically once it's ready.
    </div>
    <main class="p-4 max-w-3xl mx-auto">
      <RouterView />
    </main>
  </div>
</template>
```

- [ ] **Step 4: Typecheck + build the web package**

Run: `npm run build -w @x-osint/www`
Expected: `vue-tsc` passes with no type errors and `vite build` completes.

- [ ] **Step 5: Commit**

```bash
git add packages/www/src/services/api.ts packages/www/src/stores/ai.ts packages/www/src/App.vue
git commit -m "feat(www): global banner while AI model is downloading"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full api test suite**

Run: `npm test -w @x-osint/api`
Expected: all tests pass.

- [ ] **Step 2: Rebuild the image and bring the stack up**

Run: `docker compose up -d --build`
Expected: containers start; `ollama-pull` begins pulling the model.

- [ ] **Step 3: Confirm the endpoint reflects readiness**

While the model is still downloading (before `ollama-pull` finishes), log in through the UI at http://localhost:8080 and confirm the amber banner appears. Then either wait for the pull to finish or run `docker compose logs ollama-pull` to confirm completion; re-check that the banner disappears within ~5s and classified/translated posts begin appearing on the next poll.

Alternatively verify the API directly:
```bash
TOKEN=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"password":"changeme"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s localhost:8080/api/ai/status -H "Authorization: Bearer $TOKEN"
```
Expected: `{"configured":true,"model":"gemma3:4b","ready":false}` mid-download, flipping to `"ready":true` once the pull completes.

---

## Self-Review

**Spec coverage:**
- `OllamaProvider.ready()` incl. tag-less match, unreachable→false, memoization → Task 1. ✓
- `GET /api/ai/status` with configured/model/ready + auth → Task 2. ✓
- `checkAiReady` plumbing index→app→routes → Task 2 steps 3-5. ✓
- `api.aiStatus()` → Task 3 step 1. ✓
- `stores/ai.ts` with 5s poll, stop-on-ready/not-configured, `downloading` getter → Task 3 step 2. ✓
- Global banner in `App.vue`, hidden on `/login`, start-on-token/stop-on-logout → Task 3 step 3. ✓
- Tests for `ready()` and `/api/ai/status` → Tasks 1 & 2. ✓
- Out-of-scope items (no %, no compose changes, no retry logic) respected. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step contains full code. ✓

**Type consistency:** `checkAiReady: () => Promise<boolean>` used identically in `routes.ts`, `app.ts`, `index.ts`. `AiStatus`/`{configured, model, ready}` shape identical across route response, `api.aiStatus`, and store. `GetJson` signature matches its default impl and test stub. `downloading = configured && !ready` consistent between store and banner `v-if`. ✓
