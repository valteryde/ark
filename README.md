# Ark

Configurable spreadsheet UI for **API-driven** row/column data: a demo “Product Roadmap” shell plus an embeddable grid you mount with `mountSpreadsheet`. Vite builds static assets; **your backend owns routes, auth, and persistence**—see [docs/SPREADSHEET.md](docs/SPREADSHEET.md) for the config contract and TypeScript entrypoints (`src/spreadsheet/index.ts`).

## Requirements

- Node.js 20+ (for `npm` / local dev and Docker build stages)

## Local development

```bash
npm install
npm run dev
```

Opens the Vite dev server at [http://localhost:3000](http://localhost:3000).

### Deno task aliases

If you use Deno, `deno task dev` / `deno task build` forward to the same npm scripts ([deno.json](deno.json)).

### Proxying your API in dev

Vite does not implement your HTTP API. Point the dev server at your backend with `server.proxy` in [vite.config.ts](vite.config.ts) (commented example for `/api` and `/ws`).

## Production build

```bash
npm run build
```

Output: `dist/`. Preview locally with `npm run serve`.

## Embedding and “your own router”

- **Static hosting**: Deploy `dist/` behind nginx, Caddy, Kubernetes ingress, or any app server. Your service handles `/api/*` (and optional WebSockets) on the same host or another origin (configure CORS if split).
- **Vite dev**: UI on port 3000; backend on its own port; use `server.proxy` so the browser talks same-origin.
- **Node gateway** (Docker-friendly): One process serves `dist/` and reverse-proxies `/api` and `/ws` to `BACKEND_URL`—see [gateway/server.mjs](gateway/server.mjs). Useful when the browser should only see one origin and a future collab service lives on an internal network.

After `npm run build`, run `npm run gateway` (default **8080**). Use `PORT=4174 npm run gateway` if that port is busy.

## Docker

**Static image** (nginx + `dist/`):

```bash
docker build -t ark:web .
docker run --rm -p 8080:80 ark:web
```

**Gateway image** (static UI + proxy to your API):

```bash
docker build -f Dockerfile.gateway -t ark:gateway .
docker run --rm -p 4174:8080 -e BACKEND_URL=http://host.docker.internal:3000 ark:gateway
```

On Linux, `host.docker.internal` may require `extra_hosts`; prefer a Compose service name (e.g. `http://api:3000`) on a shared network.

**Compose** (default: static on 8080):

```bash
docker compose up --build
```

Optional gateway profile:

```bash
docker compose --profile gateway up --build
```

## Public API (TypeScript)

Import from `./spreadsheet` or paths under `src/spreadsheet/`:

- `mountSpreadsheet`, `mountFormattingToolbar`
- `createInMemoryDataStore`, types (`SpreadsheetConfig`, `SpreadsheetDataStore`, …)
- Example presets: `createRoadmapPreset`, etc. (demos only—build real configs from your API JSON)

## Manual smoke check

- Switch sheet tabs (Quarterly / Backlog / Archive).
- Edit a cell, undo/redo (keyboard or toolbar).
- Formatting toolbar: bold, fill, borders, alignment, link (prompt).

## License

MIT — see [LICENSE](LICENSE).
