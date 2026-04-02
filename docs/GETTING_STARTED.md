# Getting started (new to this repo)

This guide assumes you are new to Ark and maybe new to Node or Docker. Follow the steps in order; skip sections you do not need yet.

## 1. What you are setting up

Ark is a **web app** you run on your computer for development. It shows a **demo spreadsheet** (roadmap-style tabs) in the browser. The demo uses **fake in-memory data** until you wire your own backend.

You do **not** need a database or API server just to see the UI work.

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

### Git (recommended)

If you will **clone** the repository from GitHub:

- Install Git from [https://git-scm.com](https://git-scm.com) (or use GitHub Desktop, which includes Git).

If you downloaded the project as a **ZIP** from GitHub and unzipped it, you can skip Git for now.

### Docker (optional)

Only needed if you want to run the app in a **container** instead of `npm run dev`. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux) and confirm:

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

```bash
npm run dev
```

You should see text like `Local: http://localhost:3000/`. Open that URL in Chrome, Firefox, or Edge.

- **Hot reload**: Saving a file under `src/` usually refreshes the page automatically.
- **Stop the server**: In the terminal, press **Ctrl+C**.

**Port 3000 already in use**: Another app is using that port. Either stop that app or change the port in [`vite.config.ts`](../vite.config.ts) under `server.port`, then run `npm run dev` again.

## 6. What you should see

- A header with **Product Roadmap 2026** and a formatting toolbar.
- Tabs: **Quarterly plan**, **Backlog**, **Archive** (switching tabs reloads sample data).
- Cells you can click and edit; undo/redo from the toolbar or keyboard.

This is the **demo shell**. Your real product will replace demo data with a **`SpreadsheetDataStore`** that talks to your API (see below).

## 7. Build for production (static files)

To generate the files you would deploy to a server or CDN:

```bash
npm run build
```

Output goes to the **`dist/`** folder. To preview that build locally:

```bash
npm run serve
```

Then open the URL Vite prints (often `http://localhost:4173`).

## 8. Run with Docker (optional)

From the same folder as `docker-compose.yml`:

```bash
docker compose up --build
```

Then open [http://localhost:8080](http://localhost:8080). That serves the **static** nginx image (no API proxy inside the container).

For the **gateway** image (UI + proxy to your API), see [README.md](../README.md) and the **gateway** profile. Set **`BACKEND_URL`** to wherever your API listens.

## 9. Use images from GitHub Container Registry (optional)

If your team publishes images on push to `main`, you can pull instead of building:

1. [Log in to `ghcr.io`](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry) (GitHub’s container registry) with a Personal Access Token that has **`read:packages`**, or use `GITHUB_TOKEN` in CI.
2. Pull and run (replace `OWNER` and `REPO` with your GitHub owner and repository name, **lowercase**):

```bash
docker pull ghcr.io/OWNER/REPO:latest
docker run --rm -p 8080:80 ghcr.io/OWNER/REPO:latest
```

Open [http://localhost:8080](http://localhost:8080).

## 10. Hooking up your own backend (next step)

Ark does **not** include a REST server. When you are ready:

1. Read **[SPREADSHEET.md](SPREADSHEET.md)** — column config, data store interface, and security notes.
2. **Local dev**: Uncomment and adjust **`server.proxy`** in [`vite.config.ts`](../vite.config.ts) so browser calls to `/api` (or `/ws`) go to your server.
3. **Production**: Either put `dist/` behind your reverse proxy, or use the **Node gateway** ([`gateway/server.mjs`](../gateway/server.mjs)) and set **`BACKEND_URL`**.

Entry points in code: [`src/main.ts`](../src/main.ts) mounts the demo; spreadsheet API lives under **`src/spreadsheet/`** (see [`src/spreadsheet/index.ts`](../src/spreadsheet/index.ts)).

## 11. Using Deno instead of typing `npm run …`

If you use [Deno](https://deno.com), this repo includes [`deno.json`](../deno.json):

```bash
deno task dev
deno task build
```

You still need Node/npm installed because those tasks call through to npm scripts.

## 12. Quick reference

| Goal | Command |
|------|---------|
| Install deps | `npm install` |
| Dev server + hot reload | `npm run dev` |
| Production build | `npm run build` |
| Preview `dist/` | `npm run serve` |
| Local gateway (after build) | `npm run gateway` |
| Docker Compose (static) | `docker compose up --build` |

## 13. Where to read next

| Document | Purpose |
|----------|---------|
| [README.md](../README.md) | Overview, Docker details, CI, embedding modes |
| [SPREADSHEET.md](SPREADSHEET.md) | Backend contract, types, undo, column value types |

If something in this guide is unclear or wrong for your OS, open an issue or fix the doc in a pull request.
