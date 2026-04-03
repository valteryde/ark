# Ark

Configurable spreadsheet UI for **API-driven** row/column data. **Default behavior:** each URL path (e.g. **`/clients`**) loads **one** sheet via **`GET /api/ark/routing/{segment}`** (proxied to your partner). There is **no bootstrap** and **no in-app sheet tabs** in partner mode—only the offline **`?demo=1`** presets use tabs. The UI uses **`WebSocket /ws/ark`** for collab + tunnel persistence. The UI is bundled with **esbuild** into `dist/`; a **FastAPI** app in [`server/`](server/) serves `dist/`, **`/api/*`**, and **`/ws/ark`** when **`ARK_BACKEND_URL`** is set.

Partner contract: **[docs/PARTNER_API.md](docs/PARTNER_API.md)**. Sample backend: [`example_api.py`](example_api.py).

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
uvicorn app.main:app --reload --app-dir server --port 8000
```

Open a sheet URL such as [http://127.0.0.1:8000/clients](http://127.0.0.1:8000/clients) when **`ARK_BACKEND_URL`** points at your partner and **`ARK_UI_ROUTES`** includes that segment. The site root **`/`** shows an error until you use a configured path. Use **`?demo=1`** for offline presets.

`npm run dev` runs **esbuild in watch mode** and refreshes `dist/`; reload the browser after edits under `src/`.

Optional: copy [`.env.example`](.env.example) to `.env` and set **`ARK_BACKEND_URL`** (no trailing slash).

### Deno task aliases

If you use Deno, `deno task dev` / `deno task build` forward to the same npm scripts ([`deno.json`](deno.json)).

## Production build

```bash
npm run build
```

Output: **`dist/`** (HTML, `assets/main.js`, `assets/main.css`, favicon). Serve with the FastAPI app or any static host.

## Embedding and backends

- **Same-origin BFF**: Run `uvicorn` (or Docker). The browser uses **`GET /api/ark/routing/{path}`** (proxied to `{ARK_BACKEND_URL}/ark/routing/{path}`) and can use **`WebSocket /ws/ark`** for collaboration; the server **`POST`s** mapped events to **`{ARK_BACKEND_URL}/ark/tunnel`**.
- **Static only**: Deploy `dist/` behind any reverse proxy if you do not need this repo’s Python routes.

Embedders can still use **`mountSpreadsheet`** from TypeScript in their own apps; this repo’s default page is partner-first.

## Docker

Single image (esbuild build + FastAPI):

```bash
docker build -t ark:app .
docker run --rm -p 8000:8000 -e ARK_BACKEND_URL= ark:app
```

**Compose** (default port **8000**):

```bash
docker compose up --build
```

**Full mini stack** (Ark + SQLite partner API in Compose): [examples/partner-sqlite-demo](examples/partner-sqlite-demo/README.md). Partner routes **`clients`** / **`records`** match **`/clients`** and **`/records`** (see **`ARK_UI_ROUTES`** in [`.env.example`](.env.example)).

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

## Manual smoke check

- **Partner mode**: Run [`example_api.py`](example_api.py) on port 9000, set `ARK_BACKEND_URL=http://127.0.0.1:9000`, open **`/clients`** or **`/records`**, edit cells, confirm tunnel hits (see server logs).
- **Demo mode** (`?demo=1`): Quarterly / Backlog / Archive tabs, undo/redo, formatting toolbar (bold, fill, borders, alignment, link prompt).

## License

MIT — see [LICENSE](LICENSE).
