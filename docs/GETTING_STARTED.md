# Getting started (new to this repo)

This guide assumes you are new to Ark and maybe new to Node or Docker. Follow the steps in order; skip sections you do not need yet.

## 1. What you are setting up

Ark is a **web app** you run on your computer for development. **By default** it expects a **partner API** behind the Ark BFF: the **first URL path segment** selects the sheet (`GET /ark/routing/{segment}`), and the UI opens a **WebSocket** for collab/tunnel. There is **no bootstrap** and **no partner-mode tabs**—each URL is one spreadsheet. If you are building that API, start with **[WRITING_A_PARTNER.md](WRITING_A_PARTNER.md)**; the full contract is **[PARTNER_API.md](PARTNER_API.md)**.

To try the UI **without** a partner, open the app with **`?demo=1`** (offline “Product Roadmap” presets and fake in-memory data).

## 2. Install prerequisites

### Node.js (required for local development)

Node includes **`npm`** (the tool that installs project libraries and runs scripts).

1. Download the **LTS** version from [https://nodejs.org](https://nodejs.org) and install it.
2. Open a terminal (Terminal on macOS, PowerShell or Command Prompt on Windows).
3. Check that it worked:

```bash
node -v
npm -v
```

You should see version numbers (Node **20** or newer is ideal). If the command is “not found,” restart the terminal or your computer after installing.

### Python 3.12+ (for the bundled server in dev)

The repo ships a small **FastAPI** app under [`server/`](https://github.com/valteryde/ark/tree/main/server) that serves the built UI, proxies `GET /api/ark/routing/*` to your partner API, and exposes **`/ws/ark`** for collaboration. To run it locally:

```bash
python3 -V
pip install -r server/requirements.txt
```

Use a virtual environment if you prefer (`python3 -m venv .venv` then `source .venv/bin/activate`).

### Git (recommended)

If you will **clone** the repository from GitHub:

- Install Git from [https://git-scm.com](https://git-scm.com) (or use GitHub Desktop, which includes Git).

If you downloaded the project as a **ZIP** from GitHub and unzipped it, you can skip Git for now.

### Docker (optional)

Only needed if you want to run the app in a **container**. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux) and confirm:

```bash
docker --version
docker compose version
```

## 3. Get the project on your machine

**Option A — Git clone** (stays linked to GitHub):

```bash
cd ~/projects   # or any folder where you keep code
git clone <your-repo-url>
cd ark          # folder name may be different, e.g. ark/ark
```

**Option B — ZIP download**: On GitHub, use **Code → Download ZIP**, unzip, then `cd` into the folder that contains `package.json`.

Always run the next commands from the directory that has **`package.json`** at the top level.

## 4. Install dependencies

Dependencies are the libraries listed in `package.json`. Install them once (or after pulling big changes):

```bash
npm install
```

This creates a **`node_modules`** folder. That folder can be large; do not commit it (it is already ignored by Git).

**If `npm install` fails**: Delete `node_modules` and try again:

```bash
rm -rf node_modules
npm install
```

On Windows PowerShell you can use `Remove-Item -Recurse -Force node_modules`.

## 5. Run the app in development mode

The frontend is bundled with **esbuild** into **`dist/`**. There is no separate Vite dev server: you rebuild on change and refresh the browser (or use watch).

**Terminal 1** — watch and rebuild:

```bash
npm run dev
```

**Terminal 2** — serve UI + API from Python (from the repo root):

```bash
uvicorn app.main:app --reload --app-dir server --port "${PORT:-8000}"
```

Open a sheet URL such as [http://127.0.0.1:8000/clients](http://127.0.0.1:8000/clients) for **partner mode** (with **`ARK_UI_ROUTES`** and a matching partner route), or [http://127.0.0.1:8000/?demo=1](http://127.0.0.1:8000/?demo=1) for **demo presets**.

- **Partner mode**: Set **`ARK_BACKEND_URL`** (e.g. `http://127.0.0.1:9000`) and run your partner service (try [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py) with `uvicorn example_api:app --port 9000`).
- **Rebuild on save**: `npm run dev` keeps `dist/` up to date; refresh the page after edits under `src/`.
- **Stop**: Press **Ctrl+C** in each terminal.

**Port 8000 already in use**: Set **`PORT`** (e.g. `PORT=8001`) or pass a different **`--port`** to uvicorn.

Optional: copy [`.env.example`](https://github.com/valteryde/ark/blob/main/.env.example) to `.env` and set **`ARK_BACKEND_URL`** so `GET /api/ark/routing/...` proxies to your partner API.

## 6. What you should see

- **Partner mode**: Header title from the sheet payload’s **`title`** when present; one grid per URL; edits go over **`/ws/ark`** and **`POST /ark/tunnel`** on the partner.
- **`?demo=1`**: Header **Product Roadmap 2026**, tabs **Quarterly plan / Backlog / Archive**, in-memory sample data.

Cells are editable where columns are not `readOnly`; undo/redo and the formatting toolbar follow **[SPREADSHEET.md](SPREADSHEET.md)** and each sheet’s `enabledUiCapabilities`.

## 7. Build for production (static files)

To generate the files the Python server (or any static host) can serve:

```bash
npm run build
```

Output goes to the **`dist/`** folder. To try it with the same server you use in dev:

```bash
uvicorn app.main:app --app-dir server --port "${PORT:-8000}"
```

## 8. Run with Docker (optional)

From the same folder as `docker-compose.yml`:

```bash
docker compose up --build
```

Then open [http://localhost:8000](http://localhost:8000) (or your **`PORT`**). The image runs **FastAPI + uvicorn** and serves **`dist/`** from the build stage; **`PORT`** defaults to **8000**.

Set **`ARK_BACKEND_URL`** in `docker-compose.yml` (or your orchestrator) to enable routing proxy and tunnel `POST` to your partner API.

## 9. Use images from GitHub Container Registry (optional)

If your team publishes images on push to `main`, you can pull instead of building:

1. [Log in to `ghcr.io`](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry) with a Personal Access Token that has **`read:packages`**, or use `GITHUB_TOKEN` in CI.
2. Pull and run (replace `OWNER` and `REPO` with your GitHub owner and repository name, **lowercase**):

```bash
docker pull ghcr.io/OWNER/REPO:latest
docker run --rm -p 8000:8000 -e ARK_BACKEND_URL= ghcr.io/OWNER/REPO:latest
```

Open [http://localhost:8000](http://localhost:8000). Use **`-e PORT=…`** and **`-p host:PORT`** together if you change the listen port.

## 10. Hooking up your own backend (next step)

1. Read **[WRITING_A_PARTNER.md](WRITING_A_PARTNER.md)** — step-by-step partner implementation.
2. Read **[PARTNER_API.md](PARTNER_API.md)** — URL → sheet route, sheet JSON, tunnel, and WebSocket events.
3. Read **[SPREADSHEET.md](SPREADSHEET.md)** — column config, undo, value types, toolbar capabilities.
4. **BFF**: **`GET /api/ark/routing/{path}`** → **`{ARK_BACKEND_URL}/ark/routing/{path}`**; **`WebSocket /ws/ark`** → broadcast + **`POST …/ark/tunnel`**; optional **`POST /api/ark/broadcast`** ( **`ARK_BROADCAST_TOKEN`** ) for partner-pushed **`sheet.truth`**. Sample: [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py).
5. **Production**: Run the Docker image or `uvicorn` behind your reverse proxy; set **`ARK_BACKEND_URL`**.

Entry points: partner wiring in [`src/main.ts`](https://github.com/valteryde/ark/blob/main/src/main.ts) and [`src/partner/`](https://github.com/valteryde/ark/tree/main/src/partner); reusable grid API under **`src/spreadsheet/`** ([`src/spreadsheet/index.ts`](https://github.com/valteryde/ark/blob/main/src/spreadsheet/index.ts)).

## 11. Using Deno instead of typing `npm run …`

If you use [Deno](https://deno.com), this repo includes [`deno.json`](https://github.com/valteryde/ark/blob/main/deno.json):

```bash
deno task dev
deno task build
```

You still need Node/npm installed because those tasks call through to npm scripts.

## 12. Quick reference

| Goal | Command |
|------|---------|
| Install Node deps | `npm install` |
| Watch rebuild → `dist/` | `npm run dev` |
| Production JS/CSS build | `npm run build` |
| Local server (UI + `/api` + `/ws/ark`) | `uvicorn app.main:app --reload --app-dir server --port "${PORT:-8000}"` |
| Demo UI without partner | Open `http://127.0.0.1:8000/?demo=1` |
| Docker Compose | `docker compose up --build` |

## 13. Where to read next

| Document | Purpose |
|----------|---------|
| [README.md](https://github.com/valteryde/ark/blob/main/README.md) | Overview, Docker details, CI, embedding |
| [WRITING_A_PARTNER.md](WRITING_A_PARTNER.md) | How to implement the partner API |
| [PARTNER_API.md](PARTNER_API.md) | Bootstrap, sheet payload, tunnel, WS |
| [SPREADSHEET.md](SPREADSHEET.md) | Grid contract, types, undo, column value types |

If something in this guide is unclear or wrong for your OS, open an issue or fix the doc in a pull request.
