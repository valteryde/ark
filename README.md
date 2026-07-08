# Ark

Spreadsheet with a **document-owning backend**. Each URL path (e.g. **`/clients`** or **`/clients/21`**) loads **one** sheet via **`GET /api/sheets/{path}`**; unknown sheets are **auto-created** (from the partner's `GET /ark/template/{path}` response — versioned, pulled live at creation — else blank). Edits go over **`WebSocket /ws/ark`**, are persisted in Ark's own SQLite document store, broadcast to peers, and forwarded to your partner app as live coalesced **`sheet.changed`** notifications. Partners read/write full sheets through the **CRUD API** under **`/api/partner/…`**. The UI is bundled with **esbuild** into `dist/`; a **FastAPI** app in [`server/`](server/) serves `dist/`, **`/api/*`**, and **`/ws/ark`**.

**Integrating a partner app:** **[docs/WRITING_A_PARTNER.md](docs/WRITING_A_PARTNER.md)**. Full contract: **[docs/PARTNER_API.md](docs/PARTNER_API.md)**. Sample partner: [`example_api.py`](example_api.py).

**Documentation site** (GitHub Pages): after you enable **Settings → Pages → GitHub Actions** in this repo, the built docs publish at **https://valteryde.github.io/ark/** (see [.github/workflows/pages.yml](.github/workflows/pages.yml)).

**New here?** Follow **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** for Node, Python, first run, build, Docker, and backend wiring.

## Requirements

- **Node.js 20+** — `npm install`, `npm run build`, Docker frontend stage
- **Python 3.12+** — optional locally; included in the Docker image for `uvicorn`

## Local development

Two terminals from the repo root (directory with `package.json`):

```bash
npm install
npm run dev
```

```bash
pip install -r server/requirements.txt
uvicorn app.main:app --reload --app-dir server --port "${PORT:-8000}"
```

Open a sheet URL such as [http://127.0.0.1:8000/clients](http://127.0.0.1:8000/clients) (use your **`PORT`** if set); the sheet is auto-created and persisted in **`ARK_DB_PATH`** (default `./ark.db`). **`ARK_UI_ROUTES`** must include that segment. The site root **`/`** shows an error until you use a configured path. Use **`?demo=1`** for offline presets.

`npm run dev` runs **esbuild in watch mode** and refreshes `dist/`; reload the browser after edits under `src/`.

Optional: copy [`.env.example`](.env.example) to `.env` and set **`ARK_PARTNER_BASE_URL`** / **`ARK_PARTNER_API_TOKEN`** to wire up a partner app.

### Deno task aliases

If you use Deno, `deno task dev` / `deno task build` forward to the same npm scripts ([`deno.json`](deno.json)).

## Production build

```bash
npm run build
```

Output: **`dist/`** (HTML, `assets/main.js`, `assets/main.css`, favicon). Serve with the FastAPI app or any static host.

## Embedding and backends

- **Document backend** (default): Run `uvicorn` (or Docker). The browser loads sheets from **`GET /api/sheets/{path}`** and edits over **`WebSocket /ws/ark`**; Ark persists everything in **`ARK_DB_PATH`**. Set **`ARK_PARTNER_BASE_URL`** so Ark verifies user tokens (`GET /ark/auth`) and sends live **`sheet.changed`** notifications (`POST /ark/notify`); set **`ARK_PARTNER_API_TOKEN`** so your backend can use the CRUD API under **`/api/partner/…`** (see **[docs/PARTNER_API.md](docs/PARTNER_API.md)**).
- **Static only**: Deploy `dist/` behind any reverse proxy if you do not need this repo’s Python routes (demo mode only — no persistence without the backend).

Embedders can still use **`mountSpreadsheet`** from TypeScript in their own apps; this repo’s default page is partner-first.

### Embedding Ark in an iframe (another domain)

If the parent app is on **one origin** and Ark on another (for example **`https://example.com`** embedding **`https://ark.example.com/clients`**), configure framing on the **Ark** host via `.env` or container env:

- **`ARK_IFRAME_FRAME_ANCESTORS`** — space-separated allowed **parent** origins (the CSP `frame-ancestors` sources only). Example: `ARK_IFRAME_FRAME_ANCESTORS=https://example.com`. Use **`https://www.example.com`** as well if users load the parent under both hostnames.
- **`ARK_IFRAME_X_FRAME_OPTIONS`** — optional `DENY` or `SAMEORIGIN`. Leave unset for cross-site embeds: **`SAMEORIGIN`** only allows framing from Ark’s own origin, so it blocks **`example.com`** embedding **`ark.example.com`**.

See **[docs/PARTNER_API.md](docs/PARTNER_API.md#framing-iframe-embedding)** and [`.env.example`](.env.example).

## Docker

Single image (esbuild build + FastAPI):

```bash
docker build -t ark:app .
docker run --rm -p 8000:8000 -v ark_sqlite:/data -e ARK_DB_PATH=/data/ark.db ark:app
```

The image listens on **`PORT`** (default **8000**); map the host port to the same value, e.g. `-e PORT=8080 -p 8080:8080`.

**Compose** (default **`PORT=8000`**; override with **`PORT`** in the environment or `.env`):

```bash
docker compose up --build
```

**Full mini stack** (Ark document backend + SQLite partner in Compose): [examples/partner-sqlite-demo](examples/partner-sqlite-demo/README.md). The partner seeds **`/clients`** and **`/records`** and syncs edits into its own SQLite via `sheet.changed` notifications (see **`ARK_UI_ROUTES`** in [`.env.example`](.env.example)).

### CI: GitHub Container Registry

Images are pushed to **GitHub Container Registry** ([`ghcr.io`](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry)). The workflow uses only `GITHUB_TOKEN`.

On every push to **`main`**, [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) publishes:

| Tag | Image |
|-----|--------|
| `latest` | Monolith (`Dockerfile`) |
| `sha-<short>` | Same commit digest |

Pull example (replace `OWNER/REPO` with your GitHub `owner/repo`, lowercase):

```bash
docker pull ghcr.io/OWNER/REPO:latest
```

Ensure the repository **Actions** workflow permissions allow **read and write** for packages if publishing fails.

## Public API (TypeScript)

Import from `./spreadsheet` or paths under `src/spreadsheet/`:

- `mountSpreadsheet`, `mountFormattingToolbar`
- `createInMemoryDataStore`, types (`SpreadsheetConfig`, `SpreadsheetDataStore`, …)
- Example presets: `createRoadmapPreset`, etc. (demos only—build real configs from your API JSON)

## Testing

Two suites cover the pure logic on each side of the app.

**Frontend (TypeScript)** — [Deno](https://deno.com)'s built-in runner. Tests live in [`tests/`](tests/): pure-logic units under `tests/spreadsheet/` and `tests/partner/`, plus DOM-level tests for the grid and toolbar under `tests/dom/` (mounted in [jsdom](https://github.com/jsdom/jsdom), auto-installed on first run).

```bash
deno task test          # or: npm test
deno task test:watch    # or: npm run test:watch
```

**Backend (Python)** — [pytest](https://docs.pytest.org). Tests live in [`server/tests/`](server/tests/):

```bash
pip install -r server/requirements-dev.txt
cd server && pytest
```

## Manual smoke check

- **Partner mode**: Run [`example_api.py`](example_api.py) on port 9000, set `ARK_PARTNER_BASE_URL=http://127.0.0.1:9000` and a shared `ARK_PARTNER_API_TOKEN` on both, open **`/clients`** or **`/records`**, edit cells, confirm `sheet.changed` notifications in the partner logs.
- **Demo mode** (`?demo=1`): Quarterly / Backlog / Archive tabs, undo/redo, formatting toolbar (bold, fill, borders, alignment, link prompt).

## License

MIT — see [LICENSE](LICENSE).
