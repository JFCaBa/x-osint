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

## API

All `/api/*` routes except `/api/login` and `/api/health` need `Authorization: Bearer <token>`
(get the token from `POST /api/login {"password":"..."}`).

- `GET /api/posts?handle=&q=&since=&limit=` — collected posts, newest first
- `GET /api/accounts`, `POST /api/accounts {handle}`, `PATCH /api/accounts/:handle {enabled}`, `DELETE /api/accounts/:handle`
- `POST /api/fetch` — trigger an immediate poll

## Development

```bash
npm install
npm run dev --workspace @x-osint/api    # api on :8080
npm run dev --workspace @x-osint/www    # vite dev server, proxies /api
npm test --workspace @x-osint/api
```
