# Partner + SQLite + Ark (minimal stack)

One **`docker compose`** brings up:

1. **`partner`** — FastAPI app on port **9000** (internal only) with **SQLite** at `/data/partner.db` (named volume). Implements [PARTNER_API.md](../../docs/PARTNER_API.md): sheet payloads at **`GET /ark/routing/clients`** and **`…/records`**, and **`POST /ark/tunnel`** to persist cell edits (`update_cell` mapped by BFF from WebSocket commits).
2. **`ark`** — This repository’s image: static UI, **`ARK_BACKEND_URL=http://partner:9000`**, exposed on **http://localhost:8000**.

## Run

```bash
cd examples/partner-sqlite-demo
docker compose up --build
```

Open **http://localhost:8000/clients** or **http://localhost:8000/records** (each URL is its own spreadsheet; **`/`** alone does not load a sheet). Use normal links or the URL bar to move between them; edit a **Name** or **Client** cell. Reload — values should still come from SQLite.

The Ark image defaults to **`ARK_UI_ROUTES=clients,records`** so those paths serve the SPA. Override if your partner uses different routing suffixes.

## Local (no Docker) equivalent

Terminal A — partner:

```bash
cd examples/partner-sqlite-demo/partner
pip install -r requirements.txt
PARTNER_DB=./partner.db uvicorn main:app --port 9000
```

Terminal B — Ark (from repo root):

```bash
npm run build
ARK_BACKEND_URL=http://127.0.0.1:9000 uvicorn app.main:app --reload --app-dir server --port 8000
```

Open **http://127.0.0.1:8000/clients** (or **`/records`**), with **`ARK_UI_ROUTES=clients,records`** on the Ark server.

## Notes

- Row **1** in the grid is the first data row; tunnel handler maps that to the first `ORDER BY id` row in the matching table.
- **`id`** columns are read-only in the sheet payload; only **`name`** / **`client_id`** are updated through the tunnel.
- This is a teaching stack, not production hardening (no auth, single-file DB, simple error handling).
