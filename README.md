# x-osint

Self-hosted collector for X/Twitter accounts. Pulls posts from a watchlist via Nitter RSS
(no X API, no login), stores them in SQLite, and serves a web reader + JSON API.

## Run with Docker (one command)

```bash
docker run -p 8080:8080 -v x-data:/data -e X_OSINT_PASSWORD=yourpassword x-osint
```

Or with compose:

```bash
X_OSINT_PASSWORD=yourpassword docker compose up -d --build
```

Open http://localhost:8080, log in with your password, add accounts on the **Accounts**
page, and watch posts appear on the **Feed**.

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
