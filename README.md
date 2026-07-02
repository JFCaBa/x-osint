# x-osint

Self-hosted collector for X/Twitter accounts. Pulls posts from a watchlist via Nitter RSS
(no X API, no login), stores them in SQLite, and serves a web reader + JSON API.

## Run with Docker

### Choosing an inference backend (metal / cpu / gpu)

The app talks to Ollama; a `Makefile` selects **where Ollama runs** and launches the app
against it:

```bash
make cpu      # bundled container Ollama, CPU-only — portable, works anywhere
make metal    # native host Ollama on the Apple Metal GPU (macOS) — fast
make gpu      # bundled container Ollama with NVIDIA passthrough — Linux + NVIDIA hosts
make down     # stop everything
make logs     # tail the app logs
```

- **`make cpu`** is the self-contained default: it also starts a one-shot `ollama-pull`
  that downloads the models (`gemma3:4b` ~3 GB) into a named volume. First boot is slow
  (image build + model download); later runs are cached.
- **`make metal`** runs the app alone, pointing at a **native** Ollama on the host so
  inference uses the Apple Metal GPU (dramatically faster than CPU). Set it up once:
  ```bash
  make native-ollama   # brew install ollama + pull the models onto the host
  ```
  Native Ollama listens on `0.0.0.0:11434` (so the container can reach it via
  `host.docker.internal`) and stores models in `~/.ollama` (separate from the container
  volume).
- **`make gpu`** is for a Linux host with an NVIDIA GPU + `nvidia-container-toolkit`. It
  **does not work on macOS** (Docker cannot pass the Metal GPU into a Linux container) —
  use `make metal` on a Mac.

Set your login password and model in a local `.env` (auto-loaded by Compose), e.g.:

```bash
X_OSINT_PASSWORD=yourpassword
AI_MODEL=gemma3:1b            # fast per-post model (classify + translate)
AI_SUMMARIZE_MODEL=gemma3:4b  # quality model for report summaries
```

> After a `git pull`, the `make` targets pass `--build` so Compose rebuilds the image.

### Collector only (single container, no AI)

```bash
docker run -p 8080:8080 -v x-data:/data -e X_OSINT_PASSWORD=yourpassword x-osint
```

This runs the collector by itself with **no Ollama**, so AI classification/translation is
unavailable — the Feed still collects posts, but the angle filter and Reports export will be
empty. To enable AI on this path, point `OLLAMA_HOST` at a reachable Ollama instance; to
silence it, set `AI_PROVIDER=none`.

Either way, open http://localhost:8080, log in with your password, add accounts on the
**Accounts** page, and watch posts appear on the **Feed**.

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `X_OSINT_PASSWORD` | — (required) | login password for UI + API |
| `PORT` | 8080 | HTTP port |
| `DATA_DIR` | /data | SQLite file location (mount a volume) |
| `POLL_INTERVAL_MIN` | 5 | minutes between automatic polls |
| `RETENTION_DAYS` | 30 | how long posts are kept |
| `NITTER_INSTANCES` | built-in | JSON array of `{url,userAgent}` |
| `TOKEN_SECRET` | = password | secret for signing auth tokens |
| `AI_PROVIDER` | ollama | `ollama` (classify+translate via Ollama) or `none` to disable |
| `OLLAMA_HOST` | http://localhost:11434 | Ollama base URL |
| `AI_MODEL` | gemma3:4b | Ollama model for classification + Portuguese translation |
| `REPORT_TZ` | Europe/London | IANA timezone for the Excel report's Date column |

## API

All `/api/*` routes except `/api/login` and `/api/health` need `Authorization: Bearer <token>`
(get the token from `POST /api/login {"password":"..."}`).

- `GET /api/posts?handle=&q=&since=&limit=` — collected posts, newest first
- `GET /api/accounts`, `POST /api/accounts {handle}`, `PATCH /api/accounts/:handle {enabled}`, `DELETE /api/accounts/:handle`
- `POST /api/fetch` — trigger an immediate poll

## AI & Reports

Posts are classified at collection time for **money / entrepreneurship / business / economy**
angles using a self-hosted Ollama model (`gemma3:4b` by default); matches are translated to
Portuguese. The **Reports** page exports matching stories to an Excel file
(`Date | X handle | Text (PT) | Post link`), either **since the last export** or for a
**date range**. The Feed has a "Money/business only" toggle.

On `docker compose up`, the bundled `ollama-pull` one-shot service downloads the model
automatically into a named volume (cached across restarts; first pull of `gemma3:4b` is
~3 GB). The app starts immediately and begins classifying once the model finishes
downloading — no manual step. To pull a different model later, or to pull by hand:

```bash
docker compose exec ollama ollama pull gemma3:4b
```

Ollama runs on CPU by default (fine for `gemma3:4b`); for GPU, see the Ollama Docker docs.
To turn AI off entirely, set `AI_PROVIDER=none` — posts are collected but not classified or
translated, and exports will be empty.

## Development

```bash
npm install
npm run dev --workspace @x-osint/api    # api on :8080
npm run dev --workspace @x-osint/www    # vite dev server, proxies /api
npm test --workspace @x-osint/api
```
